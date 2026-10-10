import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import yazl from 'yazl';
import yauzl from 'yauzl';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'release', 'qoder-agent-workbench-demo.zip');
const stage = await mkdtemp(path.join(os.tmpdir(), 'qoder-demo-'));
const files = new Set();
const forbidden = /(^|\/)(api-key\.md|mcp-secrets\.json|mcp-session-config|config-catalog\.json|apify-verification\.json|node_modules|dist|dist-server|\.playwright-mcp|\.tmp[^/]*)($|\/)/i;
const forbiddenPath = (relative) => forbidden.test(relative) || relative.split('/').some((name) => name === '.env' || (name.startsWith('.env.') && name !== '.env.example'));
const secretPatterns = [
  ['API key', /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ['Apify token', /\bapify_api_[A-Za-z0-9_-]{12,}\b/gi],
  ['cloud access ID', /\bLTAI[A-Za-z0-9]{12,}\b/g],
  ['phone number', /(?<!\d)1[3-9]\d{9}(?!\d)/g],
  ['authorization', /\bBearer\s+[A-Za-z0-9._~-]{12,}\b/gi],
  ['private path', /(?:\/Users\/[^/\s"'`]+|\/home\/[^/\s"'`]+|[A-Z]:\\Users\\[^\\\s"'`]+)/g],
  ['credential URL', /[?&](?:token|api[_-]?key|access[_-]?key|secret|password|auth)=([^&#\s"']+)/gi],
];
const knownSecrets = [];
const privateOwner = root.match(/^\/Users\/([^/]+)/)?.[1] ?? root.match(/^\/home\/([^/]+)/)?.[1];
for (const name of ['api-key.md', 'data/mcp-secrets.json', '.env']) {
  try {
    const raw = await readFile(path.join(root, name), 'utf8');
    for (const match of raw.matchAll(/(?:sk-[A-Za-z0-9_-]{16,}|apify_api_[A-Za-z0-9_-]{12,})/g)) knownSecrets.push(match[0]);
    if (name === 'api-key.md') for (const match of raw.matchAll(/https:\/\/[^\s)]+/g)) knownSecrets.push(match[0]);
    if (name.endsWith('mcp-secrets.json')) {
      const parsed = JSON.parse(raw);
      const collect = (value) => {
        if (typeof value === 'string' && value.length >= 16) knownSecrets.push(value);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
      };
      collect(parsed);
    }
    if (name === '.env') {
      const line = raw.split(/\r?\n/).find((item) => /^BROWSERLESS_API_TOKEN\s*=/.test(item));
      const token = line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
      if (token && token.length >= 8) knownSecrets.push(token);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function sanitize(value) {
  if (typeof value === 'string') {
    let clean = value.replaceAll(root, 'demo-workspace');
    if (privateOwner) clean = clean.replaceAll(privateOwner, '[LOCAL_USER]');
    for (const secret of knownSecrets) clean = clean.replaceAll(secret, '[REDACTED]');
    for (const [label, expression] of secretPatterns) {
      clean = clean.replace(expression, label === 'private path' ? '[LOCAL_PATH]' : '[REDACTED]');
    }
    return clean;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitize(item)]));
  return value;
}

async function add(relative, bytes) {
  if (forbiddenPath(relative)) throw new Error(`Forbidden input: ${relative}`);
  const destination = path.join(stage, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  files.add(relative);
}
async function copy(relative) { await add(relative, await readFile(path.join(root, relative))); }
async function copyTree(relative, predicate = () => true) {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = `${relative}/${entry.name}`;
    if (!predicate(next, entry)) continue;
    if (entry.isDirectory()) await copyTree(next, predicate);
    else if (entry.isFile()) await copy(next);
  }
}
async function addJson(relative, object) { await add(relative, Buffer.from(`${JSON.stringify(sanitize(object), null, 2)}\n`)); }

async function audit(relative, bytes) {
  if (forbiddenPath(relative)) throw new Error(`Forbidden entry: ${relative}`);
  const latin = bytes.toString('latin1');
  const utf = bytes.toString('utf8');
  const utf16 = bytes.toString('utf16le');
  for (const secret of knownSecrets) {
    if (bytes.includes(Buffer.from(secret)) || bytes.includes(Buffer.from(secret, 'utf16le'))) throw new Error(`Known credential found: ${relative}`);
  }
  if (privateOwner && (bytes.includes(Buffer.from(privateOwner)) || bytes.includes(Buffer.from(privateOwner, 'utf16le')))) throw new Error(`Private owner identifier found: ${relative}`);
  for (const [label, expression] of secretPatterns) {
    expression.lastIndex = 0;
    if ([latin, utf, utf16].some((value) => { expression.lastIndex = 0; return expression.test(value); })) throw new Error(`${label} found: ${relative}`);
  }
}

try {
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.server.json', 'tsconfig.web.json', 'vite.config.ts', 'index.html', '.gitignore', '.env.example', 'QUICKSTART.zh-CN.md', 'QUICKSTART.en.md', 'VALIDATION.md', 'start.sh', 'start.cmd']) await copy(name);
  let demoReadme;
  try { demoReadme = await readFile(path.join(root, 'README.demo.md')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; demoReadme = await readFile(path.join(root, 'README.md')); }
  await add('README.md', demoReadme);
  for (const tree of ['src', 'server', 'shared', 'scripts', 'public', 'plugins/workbench']) await copyTree(tree, (name, entry) => !entry.name.startsWith('.') && !/\.(log|tmp)$/.test(name));
  await copy('plugins/workbench/.qoder-plugin/plugin.json');
  await copyTree('docs/rebuild');
  await copy('docs/index.html');
  await copy('docs/.nojekyll');
  const agents = JSON.parse(await readFile(path.join(root, 'data/agents.json'), 'utf8'));
  if (agents.length !== 7) throw new Error(`Expected 7 Agents, found ${agents.length}`);
  for (const agent of agents) {
    if (agent.model !== 'auto' && agent.model !== 'efficient') agent.model = 'auto';
    agent.mcpServers = agent.mcpServers.filter((id) => id !== 'apify');
    agent.permissions = { toolApproval: 'ask', pathAccess: 'workspace', additionalDirectories: [] };
  }
  await addJson('data/agents.json', agents);
  await addJson('data/permission-settings.json', { alwaysAllowTools: [] });
  const mcps = JSON.parse(await readFile(path.join(root, 'data/mcp-servers.json'), 'utf8'));
  for (const mcp of mcps) mcp.check = { status: 'untested', tools: [] };
  await addJson('data/mcp-servers.json', mcps);
  await addJson('data/aigc-settings.json', JSON.parse(await readFile(path.join(root, 'data/aigc-settings.json'), 'utf8')));
  for (const agent of agents) {
    const directory = `data/profiles/${agent.id}`;
    try {
      const visit = async (relative) => {
        for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
          if (entry.name.startsWith('.')) continue;
          const next = `${relative}/${entry.name}`;
          if (entry.isDirectory()) await visit(next);
          else if (entry.isFile() && /\.(md|txt)$/i.test(next)) await add(next, Buffer.from(sanitize(await readFile(path.join(root, next), 'utf8'))));
        }
      };
      await visit(directory);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await copyTree('data/example-repo', (name, entry) => !entry.name.startsWith('.') && !name.includes('/.tmp'));
  const archiveIndex = JSON.parse(await readFile(path.join(root, 'data/demo-archive-index.json'), 'utf8'));
  const archiveIds = archiveIndex.conversationIds;
  if (!Array.isArray(archiveIds) || archiveIds.length !== 34 || new Set(archiveIds).size !== archiveIds.length || archiveIds.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) throw new Error('Demo archive index is invalid');
  const availableConversations = new Set((await readdir(path.join(root, 'data/conversations'))).filter((name) => name.endsWith('.json')));
  const conversationFiles = archiveIds.map((id) => `${id}.json`).sort();
  if (conversationFiles.some((name) => !availableConversations.has(name))) throw new Error('Demo archive file is missing');
  await addJson('data/demo-archive-index.json', archiveIndex);
  for (const name of conversationFiles) {
    const item = JSON.parse(await readFile(path.join(root, 'data/conversations', name), 'utf8'));
    item.demoArchive = true;
    item.status = 'idle';
    item.sdkEstablished = false;
    item.sdkSessionId = item.id;
    item.pending = [];
    item.sessionAllowedTools = [];
    item.sessionAllowedCategories = [];
    await addJson(`data/conversations/${name}`, item);
  }
  const generatedFiles = (await readdir(path.join(root, 'data/generated'))).sort();
  for (const name of generatedFiles) {
    const relative = `data/generated/${name}`;
    if (name.endsWith('.json')) await addJson(relative, JSON.parse(await readFile(path.join(root, relative), 'utf8')));
    else if (/\.(png|jpg|jpeg|webp|mp4)$/i.test(name)) await copy(relative);
  }
  // These screenshots have been visually checked. Screenshots with a visible local home path are excluded.
  for (const name of ['skills-editor.jpg', 'global-tool-permissions.png', 'chrome-devtools-home.png', 'aliyun-minisite-check.png', 'playwright-skills-tab.png']) await copy(`artifacts/${name}`);
  const promoNames = ['01-overview', '02-repo-delegation', '03-aigc-flow', '04-mcp-config', '05-skills', '06-permissions'];
  await copy('artifacts/promo-videos/README.md');
  for (const name of promoNames) {
    await copy(`artifacts/promo-videos/${name}.mp4`);
    await copy(`artifacts/promo-videos/${name}-poster.png`);
    await copy(`artifacts/promo-videos/${name}-preview.gif`);
  }
  for (const name of ['mcp-ui.png', 'mcp-ui-light.png']) await copy(`data/${name}`);
  await addJson('DEMO-MANIFEST.json', { agents: agents.length, skills: 3, conversations: conversationFiles.length, successfulMedia: generatedFiles.filter((name) => /\.(png|mp4)$/i.test(name)).length, promoVideos: promoNames.length, archivePolicy: 'read-only; new questions create new account sessions' });
  if (conversationFiles.length !== 34 || generatedFiles.filter((name) => /\.(png|mp4)$/i.test(name)).length !== 4) throw new Error('Demo inventory changed; inspect before publishing');

  for (const relative of [...files].sort()) await audit(relative, await readFile(path.join(stage, relative)));
  await mkdir(path.dirname(output), { recursive: true });
  const zip = new yazl.ZipFile();
  for (const relative of [...files].sort()) zip.addFile(path.join(stage, relative), `qoder-agent-workbench-demo/${relative}`);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(output));
  const verified = new Set();
  await new Promise((resolve, reject) => yauzl.open(output, { lazyEntries: true }, (error, archive) => {
    if (error) return reject(error);
    archive.once('error', reject);
    archive.once('end', resolve);
    archive.on('entry', (entry) => {
      const relative = entry.fileName.replace(/^qoder-agent-workbench-demo\//, '');
      if (!files.has(relative) || verified.has(relative)) return reject(new Error(`Unexpected ZIP entry: ${relative}`));
      archive.openReadStream(entry, async (streamError, stream) => {
        if (streamError) return reject(streamError);
        try {
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          await audit(relative, Buffer.concat(chunks));
          verified.add(relative);
          archive.readEntry();
        } catch (readError) { reject(readError); }
      });
    });
    archive.readEntry();
  }));
  if (verified.size !== files.size) throw new Error('ZIP entry count differs from staged files');
  console.log(`Created ${output} with ${verified.size} audited files, ${conversationFiles.length} demo conversations and 4 successful media files.`);
} catch (error) {
  await rm(output, { force: true });
  console.error(`Public package blocked: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(stage, { recursive: true, force: true });
}
