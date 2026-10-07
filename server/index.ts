import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';
import type { AgentConfig, Bootstrap } from '../shared/types.js';
import { DEFAULT_AGENT_PERMISSIONS, MCP_NAMES, TOOL_NAMES } from '../shared/types.js';
import { clearDiscoveryCache, decide, discoverRuntime, getRun, interrupt, smokeCheck, startRun, subscribe } from './runtime.js';
import { createConversation, getConversation, initializeConversations, interruptConversation, listConversations, resolveGloballyAllowedPending, sendMessage, submitInteraction, subscribeConversation } from './conversations.js';
import { getPermissionSettings, initializePermissions, isConfigurableTool, replacePermissionSettings, revokeMcpGlobalPermissions, setToolGlobally } from './permissions.js';
import { deleteSkill, listSkills, renderSkill, renderSkillPreserving, skillName, skillPath } from './skills.js';
import { agentInstructionsPath, agentMemoryPath, fixtureRoot, initializeStorage, loadAgentInstructions, loadAgentMemory, loadAgents, projectRoot, saveAgentInstructions, saveAgentMemory, saveAgents } from './storage.js';
import { refreshConfigCatalog } from './config-catalog.js';
import { artifactById, artifactFile, artifactsForConversation, credentialStatus, getAigcSettings, initializeAigc, saveAigcSettings } from './aigc.js';
import { deleteCustomMcp, getMcpServer, initializeMcpRegistry, isAssignable, isRegistered, listMcpServers, redactMcpError, registeredNames, saveCustomMcp } from './mcp-registry.js';
import { checkMcp, completeMcpOAuth, startMcpOAuth } from './mcp-check.js';
import { SkillDraftError, changeDraftEntry, createDraft, deleteDraft, getDraft, importMarkdown, importZip, listDrafts, listPublishedFiles, publishDraft, readDraftFile, readPublishedFile, validateDraft, withDraftMutation, writeDraftFile } from './skill-drafts.js';

await initializeStorage();
await initializeMcpRegistry();
await initializePermissions();
await initializeConversations();
await initializeAigc();
await refreshConfigCatalog();
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const agentInput = z.object({
  kind: z.enum(['main', 'subagent']),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  persona: z.string().min(1).max(20_000),
  model: z.string().trim().min(1).max(160),
  maxTurns: z.number().int().min(1).max(1000),
  tools: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length),
  skills: z.array(z.string().regex(/^workbench:[a-z0-9]+(?:-[a-z0-9]+)*$/)).max(64),
  mcpServers: z.array(z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/)).max(64),
  subAgentIds: z.array(z.string()).max(12),
  memoryEnabled: z.boolean(),
  permissions: z.object({
    toolApproval: z.enum(['ask', 'allow_all']),
    pathAccess: z.enum(['workspace', 'selected', 'all']),
    additionalDirectories: z.array(z.string().trim().min(1).max(1024)).max(16),
  }).strict().default(DEFAULT_AGENT_PERMISSIONS),
}).strict();

async function validateAgentDirectories(agent: AgentConfig): Promise<string | null> {
  const { pathAccess, additionalDirectories } = agent.permissions;
  if (pathAccess !== 'selected') return null;
  if (!additionalDirectories.length) return '选择指定目录时，至少添加一个本地目录';
  for (const directory of additionalDirectories) {
    if (!path.isAbsolute(directory)) return `目录必须是绝对路径：${directory}`;
    try {
      const resolved = await realpath(directory);
      if (!(await stat(resolved)).isDirectory()) return `路径不是目录：${directory}`;
      if (resolved === path.parse(resolved).root) return '若要授权整个文件系统，请选择“所有本地路径”';
    } catch { return `目录不存在或无法访问：${directory}`; }
  }
  return null;
}
const skillInput = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64),
  description: z.string().trim().min(1).max(1024).refine((value) => !/[\r\n]/.test(value), '描述必须为单行'),
  body: z.string().trim().min(1).max(30_000),
}).strict();
const aigcSettingsInput = z.object({
  imageModel: z.enum(['qwen-image-3.0', 'qwen-image-3.0-pro', 'qwen-image-2.1-pro']),
  imageSize: z.enum(['1024*1024', '1024*768', '768*1024']),
  videoModel: z.enum(['wan3.0-video', 'wan3.0-video-prime']),
  videoDuration: z.number().int().min(2).max(15),
  videoResolution: z.enum(['480P', '720P']),
}).strict();

