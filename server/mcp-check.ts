import { randomUUID } from 'node:crypto';
import { qodercliAuth, query, type Query } from '@qoder-ai/qoder-agent-sdk';
import type { McpCheck } from '../shared/types.js';
import { configuredMcpServers } from './runtime.js';
import { fixtureRoot } from './storage.js';
import { getMcpServer, recordMcpCheck, redactMcpError, redactMcpSecrets } from './mcp-registry.js';

type CheckSession = { query: Query; close: () => Promise<void> };
const flows = new Map<string, { id: string; session: CheckSession; timer: ReturnType<typeof setTimeout> }>();
const maxCheckMs = 35_000;
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP 连接校验超时')), ms); });
  return Promise.race([task, deadline]).finally(() => clearTimeout(timer));
}
function createCheckQuery(id: string): CheckSession {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const instance = query({ prompt: (async function* () { await wait; })(), options: {
    auth: qodercliAuth(), cwd: fixtureRoot, settingSources: [], tools: [],
    mcpServers: configuredMcpServers(new Set([id])),
    allowedMcpServerNames: id === 'repo-facts' ? [] : [id], strictMcpConfig: true,
  } });
  return { query: instance, close: async () => { release(); await instance.close().catch(() => {}); } };
}
async function poll(q: Query, id: string, timeoutMs = maxCheckMs): Promise<McpCheck> {
  const started = Date.now();
  const until = started + timeoutMs;
  do {
    const status = (await withTimeout(q.mcpServerStatus(), Math.min(7000, Math.max(1000, until - Date.now())))).find((item) => item.name === id);
    if (String(status?.status) === 'disconnected') {
      if (Date.now() + 500 >= until) break;
      await sleep(500);
      continue;
    }
    if (status && !['pending', 'connecting'].includes(status.status)) {
      const state: string = status.status;
      return { status: state === 'disconnected' ? 'failed' : status.status, checkedAt: new Date().toISOString(),
        error: status.error ? redactMcpError(status.error) : state === 'disconnected' ? 'MCP 进程已断开，请检查命令和参数' : undefined,
        tools: status.tools?.map(({ name, description, annotations }) => ({ name: name.startsWith(`mcp__${id}__`) ? name.slice(`mcp__${id}__`.length) : name, description: description ? redactMcpSecrets(description) : undefined, annotations })) ?? [],
        serverInfo: status.serverInfo ? { name: redactMcpSecrets(status.serverInfo.name), version: status.serverInfo.version } : undefined };
    }
    await sleep(500);
  } while (Date.now() < until);
  return { status: 'failed', checkedAt: new Date().toISOString(), error: 'MCP 连接校验超时', tools: [] };
}
export async function checkMcp(id: string): Promise<McpCheck> {
  const item = getMcpServer(id);
  if (!item) throw new Error('MCP 不存在');
  const deadline = Math.min(maxCheckMs, Math.max(8_000, item.timeoutMs ?? 30_000));
  const session = createCheckQuery(id);
  let check: McpCheck;
  try { await withTimeout(session.query.initializationResult(), deadline); check = await poll(session.query, id, deadline); }
  catch (error) { check = { status: 'failed', checkedAt: new Date().toISOString(), error: redactMcpError(error), tools: [] }; }
  finally { await session.close(); }
  await recordMcpCheck(id, check);
  return check;
}
export async function startMcpOAuth(id: string, baseUrl: string): Promise<{ flowId?: string; authUrl?: string; check?: McpCheck }> {
  const item = getMcpServer(id);
  if (!item || item.auth !== 'oauth') throw new Error('此 MCP 未配置 OAuth');
  const session = createCheckQuery(id);
  try {
    await withTimeout(session.query.initializationResult(), maxCheckMs);
    const initial = await poll(session.query, id);
    if (initial.status === 'failed') throw new Error(initial.error ?? 'MCP 连接失败');
    const flowId = randomUUID();
    const redirectUri = `${baseUrl}/api/mcp/oauth/callback/${flowId}`;
    const result = await withTimeout(session.query.mcpAuthenticate(id, redirectUri), maxCheckMs);
    if (!result.requiresUserAction) {
      const check = await poll(session.query, id);
      await recordMcpCheck(id, check);
      await session.close();
      return { check };
    }
    if (!result.authUrl) throw new Error('OAuth 服务没有返回授权地址');
    const timer = setTimeout(() => { flows.delete(flowId); void session.close(); }, 5 * 60_000);
    flows.set(flowId, { id, session, timer });
    return { flowId, authUrl: result.authUrl };
  } catch (error) { await session.close(); throw new Error(redactMcpError(error)); }
}
export async function completeMcpOAuth(flowId: string, callbackUrl: string): Promise<McpCheck> {
  const flow = flows.get(flowId);
  if (!flow) throw new Error('OAuth 授权已过期');
  clearTimeout(flow.timer); flows.delete(flowId);
  try {
    await withTimeout(flow.session.query.mcpSubmitOAuthCallbackUrl(flow.id, callbackUrl), maxCheckMs);
    const check = await poll(flow.session.query, flow.id);
    await recordMcpCheck(flow.id, check);
    return check;
  } finally { await flow.session.close(); }
}
