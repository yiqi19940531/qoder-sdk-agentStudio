import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { SkillRecord } from '../shared/types.js';
import { pluginRoot } from './storage.js';

export const skillRoot = path.join(pluginRoot, 'skills');
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function skillName(slug: string): string { return `workbench:${slug}`; }

export function skillPath(slug: string): string {
  if (!slugPattern.test(slug) || slug.length > 64) throw new Error('Skill 名称只允许小写字母、数字和连字符，最多 64 字符');
  return path.join(skillRoot, slug, 'SKILL.md');
}

export function parseSkill(slug: string, content: string): SkillRecord {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) throw new Error('SKILL.md 缺少有效的 YAML frontmatter');
  const metadata = YAML.parse(match[1]) as unknown;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Skill 元数据必须是 YAML 对象');
  const fields = metadata as Record<string, unknown>;
  if (fields.name !== slug) throw new Error(`Skill 元数据 name 必须是 ${slug}`);
  if (typeof fields.description !== 'string' || !fields.description.trim() || fields.description.length > 1024) throw new Error('Skill description 必须是 1–1024 字符');
  if (!match[2].trim()) throw new Error('Skill 指令正文不能为空');
  return {
    slug,
    name: skillName(slug),
    description: fields.description,
    body: match[2].trim(),
    path: skillPath(slug),
    editable: true,
  };
}

export function renderSkill(slug: string, description: string, body: string): string {
  const content = `---\n${YAML.stringify({ name: slug, description })}---\n\n${body.trim()}\n`;
  parseSkill(slug, content);
  return content;
}

export function renderSkillPreserving(content: string, slug: string, description: string, body: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n[\s\S]*$/.exec(content);
  if (!match) throw new Error('SKILL.md 缺少有效的 YAML frontmatter');
  const document = YAML.parseDocument(match[1]);
  if (document.errors.length) throw new Error('SKILL.md YAML 无效');
  document.set('name', slug);
  document.set('description', description);
  const result = `---\n${document.toString()}---\n\n${body.trim()}\n`;
  parseSkill(slug, result);
  return result;
}

export async function listSkills(): Promise<SkillRecord[]> {
  await mkdir(skillRoot, { recursive: true });
  const entries = await readdir(skillRoot, { withFileTypes: true });
  const records: SkillRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !slugPattern.test(entry.name)) continue;
    const file = skillPath(entry.name);
    try {
      const record = parseSkill(entry.name, await readFile(file, 'utf8'));
      record.fileCount = await countFiles(path.dirname(file));
      record.validation = 'valid';
      records.push(record);
    } catch (error) {
      records.push({ slug: entry.name, name: skillName(entry.name), description: '', body: '', path: file, editable: true, validation: 'invalid', error: error instanceof Error ? error.message : String(error), fileCount: await countFiles(path.dirname(file)) });
    }
  }
  return records.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function countFiles(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(path.join(directory, entry.name));
    else count += 1;
  }
  return count;
}

export async function saveSkill(slug: string, description: string, body: string, create: boolean): Promise<SkillRecord> {
  const file = skillPath(slug);
  const content = renderSkill(slug, description, body);
  const dir = path.dirname(file);
  if (create) {
    await mkdir(dir);
    try { await writeFile(file, content, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { await rmdir(dir).catch(() => {}); throw error; }
  } else {
    await stat(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, file);
  }
  return parseSkill(slug, content);
}

export async function deleteSkill(slug: string): Promise<void> {
  if (slug === 'repo-review') throw new Error('示例 Skill 不支持删除');
  await rm(path.dirname(skillPath(slug)), { recursive: true, force: false });
}