function validateLinks(agent: AgentConfig, agents: AgentConfig[]): string | null {
  if (new Set(agent.mcpServers).size !== agent.mcpServers.length) return 'MCP Server 不可重复';
  for (const id of agent.mcpServers) if (!isRegistered(id) || !isAssignable(id)) return `MCP 未通过连接校验或没有工具：${id}`;
  if (agent.kind === 'subagent' && agent.subAgentIds.length) return 'Sub-Agent 不能继续装配 Sub-Agent';
  if (agent.kind === 'subagent' && agent.tools.includes('Agent')) return 'Sub-Agent 不能使用 Agent 委派工具';
  if (agent.kind === 'subagent' && !agent.tools.length && !agent.skills.length && !agent.mcpServers.length) return 'Sub-Agent 至少需要一个可用工具或扩展';
  if (agent.kind === 'main' && agent.subAgentIds.length && agent.tools.every((name) => name === 'Agent') && !agent.skills.length && !agent.mcpServers.length) return '主 Agent 仅开放 Agent 工具时，当前 SDK 无法启动已装配的 Sub-Agent；请再开放至少一个读取工具或扩展';
  if (new Set(agent.subAgentIds).size !== agent.subAgentIds.length) return 'Sub-Agent 不可重复';
  for (const id of agent.subAgentIds) {
    const child = agents.find((item) => item.id === id);
    if (!child || child.kind !== 'subagent') return `无效的 Sub-Agent: ${id}`;
  }
  return null;
}

async function validateModel(model: string, previousModel?: string): Promise<string | null> {
  if (model === previousModel) return null;
  const catalog = (await discoverRuntime()).models;
  if (!catalog.length) return '暂时无法验证模型，请刷新模型列表后重试';
  return catalog.some((item) => item.id === model && item.enabled) ? null : '当前账号没有这个可用模型，请刷新模型列表';
}

async function validateSkills(skills: string[]): Promise<string | null> {
  if (new Set(skills).size !== skills.length) return 'Skill 不可重复';
  const discovered = (await discoverRuntime()).skills;
  const local = new Set((await listSkills()).map((item) => item.name));
  const missing = skills.find((name) => !local.has(name) || !discovered.includes(name));
  return missing ? `Skill 尚未被 SDK 发现：${missing}` : null;
}

