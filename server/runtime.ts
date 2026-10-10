import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import { createSdkMcpServer, qodercliAuth, query, tool, type McpServerConfig, type Query } from '@qoder-ai/qoder-agent-sdk';
import { z } from 'zod';
import type { AgentConfig, ModelOption, RunEvent, RunSummary } from '../shared/types.js';
import { DEFAULT_ALLOWED_TOOLS, MCP_NAME } from '../shared/types.js';
import { isGloballyAllowed } from './permissions.js';
import { additionalDirectories, agentPermissions, callingAgent, isDirectoryApproval, shouldAutoAllowAgentTool } from './agent-policy.js';
import { agentMemoryPath, fixtureRoot, loadAgentInstructions, loadAgentMemory, loadAgents, pluginRoot, projectRoot } from './storage.js';
import { generate } from './aigc.js';
import { browserService } from './browser-service.js';
import { loadJdTask } from './jd-shop.js';
import { customMcpConfig, redactMcpError, redactMcpSecrets, toolNames } from './mcp-registry.js';

type PendingApproval = {
  resolve: (decision: 'allow' | 'deny') => void;
  timer: ReturnType<typeof setTimeout>;
};

type LiveRun = {
  summary: RunSummary;
  listeners: Set<Response>;
  pending: Map<string, PendingApproval>;
  query?: Query;
  hadTextDelta: boolean;
};

const runs = new Map<string, LiveRun>();
const MAX_EVENTS = 500;
let discoveryCache: { at: number; skills: string[]; models: ModelOption[]; modelDiscoveryError?: string } | null = null;
export function clearDiscoveryCache(): void { discoveryCache = null; }

export async function discoverRuntime(force = false): Promise<Omit<NonNullable<typeof discoveryCache>, 'at'>> {
  if (!force && discoveryCache && Date.now() - discoveryCache.at < 60_000) return discoveryCache;
  const q = query({
    prompt: (async function* () {})(),
    options: {
      auth: qodercliAuth(), cwd: fixtureRoot, settingSources: [],
      plugins: [{ type: 'local', path: pluginRoot }],
      skills: 'all', tools: [],
    },
  });
  try {
    const init = await q.initializationResult();
    const skills = (init.skills ?? []).map((item) => item.name).filter((name) => name.startsWith('workbench:'));
    let models: ModelOption[] = [];
    let modelDiscoveryError: string | undefined;
    try {
      const available = await q.getAvailableModels();
      models = available.map((item) => ({
        id: item.value,
        name: item.displayName || item.value,
        source: item.serverScene === 'assistant' ? 'qoder' as const : 'custom' as const,
        enabled: item.isEnabled !== false,
      }));
      if (!models.length) modelDiscoveryError = '当前账号暂时没有返回可用模型';
    } catch (error) { modelDiscoveryError = error instanceof Error ? error.message : String(error); }
    discoveryCache = { at: Date.now(), skills, models, modelDiscoveryError };
    return discoveryCache;
  } finally { await q.close(); }
}

function emit(run: LiveRun, event: Omit<RunEvent, 'id' | 'at'>): void {
  const next: RunEvent = {
    id: (run.summary.events.at(-1)?.id ?? 0) + 1,
    at: new Date().toISOString(),
    ...event,
  };
  run.summary.events.push(next);
  if (run.summary.events.length > MAX_EVENTS) run.summary.events.shift();
  for (const response of run.listeners) response.write(`id: ${next.id}\ndata: ${JSON.stringify(next)}\n\n`);
}

export function compact(value: unknown, limit = 700): string {
  const raw = redactMcpSecrets(typeof value === 'string' ? value : JSON.stringify(value));
  return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
}

function mcpServer() {
  return createSdkMcpServer({
    name: MCP_NAME,
    version: '0.1.0',
    tools: [tool(
      'repository_facts',
      'Return deterministic facts about the Agent Workbench example repository.',
      { topic: z.string().optional() },
      async ({ topic }) => ({
        content: [{ type: 'text', text: JSON.stringify({
          topic: topic ?? 'overview',
          repository: 'Agent Workbench example repository',
          files: ['AGENTS.md', 'calculator.ts'],
          knownEdgeCase: 'average([]) divides zero by zero and returns NaN',
        }) }],
      }),
      { annotations: { readOnlyHint: true }, permissionPolicy: 'always_allow' },
    )],
  });
}

