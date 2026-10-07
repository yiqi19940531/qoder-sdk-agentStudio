import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AigcSettings, MediaArtifact } from '../shared/types.js';
import { dataRoot } from './storage.js';

export const aigcSettingsPath = path.join(dataRoot, 'aigc-settings.json');
export const generatedRoot = path.join(dataRoot, 'generated');
const keyPath = path.join(process.cwd(), 'api-key.md');
const imageScript = path.join(process.cwd(), 'plugins/workbench/skills/bailian-image/generate.py');
const videoScript = path.join(process.cwd(), 'plugins/workbench/skills/bailian-video/generate.py');
const defaults: AigcSettings = { imageModel: 'qwen-image-3.0', imageSize: '1024*1024', videoModel: 'wan3.0-video', videoDuration: 5, videoResolution: '480P' };
const artifacts = new Map<string, MediaArtifact>();
const workers = new Map<string, Promise<MediaArtifact>>();
const listeners = new Set<(artifact: MediaArtifact) => void>();
let settings: AigcSettings = defaults;

function metadataPath(id: string) { return path.join(generatedRoot, `${id}.json`); }
function clone(artifact: MediaArtifact): MediaArtifact { return { ...artifact, ...(artifact.status === 'succeeded' ? { url: `/api/artifacts/${artifact.id}` } : {}) }; }
function scrub(value: string, key?: string): string { return (key ? value.replaceAll(key, '[redacted]') : value).slice(0, 500); }

async function writeAtomic(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, file);
}

export function getAigcSettings(): AigcSettings { return { ...settings }; }
export async function saveAigcSettings(next: AigcSettings): Promise<AigcSettings> {
  await writeAtomic(aigcSettingsPath, JSON.stringify(next, null, 2));
  settings = { ...next };
  return getAigcSettings();
}

function credential() {
  const value = requireKeyText();
  const keys = [...value.matchAll(/sk-[A-Za-z0-9._-]+/g)].map((match) => match[0]);
  const urls = [...value.matchAll(/https:\/\/[^\s)]+/g)].map((match) => match[0]);
  if (keys.length !== 1 || urls.length !== 1) throw new Error('api-key.md 需要恰好一个百炼密钥和一个接口地址');
  const endpoint = new URL(urls[0]);
  if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.cn-beijing.maas.aliyuncs.com') || !endpoint.pathname.startsWith('/compatible-mode/v1')) throw new Error('api-key.md 必须使用北京地域的百炼业务空间地址');
  return { key: keys[0], base: `${endpoint.origin}/api/v1` };
}

let cachedKeyText = '';
function requireKeyText(): string {
  if (!cachedKeyText) throw new Error('百炼凭据不可用，请检查 api-key.md');
  return cachedKeyText;
}
export function credentialStatus(): 'available' | 'invalid' {
  try { credential(); return 'available'; } catch { return 'invalid'; }
}
export async function reloadCredential(): Promise<void> {
  try { cachedKeyText = await readFile(keyPath, 'utf8'); } catch { cachedKeyText = ''; }
}

async function persist(artifact: MediaArtifact) {
  artifacts.set(artifact.id, artifact);
  await writeAtomic(metadataPath(artifact.id), JSON.stringify(artifact, null, 2));
  for (const listener of listeners) listener(clone(artifact));
}
async function update(artifact: MediaArtifact, patch: Partial<MediaArtifact>) {
  Object.assign(artifact, patch, { updatedAt: new Date().toISOString() });
  await persist(artifact);
}
export function subscribeArtifactUpdates(listener: (artifact: MediaArtifact) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function artifactsForConversation(id: string): MediaArtifact[] {
  return [...artifacts.values()].filter((item) => item.conversationId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(clone);
}
export function artifactById(id: string): MediaArtifact | undefined { return /^[a-f0-9-]{36}$/.test(id) ? artifacts.get(id) : undefined; }
export function artifactFile(artifact: MediaArtifact): string | undefined {
  if (artifact.status !== 'succeeded') return undefined;
  return path.join(generatedRoot, `${artifact.id}.${artifact.kind === 'image' ? 'png' : 'mp4'}`);
}

async function python(script: string, input: Record<string, unknown>, timeoutMs: number): Promise<Record<string, any>> {
  await reloadCredential();
  const { key, base } = credential();
  const executable = process.env.AIGC_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const args = process.platform === 'win32' && !process.env.AIGC_PYTHON ? ['-3', script] : [script];
  const child = spawn(executable, args, {
    env: { ...process.env, DASHSCOPE_API_KEY: key, BAILIAN_API_BASE: process.env.AIGC_TEST_BASE_URL || base },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 16_000) child.kill(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 16_000) child.kill(); });
  child.stdin.end(JSON.stringify(input));
  const testTimeout = process.env.AIGC_TEST_BASE_URL ? Number(process.env.AIGC_TEST_TIMEOUT_MS ?? 0) : 0;
  const timer = setTimeout(() => child.kill(), testTimeout > 0 ? Math.min(timeoutMs, testTimeout) : timeoutMs);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  }).finally(() => clearTimeout(timer));
  let output: Record<string, any> = {};
  try { output = JSON.parse(stdout.trim()); } catch { /* A failed process may not write JSON. */ }
  if (exitCode !== 0 || output.error) throw new Error(scrub(String(output.error ?? stderr ?? `Python exited ${exitCode}`), key));
  return output;
}

function resultUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('百炼没有返回媒体地址');
  const url = new URL(value);
  const localTest = Boolean(process.env.AIGC_TEST_BASE_URL) && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === new URL(process.env.AIGC_TEST_BASE_URL!).origin;
  if (!localTest && (url.protocol !== 'https:' || !(url.hostname === 'aliyuncs.com' || url.hostname.endsWith('.aliyuncs.com')))) throw new Error('百炼返回的媒体地址不受信任');
  return url;
}
async function download(artifact: MediaArtifact, value: unknown) {
  let url = resultUrl(value);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120_000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('媒体下载重定向缺少地址');
      url = resultUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`媒体下载失败：HTTP ${response.status}`);
    const max = artifact.kind === 'image' ? 25_000_000 : 100_000_000;
    const announced = Number(response.headers.get('content-length') ?? 0);
    if (announced > max) throw new Error('媒体文件超过大小限制');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('媒体下载响应为空');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) { await reader.cancel(); throw new Error('媒体文件超过大小限制'); }
      chunks.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(chunks, total);
    if (!bytes.length || bytes.length > max) throw new Error('媒体文件为空或超过大小限制');
    const mimeType = artifact.kind === 'image' ? 'image/png' : 'video/mp4';
    if (artifact.kind === 'image' && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('图片结果不是 PNG');
    if (artifact.kind === 'video' && bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('视频结果不是 MP4');
    const file = artifactFile({ ...artifact, status: 'succeeded' })!;
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes);
    await rename(temporary, file);
    await update(artifact, { status: 'succeeded', mimeType, bytes: bytes.length });
    return;
  }
  throw new Error('媒体下载重定向过多');
}

async function runImage(artifact: MediaArtifact) {
  await update(artifact, { status: 'running' });
  const output = await python(imageScript, { prompt: artifact.prompt, model: artifact.model, size: settings.imageSize }, 330_000);
  await update(artifact, { requestId: String(output.requestId ?? '') });
  await download(artifact, output.url);
}

async function runVideo(artifact: MediaArtifact) {
  await update(artifact, { status: 'running' });
  if (!artifact.taskId) {
    const output = await python(videoScript, { action: 'submit', prompt: artifact.prompt, model: artifact.model, resolution: settings.videoResolution, duration: settings.videoDuration }, 90_000);
    if (typeof output.taskId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(output.taskId)) throw new Error('百炼没有返回有效的视频任务 ID');
    await update(artifact, { taskId: output.taskId, requestId: String(output.requestId ?? '') });
  }
  const interval = process.env.AIGC_TEST_BASE_URL ? 250 : 15_000;
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const output = await python(videoScript, { action: 'poll', taskId: artifact.taskId }, 90_000);
    const status = String(output.status ?? '');
    if (status === 'SUCCEEDED') { await download(artifact, output.url); return; }
    if (status === 'FAILED' || status === 'UNKNOWN') throw new Error(`视频任务${status}：${String(output.code ?? output.message ?? '').slice(0, 160)}`);
    if (status !== 'PENDING' && status !== 'RUNNING') throw new Error(`未知的视频任务状态：${status}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error('视频生成等待超过 12 分钟；云端任务 ID 已保存');
}

function startWorker(artifact: MediaArtifact): Promise<MediaArtifact> {
  const running = workers.get(artifact.id);
  if (running) return running;
  const work = (async () => {
    try { if (artifact.kind === 'image') await runImage(artifact); else await runVideo(artifact); }
    catch (error) { await update(artifact, { status: 'failed', error: scrub(error instanceof Error ? error.message : String(error)) }); }
    return clone(artifact);
  })();
  workers.set(artifact.id, work);
  void work.finally(() => workers.delete(artifact.id));
  return work;
}

export async function generate(kind: 'image' | 'video', conversationId: string, turnId: string, prompt: string): Promise<MediaArtifact> {
  const existing = [...artifacts.values()].find((item) => item.conversationId === conversationId && item.turnId === turnId && item.kind === kind);
  if (existing) return existing.status === 'succeeded' || existing.status === 'failed' ? clone(existing) : startWorker(existing);
  const now = new Date().toISOString();
  const artifact: MediaArtifact = { id: randomUUID(), conversationId, turnId, kind, status: 'queued', prompt, model: kind === 'image' ? settings.imageModel : settings.videoModel, createdAt: now, updatedAt: now };
  await persist(artifact);
  return startWorker(artifact);
}

export async function initializeAigc(): Promise<void> {
  await mkdir(generatedRoot, { recursive: true });
  await reloadCredential();
  try { settings = { ...defaults, ...JSON.parse(await readFile(aigcSettingsPath, 'utf8')) as AigcSettings }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await saveAigcSettings(defaults);
  }
  for (const name of await readdir(generatedRoot)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    try {
      const item = JSON.parse(await readFile(path.join(generatedRoot, name), 'utf8')) as MediaArtifact;
      if (item.id === name.slice(0, -5)) artifacts.set(item.id, item);
    } catch { /* Skip corrupt metadata. */ }
  }
  for (const item of artifacts.values()) {
    if (item.status !== 'queued' && item.status !== 'running') continue;
    if (item.kind === 'video' && item.taskId) void startWorker(item);
    else await update(item, { status: 'failed', error: '服务重启中断了尚未提交完成的生成请求；请在新一轮重试。' });
  }
}