function respondError(response: express.Response, error: unknown): void {
  if (error instanceof SkillDraftError) {
    response.status(error.status).json({ error: error.message });
  } else if (error instanceof z.ZodError) {
    response.status(400).json({ error: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
  } else {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

app.get('/api/bootstrap', async (_request, response) => {
  try {
    let skillNames: string[] = [];
    let discoveryError: string | undefined;
    let models: Bootstrap['models'] = [];
    let modelDiscoveryError: string | undefined;
    try {
      const discovered = await discoverRuntime();
      skillNames = discovered.skills;
      models = discovered.models;
      modelDiscoveryError = discovered.modelDiscoveryError;
    }
    catch (error) { discoveryError = error instanceof Error ? error.message : String(error); }
    const payload: Bootstrap = {
      agents: await loadAgents(),
      workspacePath: fixtureRoot,
      skillNames,
      skills: await listSkills(),
      mcpNames: registeredNames(),
      mcpServers: await listMcpServers(),
      sdkVersion: '1.0.50',
      discoveryError,
      models,
      modelDiscoveryError,
    };
    response.json(payload);
  } catch (error) { respondError(response, error); }
});

app.get('/api/config-catalog', async (_request, response) => {
  try { response.json(await refreshConfigCatalog()); }
  catch (error) { respondError(response, error); }
});

const mapInput = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/), z.string().max(8000)).optional();
const mcpInput = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,63}$/),
  name: z.string().trim().min(1).max(80),
  transport: z.enum(['stdio', 'http', 'sse']), auth: z.enum(['none', 'bearer', 'headers', 'oauth']),
  url: z.string().url().max(2000).optional(), command: z.string().trim().max(1000).optional(),
  args: z.array(z.string().max(1000)).max(32).optional(), timeoutMs: z.number().int().min(1000).max(300000).optional(),
  envNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(32),
  headerNames: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,127}$/)).max(32),
  envValues: mapInput, headerValues: mapInput, bearerToken: z.string().max(8000).optional(),
}).strict().superRefine((item, context) => {
  if (item.transport === 'stdio') {
    if (!item.command) context.addIssue({ code: 'custom', path: ['command'], message: 'stdio 需要启动命令' });
    if (item.auth !== 'none') context.addIssue({ code: 'custom', path: ['auth'], message: 'stdio 使用环境变量配置凭据' });
  } else {
    if (!item.url || !/^https?:\/\//.test(item.url)) context.addIssue({ code: 'custom', path: ['url'], message: '请输入 HTTP(S) URL' });
    else {
      const parsed = new URL(item.url);
      if (parsed.username || parsed.password || [...parsed.searchParams.keys()].some((key) => /token|key|secret|password/i.test(key))) context.addIssue({ code: 'custom', path: ['url'], message: '密钥不能放在 URL 中' });
    }
  }
});

app.get('/api/mcp-servers', async (_request, response) => {
  try { response.json(await listMcpServers()); } catch (error) { respondError(response, error); }
});
app.post('/api/mcp-servers', async (request, response) => {
  try {
    const input = mcpInput.parse(request.body);
    if (isRegistered(input.id)) return response.status(409).json({ error: 'MCP ID 已存在' });
    await saveCustomMcp(input);
    await refreshConfigCatalog();
    response.status(201).json((await listMcpServers()).find((item) => item.id === input.id));
  } catch (error) { response.status(error instanceof z.ZodError ? 400 : 500).json({ error: redactMcpError(error) }); }
});
app.put('/api/mcp-servers/:id', async (request, response) => {
  try {
    const input = mcpInput.parse(request.body);
    if (!getMcpServer(request.params.id) || getMcpServer(request.params.id)?.source !== 'custom') return response.status(404).json({ error: '自定义 MCP 不存在' });
    if (input.id !== request.params.id) return response.status(400).json({ error: 'MCP ID 创建后不可修改' });
    await saveCustomMcp(input, request.params.id);
    await revokeMcpGlobalPermissions(request.params.id);
    await refreshConfigCatalog();
    response.json((await listMcpServers()).find((item) => item.id === input.id));
  } catch (error) { response.status(error instanceof z.ZodError ? 400 : 500).json({ error: redactMcpError(error) }); }
});
app.delete('/api/mcp-servers/:id', async (request, response) => {
  try {
    const item = (await listMcpServers()).find((server) => server.id === request.params.id);
    if (!item || item.source !== 'custom') return response.status(404).json({ error: '自定义 MCP 不存在' });
    if (item.usedBy.length) return response.status(409).json({ error: '请先从 Agent 卸载此 MCP' });
    await deleteCustomMcp(item.id); await revokeMcpGlobalPermissions(item.id); await refreshConfigCatalog(); response.status(204).end();
  } catch (error) { response.status(500).json({ error: redactMcpError(error) }); }
});
app.post('/api/mcp-servers/:id/check', async (request, response) => {
  try { const check = await checkMcp(request.params.id); await refreshConfigCatalog(); response.json(check); }
  catch (error) { response.status(500).json({ error: redactMcpError(error) }); }
});
app.post('/api/mcp-servers/:id/oauth/start', async (request, response) => {
  try { response.json(await startMcpOAuth(request.params.id, `${request.protocol}://${request.get('host')}`)); }
  catch (error) { response.status(500).json({ error: redactMcpError(error) }); }
});
app.post('/api/mcp/oauth/:flowId/complete', async (request, response) => {
  try { const check = await completeMcpOAuth(request.params.flowId, z.string().url().parse(request.body?.callbackUrl)); await refreshConfigCatalog(); response.json(check); }
  catch (error) { response.status(400).json({ error: redactMcpError(error) }); }
});
app.get('/api/mcp/oauth/callback/:flowId', async (request, response) => {
  try { await completeMcpOAuth(request.params.flowId, `${request.protocol}://${request.get('host')}${request.originalUrl}`); await refreshConfigCatalog(); response.type('html').send('<!doctype html><meta charset="utf-8"><p>OAuth 授权完成。可以返回 MCP 配置页。</p>'); }
  catch (error) { response.status(400).type('text').send(redactMcpError(error)); }
});

app.get('/api/aigc-settings', (_request, response) => {
  response.json({ ...getAigcSettings(), credentialStatus: credentialStatus() });
});

app.put('/api/aigc-settings', async (request, response) => {
  try {
    const settings = await saveAigcSettings(aigcSettingsInput.parse(request.body));
    await refreshConfigCatalog();
    response.json({ ...settings, credentialStatus: credentialStatus() });
  } catch (error) { respondError(response, error); }
});

app.get('/api/skills', async (_request, response) => {
  try {
    const discovered = await discoverRuntime();
    response.json({ skills: await listSkills(), skillNames: discovered.skills });
  } catch (error) { respondError(response, error); }
});

app.get('/api/skill-drafts', async (_request, response) => { try { response.json(await listDrafts()); } catch (error) { respondError(response, error); } });
app.post('/api/skill-drafts', async (request, response) => {
  try {
    const input = z.object({ mode: z.enum(['new', 'edit']), slug: z.string().optional(), description: z.string().optional(), body: z.string().optional() }).strict().parse(request.body);
    response.status(201).json(await createDraft(input));
  } catch (error) { respondError(response, error); }
});
app.post('/api/skill-drafts/import', express.raw({ type: () => true, limit: '20mb' }), async (request, response) => {
  try {
    if (!Buffer.isBuffer(request.body)) throw new SkillDraftError('请选择 SKILL.md 或 ZIP 文件');
    response.status(201).json(request.query.format === 'zip' ? await importZip(request.body) : request.query.format === 'markdown' ? await importMarkdown(request.body) : (() => { throw new SkillDraftError('不支持的导入格式'); })());
  } catch (error) { respondError(response, error); }
});
app.get('/api/skill-drafts/:id', async (request, response) => { try { response.json(await getDraft(request.params.id)); } catch (error) { respondError(response, error); } });
function draftVersion(request: express.Request): number {
  const header = request.get('If-Match');
  if (!header || !/^\d+$/.test(header)) throw new SkillDraftError('修改草稿需要版本号 If-Match', 428);
  return Number(header);
}
app.delete('/api/skill-drafts/:id', async (request, response) => { try { await withDraftMutation(request.params.id, () => deleteDraft(request.params.id)); response.status(204).end(); } catch (error) { respondError(response, error); } });
app.get('/api/skill-drafts/:id/files', async (request, response) => {
  try {
    const relative = z.string().parse(request.query.path);
    const file = await readDraftFile(request.params.id, relative);
    if (request.query.view === 'text') {
      if (!file.text || file.content.length > 1024 * 1024) throw new SkillDraftError('此文件不能在线编辑');
      response.json({ path: relative, content: file.content.toString('utf8') });
    } else {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Type', /\.(png)$/i.test(relative) ? 'image/png' : /\.(jpe?g)$/i.test(relative) ? 'image/jpeg' : /\.(webp)$/i.test(relative) ? 'image/webp' : 'application/octet-stream');
      if (request.query.download === '1') response.setHeader('Content-Disposition', `attachment; filename="${path.basename(relative).replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
      response.send(file.content);
    }
  } catch (error) { respondError(response, error); }
});
app.put('/api/skill-drafts/:id/files', express.raw({ type: () => true, limit: '10mb' }), async (request, response) => {
  try { if (!Buffer.isBuffer(request.body)) throw new SkillDraftError('文件内容缺失'); response.json(await withDraftMutation(request.params.id, () => writeDraftFile(request.params.id, z.string().parse(request.query.path), request.body, draftVersion(request)))); }
  catch (error) { respondError(response, error); }
});
app.post('/api/skill-drafts/:id/entries', async (request, response) => {
  try { response.json(await withDraftMutation(request.params.id, () => changeDraftEntry(request.params.id, z.object({ action: z.enum(['mkdir', 'create', 'rename', 'delete']), path: z.string(), newPath: z.string().optional() }).strict().parse(request.body), draftVersion(request)))); }
  catch (error) { respondError(response, error); }
});
app.post('/api/skill-drafts/:id/validate', async (request, response) => { try { response.json(await withDraftMutation(request.params.id, () => validateDraft(request.params.id, draftVersion(request)))); } catch (error) { respondError(response, error); } });
app.post('/api/skill-drafts/:id/publish', async (request, response) => {
  try { const skill = await withDraftMutation(request.params.id, () => publishDraft(request.params.id, draftVersion(request))); response.json({ skill }); }
  catch (error) { respondError(response, error); }
});
app.get('/api/skills/:slug/files', async (request, response) => {
  try {
    const relative = z.string().parse(request.query.path);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Type', /\.(png)$/i.test(relative) ? 'image/png' : /\.(jpe?g)$/i.test(relative) ? 'image/jpeg' : /\.(webp)$/i.test(relative) ? 'image/webp' : 'application/octet-stream');
    if (request.query.download === '1') response.setHeader('Content-Disposition', `attachment; filename="${path.basename(relative).replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    (await readPublishedFile(request.params.slug, relative)).pipe(response);
  } catch (error) { respondError(response, error); }
});
app.get('/api/skills/:slug/tree', async (request, response) => { try { response.json(await listPublishedFiles(request.params.slug)); } catch (error) { respondError(response, error); } });

app.post('/api/skills', async (request, response) => {
  try {
    const input = skillInput.parse(request.body);
    if ((await listSkills()).some((item) => item.slug === input.slug)) return response.status(409).json({ error: 'Skill 名称已存在' });
    const pending = await createDraft({ mode: 'new' });
    await writeDraftFile(pending.id, 'SKILL.md', Buffer.from(renderSkill(input.slug, input.description, input.body)));
    const skill = await publishDraft(pending.id);
    response.status(201).json({ skill, discovered: true });
  } catch (error) { respondError(response, error); }
});

app.put('/api/skills/:slug', async (request, response) => {
  try {
    const input = skillInput.parse({ ...request.body, slug: request.params.slug });
    if (!(await listSkills()).some((item) => item.slug === input.slug)) return response.status(404).json({ error: 'Skill 不存在' });
    const pending = await createDraft({ mode: 'edit', slug: input.slug });
    const original = await readFile(skillPath(input.slug), 'utf8');
    await writeDraftFile(pending.id, 'SKILL.md', Buffer.from(renderSkillPreserving(original, input.slug, input.description, input.body)));
    const skill = await publishDraft(pending.id);
    response.json({ skill, discovered: true });
  } catch (error) { respondError(response, error); }
});

app.delete('/api/skills/:slug', async (request, response) => {
  try {
    const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64).parse(request.params.slug);
    if (!(await listSkills()).some((item) => item.slug === slug)) return response.status(404).json({ error: 'Skill 不存在' });
    if (slug === 'repo-review') return response.status(400).json({ error: '示例 Skill 不支持删除' });
    if ((await loadAgents()).some((agent) => agent.skills.includes(skillName(slug)))) return response.status(409).json({ error: '请先从所有 Agent 中移除这个 Skill' });
    await deleteSkill(slug);
    await refreshConfigCatalog();
    clearDiscoveryCache();
    response.status(204).end();
  } catch (error) { respondError(response, error); }
});

app.get('/api/models', async (_request, response) => {
  try {
    const discovered = await discoverRuntime(true);
    response.json({ models: discovered.models, error: discovered.modelDiscoveryError });
  } catch (error) { respondError(response, error); }
});

app.post('/api/agents', async (request, response) => {
  try {
    const input = agentInput.parse(request.body);
    const agents = await loadAgents();
    const agent: AgentConfig = { ...input, id: randomUUID(), permissions: { ...input.permissions, additionalDirectories: input.permissions.pathAccess === 'selected' ? [...new Set(input.permissions.additionalDirectories)] : [] } };
    const directoryProblem = await validateAgentDirectories(agent);
    if (directoryProblem) return response.status(400).json({ error: directoryProblem });
    const modelProblem = await validateModel(agent.model);
    if (modelProblem) return response.status(400).json({ error: modelProblem });
    const skillProblem = await validateSkills(agent.skills);
    if (skillProblem) return response.status(400).json({ error: skillProblem });
    const problem = validateLinks(agent, agents);
    if (problem) return response.status(400).json({ error: problem });
    agents.push(agent);
    await saveAgents(agents);
    await refreshConfigCatalog();
    response.status(201).json(agent);
  } catch (error) { respondError(response, error); }
});

app.put('/api/agents/:id', async (request, response) => {
  try {
    const input = agentInput.parse(request.body);
    const agents = await loadAgents();
    const index = agents.findIndex((item) => item.id === request.params.id);
    if (index < 0) return response.status(404).json({ error: 'Agent 不存在' });
    const agent: AgentConfig = { ...input, id: agents[index].id, permissions: { ...input.permissions, additionalDirectories: input.permissions.pathAccess === 'selected' ? [...new Set(input.permissions.additionalDirectories)] : [] } };
    const directoryProblem = await validateAgentDirectories(agent);
    if (directoryProblem) return response.status(400).json({ error: directoryProblem });
    const modelProblem = await validateModel(agent.model, agents[index].model);
    if (modelProblem) return response.status(400).json({ error: modelProblem });
    const skillProblem = await validateSkills(agent.skills);
    if (skillProblem) return response.status(400).json({ error: skillProblem });
    const candidate = agents.map((item, i) => i === index ? agent : item);
    const problem = validateLinks(agent, candidate);
    if (problem) return response.status(400).json({ error: problem });
    if (agent.kind === 'main' && candidate.some((item) => item.subAgentIds.includes(agent.id))) return response.status(400).json({ error: '此 Agent 已被装配为 Sub-Agent，请先从父 Agent 中移除' });
    await saveAgents(candidate);
    await refreshConfigCatalog();
    response.json(agent);
  } catch (error) { respondError(response, error); }
});

app.delete('/api/agents/:id', async (request, response) => {
  try {
    const agents = await loadAgents();
    if (!agents.some((agent) => agent.id === request.params.id)) return response.status(404).json({ error: 'Agent 不存在' });
    const next = agents.filter((agent) => agent.id !== request.params.id).map((agent) => ({ ...agent, subAgentIds: agent.subAgentIds.filter((id) => id !== request.params.id) }));
    await saveAgents(next);
    await refreshConfigCatalog();
    response.status(204).end();
  } catch (error) { respondError(response, error); }
});

app.get('/api/agents/:id/instructions', async (request, response) => {
  try {
    const agents = await loadAgents();
    if (!agents.some((agent) => agent.id === request.params.id)) return response.status(404).json({ error: 'Agent 不存在' });
    response.json({ content: await loadAgentInstructions(request.params.id), path: agentInstructionsPath(request.params.id) });
  } catch (error) { respondError(response, error); }
});

app.put('/api/agents/:id/instructions', async (request, response) => {
  const parsed = z.object({ content: z.string().max(30_000) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: '无效的 AGENTS.md 内容' });
  try {
    const agents = await loadAgents();
    if (!agents.some((agent) => agent.id === request.params.id)) return response.status(404).json({ error: 'Agent 不存在' });
    await saveAgentInstructions(request.params.id, parsed.data.content);
    await refreshConfigCatalog();
    response.json({ ok: true, path: agentInstructionsPath(request.params.id) });
  }
  catch (error) { respondError(response, error); }
});

app.get('/api/agents/:id/memory', async (request, response) => {
  try {
    const agents = await loadAgents();
    if (!agents.some((agent) => agent.id === request.params.id)) return response.status(404).json({ error: 'Agent 不存在' });
    response.json({ content: await loadAgentMemory(request.params.id), path: agentMemoryPath(request.params.id) });
  } catch (error) { respondError(response, error); }
});

app.put('/api/agents/:id/memory', async (request, response) => {
  const parsed = z.object({ content: z.string().max(30_000) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: '无效的记忆内容' });
  try {
    const agents = await loadAgents();
    if (!agents.some((agent) => agent.id === request.params.id)) return response.status(404).json({ error: 'Agent 不存在' });
    await saveAgentMemory(request.params.id, parsed.data.content);
    await refreshConfigCatalog();
    response.json({ ok: true, path: agentMemoryPath(request.params.id) });
  } catch (error) { respondError(response, error); }
});

const conversationInput = z.object({ agentId: z.string(), content: z.string().trim().min(1).max(12_000) }).strict();
const messageInput = z.object({ content: z.string().trim().min(1).max(12_000) }).strict();
const permissionInput = z.object({ alwaysAllowTools: z.array(z.string()).max(100) }).strict();
const permissionToolInput = z.object({ toolName: z.string(), allowed: z.boolean() }).strict();
const interactionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('allow') }).strict(),
  z.object({ action: z.literal('allow_session_tool') }).strict(),
  z.object({ action: z.literal('allow_session_category') }).strict(),
  z.object({ action: z.literal('allow_global_tool') }).strict(),
  z.object({ action: z.literal('deny') }).strict(),
  z.object({ action: z.literal('answer'), answers: z.record(z.string(), z.string()) }).strict(),
]);