export function configuredMcpServers(names: Set<string>, mediaContext?: { conversationId: string; turnId: () => string }, overrides: Record<string, McpServerConfig> = {}): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  if (names.has(MCP_NAME)) servers[MCP_NAME] = mcpServer();
  if (names.has('playwright')) servers.playwright = {
    type: 'stdio',
    command: process.execPath,
    args: [path.join(projectRoot, 'node_modules/@playwright/mcp/cli.js'), '--browser=chrome', '--headless', '--isolated'],
  };
  if (names.has('chrome-devtools')) servers['chrome-devtools'] = {
    type: 'stdio',
    command: process.execPath,
    args: [path.join(projectRoot, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'), '--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux', `--workspace=${projectRoot}`],
  };
  if (names.has('bailian-image')) servers['bailian-image'] = createSdkMcpServer({
    name: 'bailian-image', version: '1.0.0', tools: [tool('generate_image', 'Generate one image from a text prompt and save it as a local artifact.', { prompt: z.string().trim().min(1).max(4000) }, async ({ prompt }) => {
      if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '请使用多轮运行台生成图片' }] };
      const result = await generate('image', mediaContext.conversationId, mediaContext.turnId(), prompt);
      return { isError: result.status !== 'succeeded', content: [{ type: 'text', text: JSON.stringify({ artifactId: result.id, status: result.status, model: result.model, error: result.error }) }] };
    })],
  });
  if (names.has('bailian-video')) servers['bailian-video'] = createSdkMcpServer({
    name: 'bailian-video', version: '1.0.0', tools: [tool('generate_video', 'Generate one short video from a text prompt and save it as a local artifact. This may take several minutes.', { prompt: z.string().trim().min(1).max(4000) }, async ({ prompt }) => {
      if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '请使用多轮运行台生成视频' }] };
      const result = await generate('video', mediaContext.conversationId, mediaContext.turnId(), prompt);
      return { isError: result.status !== 'succeeded', content: [{ type: 'text', text: JSON.stringify({ artifactId: result.id, status: result.status, model: result.model, taskId: result.taskId, error: result.error }) }] };
    })],
  });
  if (names.has('jd-browser')) servers['jd-browser'] = createSdkMcpServer({
    name: 'jd-browser', version: '1.0.0', tools: [
      tool('browser_search_products', 'Search JD China mall in a hidden Browserless browser, request human handoff only if JD requires login or risk verification. Collect up to 20 product names, prices and promotions; report whether sales sorting was actually applied.', { keyword: z.string().trim().min(1).max(80) }, async ({ keyword }) => {
        if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '请在多轮运行台搜索京东商品。' }] };
        try {
          const { task, browser } = await browserService.searchProducts(mediaContext.conversationId, keyword);
          return { content: [{ type: 'text', text: JSON.stringify({ taskId: task.id, status: task.status, browserState: browser.state,
            loginVerified: browser.loginVerified, sortApplied: task.sortApplied, products: task.products.map(({ rank, sku, name, brand, price, promotion, commentCount, url }) => ({ rank, sku, name, brand, price, promotion, commentCount, url })), note: task.note }) }] };
        } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
      }),
      tool('browser_collect_reviews', 'Collect visible high-rating review excerpts for the next small batch of products in the saved JD search task. Progress survives cloud-browser timeouts.', { maxProducts: z.number().int().min(1).max(5).default(3) }, async ({ maxProducts }) => {
        if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '没有会话上下文。' }] };
        try {
          const { task, browser } = await browserService.collectReviews(mediaContext.conversationId, maxProducts);
          return { content: [{ type: 'text', text: JSON.stringify({ taskId: task.id, status: task.status, browserState: browser.state,
            nextReviewIndex: task.nextReviewIndex, total: task.products.length,
            products: task.products.slice(Math.max(0, task.nextReviewIndex - maxProducts), task.nextReviewIndex).map(({ rank, name, url, reviews }) => ({ rank, name, url, reviews })), note: task.note }) }] };
        } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
      }),
      tool('browser_task_status', 'Read the saved JD product and review collection progress without controlling the browser.', {}, async () => {
        if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '没有会话上下文。' }] };
        const task = await loadJdTask(mediaContext.conversationId);
        return { content: [{ type: 'text', text: JSON.stringify(task ?? { status: 'not-started' }) }] };
      }, { annotations: { readOnlyHint: true }, permissionPolicy: 'always_allow' }),
      tool('browser_open', 'Open the JD China mall in a hidden Browserless cloud browser. Use browser_search_products for research; this tool alone does not hand control to the user.', {}, async () => {
        if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '请在多轮运行台使用京东云浏览器。' }] };
        try {
          const state = await browserService.open(mediaContext.conversationId);
          return { content: [{ type: 'text', text: JSON.stringify({ sessionId: state.sessionId, state: state.state, pageUrl: state.pageUrl, profileStatus: state.profileStatus }) }] };
        } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
      }),
      tool('browser_get_state', 'Read the current JD cloud browser state without operating its page.', {}, async () => {
        if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '没有会话上下文。' }] };
        try { return { content: [{ type: 'text', text: JSON.stringify(browserService.getState(mediaContext.conversationId)) }] }; }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
      }, { annotations: { readOnlyHint: true }, permissionPolicy: 'always_allow' }),
      tool('browser_handoff', 'Show the same cloud browser in the Web workbench only when JD has requested a human login, slider, or risk check. Returns immediately; stop this turn and wait.', {}, async () => {
        if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '没有会话上下文。' }] };
        try {
          const state = await browserService.handoff(mediaContext.conversationId);
          return { content: [{ type: 'text', text: JSON.stringify({ sessionId: state.sessionId, state: state.state, instruction: state.state === 'COMPLETED' ? '已从保存档案恢复登录，无需人工接管。' : '已交给用户；请停止本轮并等待系统核验结果，勿再次操作浏览器。' }) }] };
        } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
      }),
      tool('browser_check_login', 'Read the verified JD login result; user Done alone is not proof of login.', {}, async () => {
        if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '没有会话上下文。' }] };
        try {
          const state = browserService.getState(mediaContext.conversationId);
          const conclusion = state.loginVerified ? 'confirmed' : state.state === 'FAILED' ? 'not-confirmed' : 'unverified';
          return { content: [{ type: 'text', text: JSON.stringify({ state: state.state, conclusion, verified: state.loginVerified === true, message: state.message, verification: state.verification }) }] };
        } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
      }, { annotations: { readOnlyHint: true }, permissionPolicy: 'always_allow' }),
      tool('browser_close', 'Close this conversation’s Browserless session only when the user asks to end it.', {}, async () => {
        if (!mediaContext) return { isError: true, content: [{ type: 'text', text: '没有会话上下文。' }] };
        try {
          const state = await browserService.close(mediaContext.conversationId, 'agent');
          return { content: [{ type: 'text', text: JSON.stringify({ state: state.state }) }] };
        } catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }; }
      }),
    ],
  });
  for (const name of names) {
    const custom = overrides[name] ?? customMcpConfig(name);
    if (custom) servers[name] = custom;
  }
  return servers;
}

