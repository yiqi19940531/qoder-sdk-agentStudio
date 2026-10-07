import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { McpServerConfig } from '@qoder-ai/qoder-agent-sdk';
import { MCP_NAMES, MCP_TOOL_NAMES, type McpCheck, type McpServerInput, type McpServerRecord } from '../shared/types.js';
import { dataRoot, loadAgents } from './storage.js';

type Stored = Omit<McpServerRecord, 'usedBy' | 'hasBearerToken'>;
type Secrets = { bearerToken?: string; env: Record<string, string>; headers: Record<string, string> };
export const mcpRegistryPath = path.join(dataRoot, 'mcp-servers.json');
export const mcpSecretsPath = path.join(dataRoot, 'mcp-secrets.json');
const sessionConfigRoot = path.join(dataRoot, 'mcp-session-config');
const builtins = new Set<string>(MCP_NAMES);
let custom = new Map<string, Stored>();
let builtinChecks = new Map<string, McpCheck>();
let secrets: Record<string, Secrets> = {};
let writes: Promise<unknown> = Promise.resolve();
const emptyCheck = (): McpCheck => ({ status: 'untested', tools: [] });

function builtinRecord(id: (typeof MCP_NAMES)[number]): Stored {
  const transport = id === 'repo-facts' || id.startsWith('bailian-') ? 'sdk' : 'stdio';
  return { id, name: id, source: 'builtin', transport, auth: 'none', envNames: [], headerNames: [],
    check: builtinChecks.get(id) ?? { status: 'untested', tools: MCP_TOOL_NAMES[id].map((name) => ({ name })) } };
}