app.get('/api/permissions', (_request, response) => response.json(getPermissionSettings()));

app.put('/api/permissions', async (request, response) => {
  const parsed = permissionInput.safeParse(request.body);
  if (!parsed.success || parsed.data.alwaysAllowTools.some((name) => !isConfigurableTool(name))) return response.status(400).json({ error: '包含不支持全局授权的工具' });
  try {
    const before = new Set(getPermissionSettings().alwaysAllowTools);
    const updated = await replacePermissionSettings(parsed.data.alwaysAllowTools);
    await refreshConfigCatalog();
    for (const name of updated.alwaysAllowTools) if (!before.has(name)) resolveGloballyAllowedPending(name);
    response.json(updated);
  } catch (error) { respondError(response, error); }
});

app.patch('/api/permissions', async (request, response) => {
  const parsed = permissionToolInput.safeParse(request.body);
  if (!parsed.success || !isConfigurableTool(parsed.data.toolName)) return response.status(400).json({ error: '不支持此工具的全局授权' });
  try {
    const updated = await setToolGlobally(parsed.data.toolName, parsed.data.allowed);
    await refreshConfigCatalog();
    if (parsed.data.allowed) resolveGloballyAllowedPending(parsed.data.toolName);
    response.json(updated);
  } catch (error) { respondError(response, error); }
});