export function toolList(agent: AgentConfig, snapshot?: Record<string, string[]>): string[] {
  const names = agent.kind === 'subagent' ? agent.tools.filter((name) => name !== 'Agent') : [...agent.tools];
  if (agent.skills.length) names.push('Skill');
  for (const server of agent.mcpServers) {
    for (const toolName of snapshot?.[server] ?? toolNames(server)) names.push(`mcp__${server}__${toolName}`);
  }
  return names;
}

export function runtimeName(agent: AgentConfig): string {
  return agent.id.replace(/[^a-zA-Z0-9_-]/g, '-');
}

export async function memoryDir(agent: AgentConfig): Promise<string> {
  const directory = path.dirname(agentMemoryPath(agent.id));
  await mkdir(directory, { recursive: true });
  const index = path.join(directory, 'INDEX.md');
  try { await readFile(index, 'utf8'); } catch { await writeFile(index, `# ${agent.name} · 长期记忆\n`, 'utf8'); }
  return directory;
}

export async function definition(agent: AgentConfig, instructions?: string, mcpToolNames?: Record<string, string[]>) {
  let prompt = `${agent.persona}\n\nProject rules for this Agent (AGENTS.md):\n${instructions ?? await loadAgentInstructions(agent.id)}`;
  if (agent.memoryEnabled) {
    await memoryDir(agent);
    prompt += `\n\nPersistent notes for this Agent (INDEX.md):\n${await loadAgentMemory(agent.id)}`;
  }
  return {
    description: agent.description,
    prompt,
    model: agent.model,
    maxTurns: agent.maxTurns,
    tools: toolList(agent, mcpToolNames).filter((name) => name !== 'Agent'),
    skills: agent.skills,
    mcpServers: agent.mcpServers,
    permissionMode: 'default' as const,
  };
}

