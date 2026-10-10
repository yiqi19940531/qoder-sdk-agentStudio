import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.MCP_TEST_API ?? 'http://127.0.0.1:8787/api';
const mockPath = path.resolve('scripts/mock-mcp.mjs');
const children = [];
const ids = [];
const token = 'fixture-secret';
function mock(transport, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mockPath, transport, '0'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let output = '';
    const timer = setTimeout(() => reject(new Error(`${transport} fixture did not start`)), 5000);
    child.stdout.on('data', (chunk) => { output += chunk; const port = Number(output.trim().split('\n')[0]); if (port) { clearTimeout(timer); resolve(port); } });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
async function api(url, method = 'GET', body) {
  const response = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${method} ${url}: ${parsed?.error ?? text}`);
  return parsed;
}
async function add(id, input) {
  await api('/mcp-servers', 'POST', { id, name: id, timeoutMs: 8000, args: [], envNames: [], headerNames: [], ...input });
  ids.push(id);
}
async function check(id) { return api(`/mcp-servers/${id}/check`, 'POST'); }
try {
  const builtins = await api('/mcp-servers');
  for (const id of ['repo-facts', 'playwright', 'chrome-devtools', 'bailian-image', 'bailian-video', 'jd-browser']) assert(builtins.some((item) => item.id === id && item.source === 'builtin'));
  const [httpPort, ssePort, authPort, emptyPort, hangPort] = await Promise.all([
    mock('http'), mock('sse'), mock('http', { REQUIRE_TOKEN: '1' }), mock('http', { EMPTY_TOOLS: '1' }), mock('http', { HANG_MCP: '1' }),
  ]);
  await add('fixture-mcp-stdio', { transport: 'stdio', auth: 'none', command: process.execPath, args: [mockPath, 'stdio'] });
  await add('fixture-mcp-http', { transport: 'http', auth: 'none', url: `http://127.0.0.1:${httpPort}/mcp` });
  await add('fixture-mcp-sse', { transport: 'sse', auth: 'none', url: `http://127.0.0.1:${ssePort}/sse` });
  for (const id of ['fixture-mcp-stdio', 'fixture-mcp-http', 'fixture-mcp-sse']) {
    const result = await check(id);
    assert.equal(result.status, 'connected', `${id}: ${result.error}`);
    assert(result.tools.some((tool) => tool.name === 'fixture_search'));
  }
  await add('fixture-mcp-auth', { transport: 'http', auth: 'none', url: `http://127.0.0.1:${authPort}/mcp` });
  assert.equal((await check('fixture-mcp-auth')).status, 'needs-auth');
  const saved = await api('/mcp-servers/fixture-mcp-auth', 'PUT', { id: 'fixture-mcp-auth', name: 'fixture-mcp-auth', transport: 'http', auth: 'bearer', url: `http://127.0.0.1:${authPort}/mcp`, timeoutMs: 8000, envNames: [], headerNames: [], bearerToken: token });
  assert.equal(saved.hasBearerToken, true);
  assert(!JSON.stringify(saved).includes(token));
  assert.equal((await check('fixture-mcp-auth')).status, 'connected');
  assert.equal((await stat('data/mcp-secrets.json')).mode & 0o777, 0o600);
  for (const content of [JSON.stringify(await api('/mcp-servers')), JSON.stringify(await api('/config-catalog')), await readFile('data/mcp-servers.json', 'utf8')]) assert(!content.includes(token));
  await add('fixture-mcp-empty', { transport: 'http', auth: 'none', url: `http://127.0.0.1:${emptyPort}/mcp` });
  const empty = await check('fixture-mcp-empty');
  assert.equal(empty.status, 'connected'); assert.equal(empty.tools.length, 0);
  await add('fixture-mcp-fail', { transport: 'stdio', auth: 'none', command: '/nonexistent/mcp-server' });
  assert.equal((await check('fixture-mcp-fail')).status, 'failed');
  await add('fixture-mcp-timeout', { transport: 'http', auth: 'none', url: `http://127.0.0.1:${hangPort}/mcp`, timeoutMs: 1000 });
  assert.equal((await check('fixture-mcp-timeout')).status, 'failed');
  console.log('MCP integration passed: six built-ins, stdio, HTTP, SSE, auth, redaction, empty tools, startup failure, timeout.');
} finally {
  for (const id of ids.reverse()) await api(`/mcp-servers/${id}`, 'DELETE').catch(() => {});
  for (const child of children) child.kill('SIGTERM');
}