app.get('/api/conversations', (request, response) => {
  response.json(listConversations(typeof request.query.agentId === 'string' ? request.query.agentId : undefined).map((item) => ({
    id: item.id, agentId: item.agentId, agentName: item.agentName, status: item.status,
    createdAt: item.createdAt, updatedAt: item.updatedAt,
    firstMessage: item.messages.find((message) => message.role === 'user')?.content.slice(0, 100) ?? '',
  })));
});

app.post('/api/conversations', async (request, response) => {
  try {
    const input = conversationInput.parse(request.body);
    const item = await createConversation(input.agentId, input.content);
    response.status(201).json({ ...item, artifacts: artifactsForConversation(item.id) });
  } catch (error) { respondError(response, error); }
});

app.get('/api/conversations/:id', (request, response) => {
  const item = getConversation(request.params.id);
  if (!item) return response.status(404).json({ error: '会话不存在' });
  response.json({ ...item, artifacts: artifactsForConversation(item.id) });
});

app.post('/api/conversations/:id/messages', async (request, response) => {
  try {
    const input = messageInput.parse(request.body);
    const item = await sendMessage(request.params.id, input.content);
    if (!item) return response.status(404).json({ error: '会话不存在' });
    response.status(201).json({ ...item, artifacts: artifactsForConversation(item.id) });
  } catch (error) {
    if (error instanceof Error && error.message === '当前轮仍在执行或等待决策') return response.status(409).json({ error: error.message });
    if (error instanceof Error && error.message.startsWith('演示存档不能续接')) return response.status(409).json({ error: error.message });
    respondError(response, error);
  }
});