function digestMessage(run: LiveRun, message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const msg = message as Record<string, any>;
  if (msg.type === 'stream_event') {
    const delta = msg.event?.delta;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      if (msg.parent_tool_use_id) return;
      run.hadTextDelta = true;
      emit(run, { type: 'text', detail: delta.text });
    }
    return;
  }
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block?.type === 'tool_use') emit(run, { type: 'tool', label: block.name, detail: compact(block.input), toolName: block.name });
    }
    return;
  }
  if (msg.type === 'user') {
    const blocks = msg.message?.content ?? [];
    for (const block of blocks) {
      if (block?.type === 'tool_result') emit(run, { type: 'tool', label: '工具结果', detail: compact(block.content) });
    }
    return;
  }
  if (msg.type === 'system' && (msg.subtype === 'memory_generation' || msg.subtype === 'memory_consumption')) return;
  if (msg.type === 'task_started' || msg.type === 'task_progress' || msg.type === 'task_notification') {
    emit(run, { type: 'status', label: msg.type, detail: compact(msg, 350) });
    return;
  }
  if (msg.type === 'result') {
    if (!run.hadTextDelta && typeof msg.result === 'string') emit(run, { type: 'text', detail: msg.result });
    if (typeof msg.total_credits === 'number') emit(run, { type: 'usage', label: '本次会话累计 Credits', credits: msg.total_credits });
    const usedModels = Object.keys(msg.modelUsage ?? {});
    if (usedModels.length) emit(run, { type: 'diagnostic', label: '实际使用模型', detail: usedModels.join(', ') });
    if (msg.is_error) {
      run.summary.status = 'error';
      emit(run, { type: 'error', detail: compact(msg.errors ?? msg.subtype) });
    }
  }
}

export function getRun(id: string): RunSummary | undefined { return runs.get(id)?.summary; }

export function subscribe(id: string, response: Response, after = 0): boolean {
  const run = runs.get(id);
  if (!run) return false;
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  for (const event of run.summary.events) if (event.id > after) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  run.listeners.add(response);
  response.on('close', () => run.listeners.delete(response));
  return true;
}

export function decide(id: string, approvalId: string, decision: 'allow' | 'deny'): boolean {
  const run = runs.get(id);
  const pending = run?.pending.get(approvalId);
  if (!run || !pending) return false;
  clearTimeout(pending.timer);
  run.pending.delete(approvalId);
  pending.resolve(decision);
  emit(run, { type: 'status', label: '审批结果', detail: decision === 'allow' ? '已允许一次' : '已拒绝' });
  return true;
}

export async function interrupt(id: string): Promise<boolean> {
  const run = runs.get(id);
  if (!run || run.summary.status !== 'running') return false;
  for (const [approvalId] of run.pending) decide(id, approvalId, 'deny');
  if (run.query) await run.query.interrupt();
  run.summary.status = 'interrupted';
  emit(run, { type: 'status', label: '已中断' });
  return true;
}

export async function startRun(agentId: string, prompt: string): Promise<RunSummary> {
  const agents = await loadAgents();
  const selected = agents.find((item) => item.id === agentId);
  if (!selected) throw new Error('Agent 不存在');
  const id = randomUUID();
  const summary: RunSummary = { id, agentId, prompt, status: 'running', startedAt: new Date().toISOString(), events: [] };
  const run: LiveRun = { summary, listeners: new Set(), pending: new Map(), hadTextDelta: false };
  runs.set(id, run);
  emit(run, { type: 'status', label: '正在初始化 Qoder SDK' });
  void execute(run, selected, agents, prompt);
  return summary;
}