export async function initializeMcpRegistry(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(mcpRegistryPath, 'utf8')) as Stored[];
    custom = new Map(saved.filter((item) => item.source === 'custom' && !builtins.has(item.id)).map((item) => [item.id, item]));
    builtinChecks = new Map(saved.filter((item) => item.source === 'builtin' && builtins.has(item.id)).map((item) => [item.id, item.check]));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { secrets = JSON.parse(await readFile(mcpSecretsPath, 'utf8')) as Record<string, Secrets>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await chmod(mcpSecretsPath, 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
}

async function persist(): Promise<void> {
  const publicTemp = `${mcpRegistryPath}.${randomUUID()}.tmp`;
  const secretTemp = `${mcpSecretsPath}.${randomUUID()}.tmp`;
  await writeFile(publicTemp, JSON.stringify([...MCP_NAMES.map(builtinRecord), ...custom.values()], null, 2), 'utf8');
  await writeFile(secretTemp, JSON.stringify(secrets, null, 2), { encoding: 'utf8', mode: 0o600 });
  await chmod(secretTemp, 0o600);
  await rename(secretTemp, mcpSecretsPath);
  await rename(publicTemp, mcpRegistryPath);
}
function queue<T>(change: () => Promise<T>): Promise<T> {
  const task = writes.then(change);
  writes = task.catch(() => {});
  return task;
}
export function registeredNames(): string[] { return [...MCP_NAMES, ...custom.keys()]; }
export function isRegistered(id: string): boolean { return builtins.has(id) || custom.has(id); }
export function isAssignable(id: string): boolean {
  if (builtins.has(id)) return !['failed', 'needs-auth', 'disabled'].includes(builtinChecks.get(id)?.status ?? 'untested');
  const check = custom.get(id)?.check;
  return check?.status === 'connected' && check.tools.length > 0;
}
export function toolNames(id: string): string[] {
  if (builtins.has(id)) {
    const check = builtinChecks.get(id);
    return check?.status === 'connected' ? check.tools.map((tool) => tool.name) : check && check.status !== 'untested' ? [] : [...MCP_TOOL_NAMES[id as keyof typeof MCP_TOOL_NAMES]];
  }
  return custom.get(id)?.check.status === 'connected' ? custom.get(id)!.check.tools.map((tool) => tool.name) : [];
}
export function allDiscoveredToolNames(): string[] { return registeredNames().flatMap((id) => toolNames(id).map((name) => `mcp__${id}__${name}`)); }
export async function listMcpServers(): Promise<McpServerRecord[]> {
  const agents = await loadAgents();
  return [...MCP_NAMES.map(builtinRecord), ...custom.values()].map((item) => ({
    ...item, hasBearerToken: Boolean(secrets[item.id]?.bearerToken),
    usedBy: agents.filter((agent) => agent.mcpServers.includes(item.id)).map(({ id, name, kind }) => ({ id, name, kind })),
  }));
}
export function customMcpConfig(id: string): McpServerConfig | undefined {
  const item = custom.get(id);
  if (!item) return undefined;
  const secret = secrets[id] ?? { env: {}, headers: {} };
  if (item.transport === 'stdio') return { type: 'stdio', command: item.command!, args: item.args ?? [], env: Object.fromEntries(item.envNames.map((name) => [name, secret.env[name] ?? ''])), timeout: item.timeoutMs };
  const headers = Object.fromEntries(item.headerNames.map((name) => [name, secret.headers[name] ?? '']));
  if (item.auth === 'bearer' && secret.bearerToken) headers.Authorization = `Bearer ${secret.bearerToken}`;
  if (item.transport === 'sse') return { type: 'sse', url: item.url!, headers, timeout: item.timeoutMs };
  return { type: 'http', url: item.url!, headers, timeout: item.timeoutMs };
}
export async function snapshotSessionMcp(conversationId: string, ids: string[]): Promise<Record<string, string[]>> {
  const names = Object.fromEntries(ids.map((id) => [id, toolNames(id)]));
  const configs = Object.fromEntries(ids.map((id) => [id, customMcpConfig(id)]).filter((pair): pair is [string, McpServerConfig] => Boolean(pair[1])));
  if (Object.keys(configs).length) {
    await mkdir(sessionConfigRoot, { recursive: true });
    const file = path.join(sessionConfigRoot, `${conversationId}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(configs), { encoding: 'utf8', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  }
  return names;
}
export async function loadSessionMcp(conversationId: string): Promise<Record<string, McpServerConfig>> {
  if (!/^[a-f0-9-]{36}$/.test(conversationId)) throw new Error('无效的会话 ID');
  try { return JSON.parse(await readFile(path.join(sessionConfigRoot, `${conversationId}.json`), 'utf8')) as Record<string, McpServerConfig>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
export function getMcpServer(id: string): Stored | undefined { return builtins.has(id) ? builtinRecord(id as (typeof MCP_NAMES)[number]) : custom.get(id); }
export function saveCustomMcp(input: McpServerInput, existingId?: string): Promise<void> {
  return queue(async () => {
    if (builtins.has(input.id) || (existingId ? !custom.has(existingId) || input.id !== existingId : custom.has(input.id))) throw new Error('MCP ID 已存在或无法修改');
    const previous = existingId ? secrets[existingId] : undefined;
    const nextSecrets: Secrets = {
      bearerToken: input.bearerToken || previous?.bearerToken,
      env: Object.fromEntries(input.envNames.map((name) => [name, input.envValues?.[name] || previous?.env[name] || ''])),
      headers: Object.fromEntries(input.headerNames.map((name) => [name, input.headerValues?.[name] || previous?.headers[name] || ''])),
    };
    if (input.auth !== 'bearer') delete nextSecrets.bearerToken;
    const item: Stored = { id: input.id, name: input.name, source: 'custom', transport: input.transport, auth: input.auth,
      url: input.transport === 'stdio' ? undefined : input.url, command: input.transport === 'stdio' ? input.command : undefined,
      args: input.transport === 'stdio' ? input.args ?? [] : undefined, timeoutMs: input.timeoutMs,
      envNames: input.transport === 'stdio' ? input.envNames : [], headerNames: input.transport === 'stdio' ? [] : input.headerNames,
      check: emptyCheck() };
    custom.set(item.id, item); secrets[item.id] = nextSecrets;
    await persist();
  });
}
export function deleteCustomMcp(id: string): Promise<void> {
  return queue(async () => { if (!custom.has(id)) throw new Error('自定义 MCP 不存在'); custom.delete(id); delete secrets[id]; await persist(); });
}
export function recordMcpCheck(id: string, check: McpCheck): Promise<void> {
  return queue(async () => { const item = custom.get(id); if (item) item.check = check; else if (builtins.has(id)) builtinChecks.set(id, check); else throw new Error('MCP 不存在'); await persist(); });
}
export function redactMcpSecrets(input: string): string {
  let message = input;
  for (const secret of Object.values(secrets)) for (const value of [secret.bearerToken, ...Object.values(secret.env), ...Object.values(secret.headers)]) {
    if (value && value.length >= 3) message = message.replaceAll(value, '[REDACTED]');
  }
  return message;
}
export function redactMcpError(error: unknown): string {
  return redactMcpSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000);
}