app.get('/api/artifacts/:id', (request, response) => {
  const artifact = artifactById(request.params.id);
  const file = artifact && artifactFile(artifact);
  if (!artifact || !file) return response.status(404).json({ error: '产物不存在或尚未完成' });
  response.type(artifact.mimeType ?? (artifact.kind === 'image' ? 'image/png' : 'video/mp4'));
  response.sendFile(file, (error) => {
    if (error && !response.headersSent) response.status(404).json({ error: '产物文件不存在' });
  });
});

app.get('/api/conversations/:id/events', (request, response) => {
  const after = Number(request.query.after ?? request.headers['last-event-id'] ?? 0);
  if (!subscribeConversation(request.params.id, response, Number.isFinite(after) ? after : 0)) response.status(404).json({ error: '会话不存在' });
});

app.post('/api/conversations/:id/interactions/:interactionId', async (request, response) => {
  const parsed = interactionInput.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: '无效的决策数据' });
  try {
    const outcome = await submitInteraction(request.params.id, request.params.interactionId, parsed.data);
    if (outcome === 'missing') return response.status(404).json({ error: '会话不存在' });
    if (outcome === 'stale') return response.status(409).json({ error: '请求已结束或被其他页面处理' });
    if (outcome === 'invalid') return response.status(400).json({ error: '答案不完整或决策类型不匹配' });
    response.json({ ok: true });
  } catch (error) { respondError(response, error); }
});

