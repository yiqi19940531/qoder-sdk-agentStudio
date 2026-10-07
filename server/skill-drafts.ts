import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { query, qodercliAuth } from '@qoder-ai/qoder-agent-sdk';
import YAML from 'yaml';
import yauzl from 'yauzl';
import type { SkillDraftRecord, SkillTreeEntry, SkillValidationIssue } from '../shared/types.js';
import { dataRoot, fixtureRoot } from './storage.js';
import { clearDiscoveryCache } from './runtime.js';
import { refreshConfigCatalog } from './config-catalog.js';
import { parseSkill, skillPath, skillRoot } from './skills.js';

const draftsRoot = path.join(dataRoot, 'skill-drafts');
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maxFile = 10 * 1024 * 1024;
const maxExpanded = 50 * 1024 * 1024;
const maxArchive = 20 * 1024 * 1024;
const maxEntries = 200;
const mutations = new Map<string, Promise<void>>();
export async function withDraftMutation<T>(id: string, action: () => Promise<T>): Promise<T> {
  const previous = mutations.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  mutations.set(id, current);
  await previous;
  try { return await action(); }
  finally { release(); if (mutations.get(id) === current) mutations.delete(id); }
}
type Meta = Omit<SkillDraftRecord, 'files'> & { baseRevision?: string; archiveRoot?: string };
export class SkillDraftError extends Error { constructor(message: string, public status = 400) { super(message); } }
function draftDir(id: string) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new SkillDraftError('无效的草稿 ID'); return path.join(draftsRoot, id); }
function draftFiles(id: string) { return path.join(draftDir(id), 'files'); }
function metaFile(id: string) { return path.join(draftDir(id), 'meta.json'); }
function safePath(value: string): string {
  if (!value || value.startsWith('/') || value.includes('\\') || /[\x00-\x1f]/.test(value) || /^[a-z]:/i.test(value)) throw new SkillDraftError('无效的文件路径');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new SkillDraftError('无效的文件路径');
  return parts.join('/');
}
function absolute(root: string, relative: string) { return path.join(root, safePath(relative)); }
async function meta(id: string): Promise<Meta> {
  try { const value = JSON.parse(await readFile(metaFile(id), 'utf8')) as Meta; value.version ??= 0; return value; }
  catch { throw new SkillDraftError('Skill 草稿不存在', 404); }
}
async function saveMeta(value: Meta) { value.version += 1; value.updatedAt = new Date().toISOString(); await writeFile(metaFile(value.id), JSON.stringify(value, null, 2)); }
async function checkVersion(id: string, expected?: number) {
  if (expected !== undefined && (await meta(id)).version !== expected) throw new SkillDraftError('草稿已在其他位置修改，请重新载入后再编辑', 409);
}
async function walk(root: string): Promise<SkillTreeEntry[]> {
  const result: SkillTreeEntry[] = [];
  async function visit(dir: string, prefix: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      safePath(relative);
      const info = await lstat(path.join(dir, entry.name));
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new SkillDraftError(`不允许链接或特殊文件：${relative}`);
      if (info.isDirectory()) { result.push({ path: relative, kind: 'directory', size: 0, text: false }); await visit(path.join(dir, entry.name), relative); }
      else {
        const buffer = await readFile(path.join(dir, entry.name));
        let text = false;
        try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); text = !buffer.includes(0); } catch { /* binary */ }
        result.push({ path: relative, kind: 'file', size: info.size, text });
      }
    }
  }
  await visit(root, '');
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
async function revision(root: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of await walk(root)) {
    hash.update(entry.kind); hash.update('\0'); hash.update(entry.path); hash.update('\0');
    if (entry.kind === 'file') hash.update(await readFile(path.join(root, entry.path)));
  }
  return hash.digest('hex');
}
export async function getDraft(id: string): Promise<SkillDraftRecord> { const value = await meta(id); return { ...value, files: await walk(draftFiles(id)) }; }
export async function listDrafts(): Promise<SkillDraftRecord[]> {
  await mkdir(draftsRoot, { recursive: true });
  const ids = await readdir(draftsRoot);
  const drafts = await Promise.all(ids.filter((id) => /^[a-f0-9-]{36}$/.test(id)).map((id) => getDraft(id).catch(() => null)));
  return drafts.filter((item): item is SkillDraftRecord => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function makeDraft(origin: Meta['origin'], sourceSlug?: string): Promise<Meta> {
  const id = randomUUID(); const now = new Date().toISOString();
  await mkdir(draftFiles(id), { recursive: true });
  const value: Meta = { id, version: 0, origin, sourceSlug, slug: sourceSlug, createdAt: now, updatedAt: now };
  await saveMeta(value); return value;
}
export async function createDraft(input: { mode: 'new' | 'edit'; slug?: string; description?: string; body?: string }): Promise<SkillDraftRecord> {
  if (input.mode === 'edit') {
    const slug = input.slug ?? '';
    if (!slugPattern.test(slug) || slug.length > 64) throw new SkillDraftError('无效的 Skill 名称');
    const source = path.dirname(skillPath(slug));
    if (!(await stat(source).catch(() => null))?.isDirectory()) throw new SkillDraftError('Skill 不存在', 404);
    const value = await makeDraft('edit', slug);
    try { await cp(source, draftFiles(value.id), { recursive: true, force: false }); value.baseRevision = await revision(source); await saveMeta(value); return getDraft(value.id); }
    catch (error) { await rm(draftDir(value.id), { recursive: true, force: true }); throw error; }
  }
  const content = input.slug ? `---\n${YAML.stringify({ name: input.slug, description: input.description ?? '' })}---\n\n${input.body ?? ''}\n` : undefined;
  const value = await makeDraft('new');
  if (input.slug) {
    value.slug = input.slug;
    await writeFile(path.join(draftFiles(value.id), 'SKILL.md'), content!);
    await saveMeta(value);
  }
  return getDraft(value.id);
}
export async function importMarkdown(buffer: Buffer): Promise<SkillDraftRecord> {
  if (buffer.length > maxFile) throw new SkillDraftError('SKILL.md 超过 10 MiB', 413);
  const value = await makeDraft('markdown');
  await writeFile(path.join(draftFiles(value.id), 'SKILL.md'), buffer);
  return getDraft(value.id);
}
type ZipItem = { path: string; isDir: boolean; content?: Buffer };
async function extractZip(buffer: Buffer): Promise<ZipItem[]> {
  if (buffer.length > maxArchive) throw new SkillDraftError('ZIP 超过 20 MiB', 413);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, file) => error || !file ? reject(new SkillDraftError(`ZIP 无法读取：${error?.message ?? '无效文件'}`)) : resolve(file)));
  const items: ZipItem[] = []; const seen = new Set<string>(); let total = 0;
  try {
    return await new Promise<ZipItem[]>((resolve, reject) => {
      zip.on('error', (error) => reject(new SkillDraftError(`ZIP 格式错误：${error.message}`)));
      zip.on('end', () => resolve(items));
      zip.on('entry', async (entry: yauzl.Entry) => {
        try {
          if (items.length >= maxEntries) throw new SkillDraftError('ZIP 条目超过 200 个', 413);
          const isDir = entry.fileName.endsWith('/');
          const entryPath = safePath(isDir ? entry.fileName.slice(0, -1) : entry.fileName);
          const normalized = entryPath.toLowerCase();
          if (seen.has(normalized)) throw new SkillDraftError(`ZIP 有重复路径：${entryPath}`);
          seen.add(normalized);
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode && mode !== 0x8000 && mode !== 0x4000) throw new SkillDraftError(`ZIP 包含链接或特殊文件：${entryPath}`);
          if (mode && (isDir ? mode !== 0x4000 : mode !== 0x8000)) throw new SkillDraftError(`ZIP 文件类型与路径不符：${entryPath}`);
          if ((entry.generalPurposeBitFlag & 1) !== 0) throw new SkillDraftError('不支持加密 ZIP');
          if (entry.uncompressedSize > maxFile && !isDir) throw new SkillDraftError(`文件超过 10 MiB：${entryPath}`, 413);
          if (!isDir && entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200) throw new SkillDraftError(`ZIP 压缩比异常：${entryPath}`, 413);
          total += entry.uncompressedSize;
          if (total > maxExpanded) throw new SkillDraftError('ZIP 解压总量超过 50 MiB', 413);
          if (isDir) { items.push({ path: entryPath, isDir }); zip.readEntry(); return; }
          const stream = await new Promise<NodeJS.ReadableStream>((done, fail) => zip.openReadStream(entry, (error, result) => error || !result ? fail(error ?? new Error('ZIP 读取失败')) : done(result)));
          const chunks: Buffer[] = []; let length = 0;
          for await (const chunk of stream) { const part = Buffer.from(chunk); length += part.length; if (length > maxFile) throw new SkillDraftError(`文件超过 10 MiB：${entryPath}`, 413); chunks.push(part); }
          items.push({ path: entryPath, isDir, content: Buffer.concat(chunks) }); zip.readEntry();
        } catch (error) { reject(error); zip.close(); }
      });
      zip.readEntry();
    });
  } finally { zip.close(); }
}
export async function importZip(buffer: Buffer): Promise<SkillDraftRecord> {
  const items = await extractZip(buffer);
  const files = items.filter((item) => !item.isDir && path.posix.basename(item.path) === 'SKILL.md');
  if (files.length > 1 || files.length === 1 && files[0].path !== 'SKILL.md' && !/^[^/]+\/SKILL\.md$/.test(files[0].path)) throw new SkillDraftError('ZIP 必须只包含一个位于根目录或一层外壳目录中的 SKILL.md');
  const inferredWrapper = items.length ? items[0].path.split('/')[0] : '';
  const hasSingleWrapper = Boolean(inferredWrapper) && items.some((item) => item.path.startsWith(`${inferredWrapper}/`)) && items.every((item) => item.path === inferredWrapper || item.path.startsWith(`${inferredWrapper}/`));
  const prefix = files.length ? files[0].path === 'SKILL.md' ? '' : files[0].path.slice(0, -'SKILL.md'.length) : hasSingleWrapper ? `${inferredWrapper}/` : '';
  if (items.some((item) => prefix && !item.path.startsWith(prefix) && item.path !== prefix.slice(0, -1))) throw new SkillDraftError('ZIP 外壳目录外还有其他文件');
  const value = await makeDraft('zip');
  value.archiveRoot = prefix ? prefix.slice(0, -1) : undefined;
  await saveMeta(value);
  try {
    for (const item of items) {
      const relative = prefix ? item.path.slice(prefix.length) : item.path;
      if (!relative) continue;
      const target = absolute(draftFiles(value.id), relative);
      if (item.isDir) await mkdir(target, { recursive: true });
      else { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, item.content!); }
    }
    return getDraft(value.id);
  } catch (error) { await rm(draftDir(value.id), { recursive: true, force: true }); throw error; }
}
async function checkedFile(id: string, relative: string): Promise<string> {
  await meta(id);
  const root = draftFiles(id); let parent = root;
  for (const part of safePath(relative).split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    const info = await lstat(parent).catch(() => null);
    if (info?.isSymbolicLink()) throw new SkillDraftError('路径中包含链接');
  }
  return absolute(root, relative);
}
export async function readDraftFile(id: string, relative: string): Promise<{ content: Buffer; text: boolean }> {
  const file = await checkedFile(id, relative); const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) throw new SkillDraftError('文件不存在', 404);
  const content = await readFile(file);
  let text = false; try { new TextDecoder('utf-8', { fatal: true }).decode(content); text = !content.includes(0); } catch { /* binary */ }
  return { content, text };
}
export async function writeDraftFile(id: string, relative: string, content: Buffer, expectedVersion?: number): Promise<SkillDraftRecord> {
  await checkVersion(id, expectedVersion);
  if (content.length > maxFile) throw new SkillDraftError('单文件超过 10 MiB', 413);
  const file = await checkedFile(id, relative);
  await mkdir(path.dirname(file), { recursive: true });
  const current = await lstat(file).catch(() => null);
  if (current?.isSymbolicLink() || current?.isDirectory()) throw new SkillDraftError('不能覆盖目录或链接');
  await writeFile(file, content);
  const value = await meta(id); value.validation = undefined; await saveMeta(value);
  return getDraft(id);
}
export async function changeDraftEntry(id: string, input: { action: 'mkdir' | 'create' | 'rename' | 'delete'; path: string; newPath?: string }, expectedVersion?: number): Promise<SkillDraftRecord> {
  await checkVersion(id, expectedVersion);
  const relative = safePath(input.path);
  if (relative === 'SKILL.md' && (input.action === 'delete' || input.action === 'rename')) throw new SkillDraftError('SKILL.md 不能删除或重命名');
  const target = await checkedFile(id, relative);
  if (input.action === 'mkdir' || input.action === 'create') {
    if (await lstat(target).catch(() => null)) throw new SkillDraftError('文件或目录已存在', 409);
    await mkdir(path.dirname(target), { recursive: true });
    if (input.action === 'mkdir') await mkdir(target); else await writeFile(target, '', { flag: 'wx' });
  } else if (input.action === 'delete') {
    if (!(await lstat(target).catch(() => null))) throw new SkillDraftError('文件或目录不存在', 404);
    await rm(target, { recursive: true });
  } else {
    const newPath = safePath(input.newPath ?? '');
    if (newPath === 'SKILL.md' || newPath.startsWith(`${relative}/`) || await lstat(await checkedFile(id, newPath)).catch(() => null)) throw new SkillDraftError('目标路径无效或已存在', 409);
    await mkdir(path.dirname(absolute(draftFiles(id), newPath)), { recursive: true });
    await rename(target, absolute(draftFiles(id), newPath));
  }
  const value = await meta(id); value.validation = undefined; await saveMeta(value); return getDraft(id);
}
async function sdkDiscover(root: string, slug: string): Promise<boolean> {
  const isolated = path.join(draftsRoot, `.sdk-${randomUUID()}`);
  const plugin = path.join(isolated, 'plugin');
  try {
    await mkdir(path.join(plugin, '.qoder-plugin'), { recursive: true });
    await mkdir(path.join(plugin, 'skills'), { recursive: true });
    await writeFile(path.join(plugin, '.qoder-plugin', 'plugin.json'), JSON.stringify({ name: 'workbench', version: '0.1.0' }));
    await cp(root, path.join(plugin, 'skills', slug), { recursive: true });
    const q = query({ prompt: (async function* () {})(), options: { auth: qodercliAuth(), cwd: fixtureRoot, settingSources: [], plugins: [{ type: 'local', path: plugin }], skills: 'all', tools: [] } });
    try { return (await q.initializationResult()).skills?.some((item) => item.name === `workbench:${slug}`) ?? false; }
    finally { await q.close().catch(() => {}); }
  } finally { await rm(isolated, { recursive: true, force: true }); }
}
export async function validateDraft(id: string, expectedVersion?: number, discover: typeof sdkDiscover = sdkDiscover): Promise<SkillDraftRecord> {
  await checkVersion(id, expectedVersion);
  const value = await meta(id); const root = draftFiles(id); const issues: SkillValidationIssue[] = [];
  let entries: SkillTreeEntry[] = [];
  try { entries = await walk(root); } catch (error) { issues.push({ path: '.', code: 'unsafe_file', message: (error as Error).message }); }
  if (entries.length > maxEntries) issues.push({ path: '.', code: 'too_many_entries', message: '文件条目超过 200 个' });
  let total = 0;
  for (const entry of entries.filter((item) => item.kind === 'file')) { total += entry.size; if (entry.size > maxFile) issues.push({ path: entry.path, code: 'file_too_large', message: '单文件超过 10 MiB' }); }
  if (total > maxExpanded) issues.push({ path: '.', code: 'too_large', message: '文件总量超过 50 MiB' });
  const skillFile = path.join(root, 'SKILL.md');
  let slug = '';
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(skillFile));
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
    if (!match) throw new Error('缺少有效 YAML frontmatter');
    const fields = YAML.parse(match[1]);
    if (typeof fields?.name !== 'string' || !slugPattern.test(fields.name) || fields.name.length > 64) throw new Error('name 须为小写字母、数字、连字符，最多 64 字符');
    slug = fields.name;
    parseSkill(slug, content);
    if (value.sourceSlug && slug !== value.sourceSlug) throw new Error('已发布 Skill 的名称不可修改');
    if (value.archiveRoot && slug !== value.archiveRoot) throw new Error(`ZIP 目录名必须与 name 一致：${value.archiveRoot}`);
  } catch (error) { issues.push({ path: 'SKILL.md', code: 'invalid_skill', message: error instanceof Error ? error.message : String(error) }); }
  if (slug && !value.sourceSlug && await stat(path.dirname(skillPath(slug))).catch(() => null)) issues.push({ path: 'SKILL.md', code: 'name_conflict', message: `Skill 名称已存在：${slug}` });
  let discovered = false;
  if (!issues.length) {
    try { discovered = await discover(root, slug); if (!discovered) issues.push({ path: 'SKILL.md', code: 'sdk_not_discovered', message: 'Qoder SDK 未发现这个 Skill' }); }
    catch (error) { issues.push({ path: 'SKILL.md', code: 'sdk_error', message: `SDK 发现失败：${error instanceof Error ? error.message : String(error)}` }); }
  }
  value.slug = slug || value.slug; value.validation = { valid: issues.length === 0, discovered, issues };
  await saveMeta(value); return getDraft(id);
}
let publishLock: Promise<void> = Promise.resolve();
export async function publishDraft(id: string, expectedVersion?: number, discover: typeof sdkDiscover = sdkDiscover) {
  const previous = publishLock;
  let release!: () => void; publishLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const checked = await validateDraft(id, expectedVersion, discover);
    if (!checked.validation?.valid || !checked.slug) {
      const conflict = checked.validation?.issues.find((issue) => issue.code === 'name_conflict');
      throw new SkillDraftError(conflict?.message ?? 'Skill 校验未通过', conflict ? 409 : 400);
    }
    const value = await meta(id); const slug = checked.slug;
    const target = path.dirname(skillPath(slug));
    const source = draftFiles(id);
    const backup = path.join(dataRoot, `skill-backup-${randomUUID()}`);
    if (value.sourceSlug) {
      const current = await revision(target).catch(() => null);
      if (!current || current !== value.baseRevision) throw new SkillDraftError('已发布 Skill 已被其他编辑修改，请新建草稿后重试', 409);
    } else if (await stat(target).catch(() => null)) throw new SkillDraftError('Skill 名称已存在', 409);
    await mkdir(skillRoot, { recursive: true });
    let backedUp = false; let installed = false;
    try {
      if (value.sourceSlug) { await rename(target, backup); backedUp = true; }
      await rename(source, target); installed = true;
      clearDiscoveryCache();
      const skill = parseSkill(slug, await readFile(path.join(target, 'SKILL.md'), 'utf8'));
      skill.fileCount = (await walk(target)).filter((item) => item.kind === 'file').length;
      skill.validation = 'valid';
      await refreshConfigCatalog();
      await rm(draftDir(id), { recursive: true, force: true }).catch(() => {});
      if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => {});
      return skill;
    } catch (error) {
      if (installed) { await rename(target, source).catch(() => {}); }
      if (backedUp) await rename(backup, target).catch(() => {});
      clearDiscoveryCache(); throw error;
    }
  } finally { release(); }
}
export async function deleteDraft(id: string) { await meta(id); await rm(draftDir(id), { recursive: true, force: true }); }
export async function readPublishedFile(slug: string, relative: string) {
  const root = path.dirname(skillPath(slug));
  const file = absolute(root, relative);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink()) throw new SkillDraftError('文件不存在', 404);
  const resolvedRoot = await realpath(root);
  const resolvedFile = await realpath(file);
  if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) throw new SkillDraftError('文件路径越界', 400);
  return createReadStream(file);
}
export async function listPublishedFiles(slug: string): Promise<SkillTreeEntry[]> {
  const root = path.dirname(skillPath(slug));
  if (!(await stat(root).catch(() => null))?.isDirectory()) throw new SkillDraftError('Skill 不存在', 404);
  return walk(root);
}