async function execute(run: LiveRun, selected: AgentConfig, agents: AgentConfig[], prompt: string): Promise<void> {
  try {
    const children = selected.kind === 'main' ? agents.filter((item) => selected.subAgentIds.includes(item.id)) : [];
    const definitions = Object.fromEntries(await Promise.all(children.map(async (child) => [runtimeName(child), await definition(child)] as const)));
    const mcpNames = new Set([...selected.mcpServers, ...children.flatMap((child) => child.mcpServers)]);
    const mcpServers = configuredMcpServers(mcpNames);
    const memoryPath = selected.memoryEnabled ? await memoryDir(selected) : null;
    const memory = memoryPath ? {
      mode: 'custom' as const,
      userScope: false,
      projectScope: false,
      generation: {
        roots: [{ id: 'agent', path: memoryPath, indexFile: 'INDEX.md' }],
        onResult: (result: unknown) => emit(run, { type: 'memory', label: '自动记忆写入', detail: compact(result) }),
      },
      consumption: {
        files: [{ id: 'agent-memory', path: path.join(memoryPath, 'INDEX.md') }],
        onResult: (result: unknown) => emit(run, { type: 'memory', label: '记忆加载', detail: compact(result) }),
      },
    } : undefined;
    const toolNames = toolList(selected);
    if (children.length && !toolNames.includes('Agent')) toolNames.push('Agent');
    emit(run, { type: 'diagnostic', label: 'SDK 最大轮数', detail: String(selected.maxTurns) });
    const q = query({
      prompt,
      options: {
        auth: qodercliAuth(),
        cwd: fixtureRoot,
        additionalDirectories: additionalDirectories(selected),
        settingSources: [],
        plugins: [{ type: 'local', path: pluginRoot }],
        agents: definitions,
        systemPrompt: { type: 'preset', preset: 'qodercli', append: `${selected.persona}\n\nProject rules for this Agent (AGENTS.md):\n${await loadAgentInstructions(selected.id)}` },
        model: selected.model,
        maxTurns: selected.maxTurns,
        tools: toolNames,
        allowedTools: toolNames.filter((name) => (DEFAULT_ALLOWED_TOOLS as readonly string[]).includes(name)),
        mcpServers,
        allowedMcpServerNames: [...mcpNames].filter((name) => name !== MCP_NAME),
        strictMcpConfig: true,
        skills: selected.skills,
        memory,
        includePartialMessages: true,
        permissionMode: 'default',
        canUseTool: async (toolName, input, context) => {
          if (toolName === 'AskUserQuestion') return { behavior: 'deny', message: '此原型暂不支持 Agent 向用户提问。' };
          if (toolName.includes('browser_run_code_unsafe')) return { behavior: 'deny', message: '浏览器测试不开放在 MCP Server 进程中执行任意代码。' };
          const pathBlocked = isDirectoryApproval(context.blockedPath, context.decisionReason) && agentPermissions(selected).pathAccess !== 'all';
          if (!pathBlocked && (shouldAutoAllowAgentTool(callingAgent(selected, children, context.agentID, toolName), pathBlocked) || isGloballyAllowed(toolName))) return { behavior: 'allow', updatedInput: input };
          const approvalId = randomUUID();
          emit(run, { type: 'approval', label: context.title ?? toolName, detail: `${pathBlocked ? `目录授权待确认：${context.blockedPath ?? context.decisionReason}\n` : ''}${compact(input)}`, approvalId, toolName });
          const decision = await new Promise<'allow' | 'deny'>((resolve) => {
            const timer = setTimeout(() => {
              run.pending.delete(approvalId);
              resolve('deny');
            }, 120_000);
            run.pending.set(approvalId, { resolve, timer });
            context.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              run.pending.delete(approvalId);
              resolve('deny');
            }, { once: true });
          });
          return decision === 'allow' ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: '用户拒绝了这次操作。' };
        },
      },
    });
    run.query = q;
    const init = await q.initializationResult();
    emit(run, { type: 'diagnostic', label: '配置模型', detail: selected.model });
    emit(run, { type: 'diagnostic', label: '初始化', detail: compact({ agents: init.agents.map((a) => a.name), skills: init.skills?.map((s) => s.name), memory: init.memory, capabilities: init.capabilities }, 1200) });
    if (selected.skills.some((skill) => !init.skills?.some((item) => item.name === skill))) emit(run, { type: 'error', detail: '配置的 Skill 未被 SDK 发现，请检查插件路径。' });
    for await (const message of q) {
      digestMessage(run, message);
      if (message.type === 'result') {
        if (selected.memoryEnabled) {
          await Promise.race([
            q.flushMemory(),
            new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
          ]);
        }
        break;
      }
    }
    await q.close();
    if (run.summary.status === 'running') run.summary.status = 'done';
    emit(run, { type: 'done', label: run.summary.status === 'done' ? '运行完成' : run.summary.status === 'error' ? '运行失败' : '运行已中断' });
  } catch (error) {
    run.summary.status = 'error';
    emit(run, { type: 'error', detail: redactMcpError(error) });
    emit(run, { type: 'done', label: '运行失败' });
  } finally {
    for (const [approvalId] of run.pending) decide(run.summary.id, approvalId, 'deny');
  }
}

export async function smokeCheck(): Promise<Record<string, unknown>> {
  const agents = await loadAgents();
  const selected = agents.find((agent) => agent.kind === 'main') ?? agents[0];
  const summary = await startRun(selected.id, '只读检查：请用一句话说明 calculator.ts 中 add 函数做什么。不要调用子 Agent，不要修改文件。');
  return { runId: summary.id };
}