app.post('/api/conversations/:id/interrupt', async (request, response) => {
  try {
    if (!await interruptConversation(request.params.id)) return response.status(409).json({ error: '当前会话没有正在执行的轮次' });
    response.json({ ok: true });
  } catch (error) { respondError(response, error); }
});

app.post('/api/runs', async (request, response) => {
  const parsed = z.object({ agentId: z.string(), prompt: z.string().trim().min(1).max(12_000) }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: '请选择 Agent 并输入任务' });
  try { response.status(201).json(await startRun(parsed.data.agentId, parsed.data.prompt)); }
  catch (error) { respondError(response, error); }
});

app.post('/api/smoke', async (_request, response) => {
  try { response.status(201).json(await smokeCheck()); }
  catch (error) { respondError(response, error); }
});

app.get('/api/runs/:id', (request, response) => {
  const run = getRun(request.params.id);
  if (!run) return response.status(404).json({ error: '运行不存在' });
  response.json(run);
});

app.get('/api/runs/:id/events', (request, response) => {
  const after = Number(request.query.after ?? request.headers['last-event-id'] ?? 0);
  if (!subscribe(request.params.id, response, Number.isFinite(after) ? after : 0)) response.status(404).json({ error: '运行不存在' });
});

app.post('/api/runs/:id/approvals/:approvalId', (request, response) => {
  const decision = request.body?.decision;
  if (decision !== 'allow' && decision !== 'deny') return response.status(400).json({ error: '决策必须为 allow 或 deny' });
  if (!decide(request.params.id, request.params.approvalId, decision)) return response.status(404).json({ error: '审批已过期或不存在' });
  response.json({ ok: true });
});

app.post('/api/runs/:id/interrupt', async (request, response) => {
  try {
    if (!await interrupt(request.params.id)) return response.status(404).json({ error: '运行不存在或已结束' });
    response.json({ ok: true });
  } catch (error) { respondError(response, error); }
});

app.use(express.static(path.join(projectRoot, 'dist')));
app.get(/^(?!\/api\/).*/, (_request, response) => response.sendFile(path.join(projectRoot, 'dist', 'index.html')));
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const code = (error as { type?: string }).type;
  if (code === 'entity.too.large') response.status(413).json({ error: '上传文件超过大小限制' });
  else respondError(response, error);
});

const port = Number(process.env.PORT ?? 8787);
app.listen(port, '127.0.0.1', () => {
  console.log(`Qoder Agent Workbench API: http://127.0.0.1:${port}`);
});
