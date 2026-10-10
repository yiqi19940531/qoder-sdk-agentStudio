import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import { qodercliAuth, query, type Query, type SDKUserMessage } from '@qoder-ai/qoder-agent-sdk';
import type { AgentQuestion, Conversation, ConversationEvent, ConversationTurn, PendingInteraction } from '../shared/types.js';
import { DEFAULT_ALLOWED_TOOLS, MCP_NAME } from '../shared/types.js';
import { resolveAvailableModels } from '../shared/model-selection.js';
import { compact, configuredMcpServers, definition, discoverRuntime, memoryDir, runtimeName, toolList } from './runtime.js';
import { allowToolGlobally, approvalCategory, isConfigurableTool, isGloballyAllowed } from './permissions.js';
import { additionalDirectories, agentPermissions, callingAgent, isDirectoryApproval, shouldAutoAllowAgentTool } from './agent-policy.js';
import { refreshConfigCatalog } from './config-catalog.js';
import { subscribeArtifactUpdates } from './aigc.js';
import { browserService } from './browser-service.js';
import { dataRoot, fixtureRoot, loadAgentInstructions, loadAgents, pluginRoot } from './storage.js';
import { isAssignable, loadSessionMcp, redactMcpError, snapshotSessionMcp } from './mcp-registry.js';

export type InteractionDecision = { action: 'allow' | 'allow_session_tool' | 'allow_session_category' | 'allow_global_tool' | 'deny' | 'answer' | 'cancel'; answers?: Record<string, string> };
type PendingCallback = { resolve: (decision: InteractionDecision) => void; toolUseID: string; submitting?: boolean };

class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;
  private ready = false;

  push(content: string): void {
    if (this.closed) throw new Error('会话输入已关闭');
    this.items.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: content }] },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      priority: 'later',
    });
    this.wake?.();
  }

  close(): void { this.closed = true; this.wake?.(); }
  release(): void { this.ready = true; this.wake?.(); }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (!this.ready) { await new Promise<void>((resolve) => { this.wake = resolve; }); this.wake = undefined; continue; }
      if (this.items.length) { yield this.items.shift()!; continue; }
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

async function waitForMcpReady(q: Query, names: Set<string>): Promise<void> {
  if (!names.size) return;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const statuses = await Promise.race([q.mcpServerStatus(), new Promise<Awaited<ReturnType<Query['mcpServerStatus']>>>((_, reject) => setTimeout(() => reject(new Error('MCP 状态查询超时')), 5000))]);
    const matched = [...names].map((name) => statuses.find((item) => item.name === name));
    const failed = matched.find((item) => item && ['failed', 'disconnected', 'needs-auth', 'disabled'].includes(item.status));
    if (failed) throw new Error(`MCP ${failed.name} 连接失败：${redactMcpError(failed.error ?? failed.status)}`);
    if (matched.every((item) => item?.status === 'connected')) return;
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error(`MCP 连接等待超时：${[...names].join('、')}`);
}

type LiveConversation = {
  record: Conversation;
  queue: MessageQueue;
  query?: Query;
  listeners: Set<Response>;
  callbacks: Map<string, PendingCallback>;
  delegationOwners: Map<string, string>;
  toolOwners: Map<string, { agentId: string; parentToolUseId?: string; targetAgentId?: string }>;
  allowedOrigins: Set<string>;
  hadTextDelta: boolean;
  interruptRequested: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  saveTimer?: ReturnType<typeof setTimeout>;
  closed: boolean;
};

const directory = path.join(dataRoot, 'conversations');
const records = new Map<string, Conversation>();
const liveSessions = new Map<string, LiveConversation>();
const writes = new Map<string, Promise<void>>();
const pendingBrowserOutcomes = new Map<string, { result: 'confirmed' | 'ready' | 'failed' | 'unverified'; message: string }>();
const IDLE_MS = 30 * 60_000;
const MAX_EVENTS = 2000;

browserService.onState((summary) => {
  const record = records.get(summary.conversationId);
  if (!record) return;
  const event: ConversationEvent = {
    id: ++record.lastEventId, turnId: record.turns.at(-1)?.id ?? '', at: new Date().toISOString(),
    type: 'status', label: `远程浏览器：${summary.state}`, detail: summary.message ?? summary.pageUrl,
    agentId: record.agentId,
  };
  record.events.push(event);
  if (record.events.length > MAX_EVENTS) record.events.shift();
  record.updatedAt = event.at;
  const live = liveSessions.get(record.id);
  if (live) {
    for (const response of live.listeners) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
    schedulePersist(live);
  } else void persist(record).catch(() => {});
});

browserService.onOutcome((conversationId, result, message) => {
  void deliverBrowserOutcome(conversationId, result, message).catch((error) => console.error('浏览器核验结果交接失败', error));
});

subscribeArtifactUpdates((artifact) => {
  const live = liveSessions.get(artifact.conversationId);
  if (live) {
    const server = artifact.kind === 'image' ? 'bailian-image' : 'bailian-video';
    const owner = [live.record.config.agent, ...live.record.config.children].find((agent) => agent.mcpServers.includes(server));
    emit(live, { type: 'status', label: `媒体${artifact.kind === 'image' ? '图片' : '视频'}：${artifact.status}`, detail: artifact.id, agentId: owner?.id });
  }
});

function fileFor(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的会话 ID');
  return path.join(directory, `${id}.json`);
}

function persist(record: Conversation): Promise<void> {
  const payload = JSON.stringify(record);
  const previous = writes.get(record.id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(directory, { recursive: true });
    const temporary = `${fileFor(record.id)}.${randomUUID()}.tmp`;
    await writeFile(temporary, payload, 'utf8');
    await rename(temporary, fileFor(record.id));
  });
  writes.set(record.id, next);
  return next;
}

function schedulePersist(live: LiveConversation): void {
  if (live.saveTimer) return;
  live.saveTimer = setTimeout(() => {
    live.saveTimer = undefined;
    void persist(live.record).catch((error) => console.error('保存会话失败', error));
  }, 250);
}

async function flush(live: LiveConversation): Promise<void> {
  if (live.saveTimer) clearTimeout(live.saveTimer);
  live.saveTimer = undefined;
  await persist(live.record);
}

function emit(live: LiveConversation, event: Omit<ConversationEvent, 'id' | 'at' | 'turnId'>): void {
  const record = live.record;
  const next: ConversationEvent = {
    id: ++record.lastEventId,
    at: new Date().toISOString(),
    turnId: record.turns.at(-1)?.id ?? '',
    ...event,
  };
  record.events.push(next);
  if (record.events.length > MAX_EVENTS) record.events.shift();
  record.updatedAt = next.at;
  for (const response of live.listeners) response.write(`id: ${next.id}\ndata: ${JSON.stringify(next)}\n\n`);
  schedulePersist(live);
}

function makeLive(record: Conversation): LiveConversation {
  record.sessionAllowedTools ??= [];
  record.sessionAllowedCategories ??= [];
  const live: LiveConversation = {
    record, queue: new MessageQueue(), listeners: new Set(), callbacks: new Map(), delegationOwners: new Map(), toolOwners: new Map(),
    allowedOrigins: new Set(), hadTextDelta: false, interruptRequested: false, closed: false,
  };
  liveSessions.set(record.id, live);
  return live;
}

function currentTurn(record: Conversation): ConversationTurn {
  const turn = record.turns.at(-1);
  if (!turn) throw new Error('会话尚无轮次');
  return turn;
}

function appendText(live: LiveConversation, text: string): void {
  if (!text) return;
  const record = live.record;
  const turn = currentTurn(record);
  let message = record.messages.find((item) => item.id === `assistant-${turn.id}`);
  if (!message) {
    message = { id: `assistant-${turn.id}`, turnId: turn.id, role: 'assistant', content: '', at: new Date().toISOString() };
    record.messages.push(message);
  }
  message.content += text;
  emit(live, { type: 'text', detail: text, agentId: record.config.agent.id });
}

function navigationOrigin(toolName: string, input: Record<string, unknown>): string | undefined {
  if (!['mcp__playwright__browser_navigate', 'mcp__chrome-devtools__new_page', 'mcp__chrome-devtools__navigate_page'].includes(toolName)) return;
  if (typeof input.url !== 'string') return;
  try {
    const url = new URL(input.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch { return; }
}

function validQuestions(input: Record<string, unknown>): AgentQuestion[] | null {
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 4) return null;
  const questions: AgentQuestion[] = [];
  for (const raw of input.questions) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.question !== 'string' || !item.question.trim() || typeof item.header !== 'string' || !Array.isArray(item.options) || item.options.length < 2 || item.options.length > 4) return null;
    const options: AgentQuestion['options'] = [];
    for (const option of item.options) {
      if (!option || typeof option !== 'object' || typeof option.label !== 'string' || typeof option.description !== 'string') return null;
      options.push({ label: option.label, description: option.description, ...(typeof option.preview === 'string' ? { preview: option.preview } : {}) });
    }
    questions.push({ question: item.question, header: item.header, options, multiSelect: item.multiSelect === true });
  }
  if (new Set(questions.map((item) => item.question)).size !== questions.length) return null;
  return questions;
}

async function requestDecision(live: LiveConversation, toolName: string, input: Record<string, unknown>, context: { signal: AbortSignal; toolUseID: string; title?: string; description?: string; blockedPath?: string; decisionReason?: string; agentID?: string }) {
  if (toolName.includes('browser_run_code_unsafe')) return { behavior: 'deny' as const, message: '浏览器测试不开放任意代码执行。', toolUseID: context.toolUseID };
  const questions = toolName === 'AskUserQuestion' ? validQuestions(input) : undefined;
  if (toolName === 'AskUserQuestion' && !questions) return { behavior: 'deny' as const, message: 'Agent 提问格式无效。', toolUseID: context.toolUseID };
  const origin = navigationOrigin(toolName, input);
  const group = approvalCategory(toolName);
  const { agent, children } = live.record.config;
  const caller = callingAgent(agent, children, context.agentID, toolName);
  const pathBlocked = isDirectoryApproval(context.blockedPath, context.decisionReason) && agentPermissions(agent).pathAccess !== 'all';
  const autoReason = toolName === 'AskUserQuestion' ? undefined
    : pathBlocked ? undefined
      : shouldAutoAllowAgentTool(caller, pathBlocked) ? `Agent「${caller.name}」默认允许工具`
        : isGloballyAllowed(toolName) ? '全局默认允许'
          : live.record.sessionAllowedTools?.includes(toolName) ? '本会话已允许此工具'
            : group && live.record.sessionAllowedCategories?.includes(group.category) ? '本会话已允许同类操作' : undefined;
  if (autoReason) {
    emit(live, { type: 'interaction_resolved', label: autoReason, toolName, detail: compact(input, 500), agentId: caller.id, toolUseId: context.toolUseID });
    return { behavior: 'allow' as const, updatedInput: input, toolUseID: context.toolUseID };
  }
  if (!pathBlocked && origin && live.allowedOrigins.has(origin)) return { behavior: 'allow' as const, updatedInput: input, toolUseID: context.toolUseID };
  const interaction: PendingInteraction = {
    id: randomUUID(), turnId: currentTurn(live.record).id,
    kind: questions ? 'question' : 'approval', toolName,
    title: context.title ?? (questions ? 'Agent 需要你的选择' : toolName),
    detail: `${pathBlocked ? `目录授权待确认：${context.blockedPath ?? context.decisionReason}\n` : ''}${origin ? `${origin}\n${String(input.url)}` : compact(input, 2400)}`,
    ...(origin ? { origin } : {}), ...(group ? { category: group.category, categoryLabel: group.label } : {}), ...(questions ? { questions } : {}), at: new Date().toISOString(),
  };
  live.record.pending.push(interaction);
  live.record.status = 'waiting';
  const decisionPromise = new Promise<InteractionDecision>((resolve) => {
    if (context.signal.aborted) { resolve({ action: 'cancel' }); return; }
    live.callbacks.set(interaction.id, { resolve, toolUseID: context.toolUseID });
    context.signal.addEventListener('abort', () => resolve({ action: 'cancel' }), { once: true });
  });
  emit(live, { type: 'interaction', label: interaction.title, detail: interaction.detail, toolName, interactionId: interaction.id, agentId: caller.id, toolUseId: context.toolUseID });
  await flush(live);
  const decision = await decisionPromise;
  live.callbacks.delete(interaction.id);
  live.record.pending = live.record.pending.filter((item) => item.id !== interaction.id);
  live.record.status = live.record.pending.length ? 'waiting' : 'running';
  const label = decision.action === 'allow' ? '用户允许一次'
    : decision.action === 'allow_session_tool' ? '本会话允许此工具'
      : decision.action === 'allow_session_category' ? '本会话允许同类操作'
        : decision.action === 'allow_global_tool' ? '全局默认允许此工具'
          : decision.action === 'deny' ? '用户拒绝' : decision.action === 'answer' ? '用户已回答' : '请求已取消';
  emit(live, { type: 'interaction_resolved', label, interactionId: interaction.id, agentId: caller.id, toolUseId: context.toolUseID });
  if (decision.action.startsWith('allow')) {
    if (origin) live.allowedOrigins.add(origin);
    return { behavior: 'allow' as const, updatedInput: input, toolUseID: context.toolUseID };
  }
  if (decision.action === 'answer') return { behavior: 'allow' as const, updatedInput: { questions: input.questions, answers: decision.answers }, toolUseID: context.toolUseID };
  return { behavior: 'deny' as const, message: decision.action === 'deny' ? '用户拒绝了这次操作。' : '该请求已取消或任务已中断。', toolUseID: context.toolUseID };
}

function digest(live: LiveConversation, message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const msg = message as Record<string, any>;
  const { agent, children } = live.record.config;
  const delegatedOwner = typeof msg.parent_tool_use_id === 'string' ? live.delegationOwners.get(msg.parent_tool_use_id) : undefined;
  if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
    live.record.sdkSessionId = msg.session_id;
    live.record.sdkEstablished = true;
    schedulePersist(live);
  }
  if (msg.type === 'stream_event') {
    const delta = msg.event?.delta;
    if (!msg.parent_tool_use_id && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      live.hadTextDelta = true;
      appendText(live, delta.text);
    }
  } else if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block?.type === 'text' && delegatedOwner && typeof block.text === 'string' && block.text.trim()) {
        emit(live, { type: 'agent_text', label: '子 Agent 回答', detail: block.text.slice(0, 5000), agentId: delegatedOwner, parentToolUseId: msg.parent_tool_use_id });
      }
      if (block?.type !== 'tool_use') continue;
      const owner = delegatedOwner ?? callingAgent(agent, children, undefined, block.name).id;
      const target = block.name === 'Agent' ? children.find((child) => runtimeName(child) === block.input?.subagent_type || child.id === block.input?.subagent_type) : undefined;
      if (typeof block.id === 'string') {
        live.toolOwners.set(block.id, { agentId: owner, ...(msg.parent_tool_use_id ? { parentToolUseId: msg.parent_tool_use_id } : {}), ...(target ? { targetAgentId: target.id } : {}) });
        if (target) live.delegationOwners.set(block.id, target.id);
      }
      emit(live, { type: 'tool', label: block.name, detail: compact(block.input), toolName: block.name, agentId: owner,
        ...(target ? { targetAgentId: target.id } : {}), ...(typeof block.id === 'string' ? { toolUseId: block.id } : {}),
        ...(msg.parent_tool_use_id ? { parentToolUseId: msg.parent_tool_use_id } : {}) });
    }
  } else if (msg.type === 'user') {
    for (const block of msg.message?.content ?? []) {
      if (block?.type !== 'tool_result') continue;
      const useId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
      const call = useId ? live.toolOwners.get(useId) : undefined;
      emit(live, { type: 'tool', label: '工具结果', detail: compact(block.content), agentId: call?.agentId ?? delegatedOwner ?? agent.id,
        ...(useId ? { toolUseId: useId } : {}), ...(call?.parentToolUseId ? { parentToolUseId: call.parentToolUseId } : {}),
        ...(call?.targetAgentId ? { targetAgentId: call.targetAgentId } : {}) });
    }
  } else if (['task_started', 'task_progress', 'task_notification', 'task_updated'].includes(msg.type === 'system' ? msg.subtype : msg.type)) {
    const subtype = msg.type === 'system' ? msg.subtype : msg.type;
    const target = children.find((child) => runtimeName(child) === msg.subagent_type || child.id === msg.subagent_type);
    if (target && typeof msg.tool_use_id === 'string') live.delegationOwners.set(msg.tool_use_id, target.id);
    const owner = target?.id ?? (typeof msg.tool_use_id === 'string' ? live.delegationOwners.get(msg.tool_use_id) : undefined);
    const label = subtype === 'task_started' ? '子 Agent 已启动' : subtype === 'task_progress' ? '子 Agent 执行中' : subtype === 'task_notification' ? `子 Agent ${msg.status === 'completed' ? '已完成' : '已结束'}` : '子任务状态更新';
    emit(live, { type: 'status', label, detail: compact({ description: msg.description, summary: msg.summary, status: msg.status ?? msg.patch?.status, lastTool: msg.last_tool_name }, 600),
      agentId: owner, ...(typeof msg.tool_use_id === 'string' ? { parentToolUseId: msg.tool_use_id } : {}), ...(typeof msg.task_id === 'string' ? { taskId: msg.task_id } : {}) });
  } else if (msg.type === 'result') {
    if (!live.hadTextDelta && typeof msg.result === 'string') appendText(live, msg.result);
    if (typeof msg.total_credits === 'number') emit(live, { type: 'usage', label: '本次会话累计 Credits', credits: msg.total_credits });
    const models = Object.keys(msg.modelUsage ?? {});
    if (models.length) emit(live, { type: 'diagnostic', label: '实际使用模型', detail: models.join(', ') });
    const turn = currentTurn(live.record);
    turn.status = live.interruptRequested ? 'interrupted' : msg.is_error ? 'error' : 'done';
    turn.endedAt = new Date().toISOString();
    live.record.status = 'idle';
    if (msg.is_error) emit(live, { type: 'error', label: '本轮失败', detail: compact(msg.errors ?? msg.subtype) });
    emit(live, { type: 'turn_end', label: turn.status === 'done' ? '本轮完成，可继续对话' : turn.status === 'error' ? '本轮失败，可继续对话' : '本轮已中断，可继续对话' });
    live.hadTextDelta = false;
    live.interruptRequested = false;
    armIdle(live);
    void flush(live).catch((error) => console.error('保存会话失败', error));
    const browserOutcome = pendingBrowserOutcomes.get(live.record.id);
    if (browserOutcome) {
      pendingBrowserOutcomes.delete(live.record.id);
      queueMicrotask(() => void deliverBrowserOutcome(live.record.id, browserOutcome.result, browserOutcome.message).catch((error) => console.error('浏览器核验结果交接失败', error)));
    }
    return true;
  }
  return false;
}

function armIdle(live: LiveConversation): void {
  if (live.idleTimer) clearTimeout(live.idleTimer);
  live.idleTimer = setTimeout(() => {
    live.closed = true;
    live.queue.close();
    void live.query?.close().catch(() => {});
    if (liveSessions.get(live.record.id) === live) liveSessions.delete(live.record.id);
  }, IDLE_MS);
}

async function execute(live: LiveConversation, resume: boolean): Promise<void> {
  const { agent, children } = live.record.config;
  try {
    const sessionMcp = await loadSessionMcp(live.record.id);
    const definitions = Object.fromEntries(await Promise.all(children.map(async (child) => {
      const item = await definition(child, live.record.config.instructions?.[child.id], live.record.config.mcpToolNames);
      item.tools.push('AskUserQuestion');
      item.prompt += '\n\n当任务被用户决策阻塞时，使用 AskUserQuestion 获取选择。';
      return [runtimeName(child), item] as const;
    })));
    const mcpNames = new Set([...agent.mcpServers, ...children.flatMap((item) => item.mcpServers)]);
    const memoryPath = agent.memoryEnabled ? await memoryDir(agent) : null;
    const memory = memoryPath ? {
      mode: 'custom' as const, userScope: false, projectScope: false,
      generation: {
        roots: [{ id: 'agent', path: memoryPath, indexFile: 'INDEX.md' }],
        onResult: (result: unknown) => emit(live, { type: 'memory', label: '自动记忆写入', detail: compact(result) }),
      },
      consumption: {
        files: [{ id: 'agent-memory', path: path.join(memoryPath, 'INDEX.md') }],
        onResult: (result: unknown) => emit(live, { type: 'memory', label: '记忆加载', detail: compact(result) }),
      },
    } : undefined;
    const names = [...new Set([...toolList(agent, live.record.config.mcpToolNames), 'AskUserQuestion'])];
    const autoAllowed = new Set<string>(DEFAULT_ALLOWED_TOOLS);
    if (live.closed) return;
    emit(live, { type: 'diagnostic', label: 'SDK 最大轮数', detail: String(agent.maxTurns) });
    const q = query({
      prompt: live.queue,
      options: {
        auth: qodercliAuth(), cwd: fixtureRoot, additionalDirectories: additionalDirectories(agent), settingSources: [],
        plugins: [{ type: 'local', path: pluginRoot }],
        agents: definitions,
        systemPrompt: { type: 'preset', preset: 'qodercli', append: `${agent.persona}\n\nProject rules for this Agent (AGENTS.md):\n${live.record.config.instructions?.[agent.id] ?? await loadAgentInstructions(agent.id)}\n\n当任务需要用户在若干选项中决策时，使用 AskUserQuestion 工具，等待用户回答后继续。不要把工具审批当作文字提问。` },
        model: agent.model, maxTurns: agent.maxTurns,
        tools: names, allowedTools: names.filter((name) => autoAllowed.has(name)),
        disallowedTools: ['mcp__playwright__browser_run_code_unsafe'],
        mcpServers: configuredMcpServers(mcpNames, { conversationId: live.record.id, turnId: () => currentTurn(live.record).id }, sessionMcp),
        allowedMcpServerNames: [...mcpNames].filter((name) => name !== MCP_NAME),
        strictMcpConfig: true, skills: agent.skills, memory,
        includePartialMessages: true, permissionMode: 'default',
        controlRequestTimeoutMs: 0,
        ...(resume ? { resume: live.record.sdkSessionId } : { sessionId: live.record.sdkSessionId }),
        canUseTool: (toolName, input, context) => requestDecision(live, toolName, input, context),
      },
    });
    live.query = q;
    const init = await q.initializationResult();
    await waitForMcpReady(q, mcpNames);
    live.queue.release();
    live.record.sdkEstablished = true;
    emit(live, { type: 'diagnostic', label: resume ? '已恢复 SDK 会话' : 'SDK 已初始化', detail: compact({ agents: init.agents.map((item) => item.name), skills: init.skills?.map((item) => item.name) }, 800) });
    for await (const message of q) {
      if (digest(live, message) && agent.memoryEnabled) {
        await Promise.race([q.flushMemory(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
      }
    }
    if (!live.closed && live.record.status !== 'idle') throw new Error('SDK 会话在当前轮完成前关闭');
  } catch (error) {
    if (!live.closed) {
      const turn = live.record.turns.at(-1);
      if (turn?.status === 'running') { turn.status = live.interruptRequested ? 'interrupted' : 'error'; turn.endedAt = new Date().toISOString(); }
      live.record.status = 'idle';
      emit(live, { type: 'error', label: '会话执行失败', detail: redactMcpError(error) });
      emit(live, { type: 'turn_end', label: '本轮结束，可尝试继续对话' });
      await flush(live);
    }
  } finally {
    for (const callback of live.callbacks.values()) callback.resolve({ action: 'cancel' });
    live.callbacks.clear();
    live.closed = true;
    live.queue.close();
    if (live.idleTimer) clearTimeout(live.idleTimer);
    if (liveSessions.get(live.record.id) === live) liveSessions.delete(live.record.id);
    await live.query?.close().catch(() => {});
  }
}

export async function initializeConversations(): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const name of await readdir(directory)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as Conversation;
      if (record.id !== name.slice(0, -5)) continue;
      record.sessionAllowedTools ??= [];
      record.sessionAllowedCategories ??= [];
      record.sdkEstablished ??= record.events.some((event) => event.label === 'SDK 已初始化' || event.label === '已恢复 SDK 会话');
      records.set(record.id, record);
      if (record.status === 'running' || record.status === 'waiting') {
        record.status = 'interrupted';
        record.pending = [];
        const turn = record.turns.at(-1);
        if (turn?.status === 'running') { turn.status = 'interrupted'; turn.endedAt = new Date().toISOString(); }
        record.events.push({ id: ++record.lastEventId, turnId: turn?.id ?? '', at: new Date().toISOString(), type: 'turn_end', label: '服务重启中断了本轮；发送追问继续' });
        await persist(record);
      }
    } catch (error) { console.error(`读取会话失败：${name}`, error); }
  }
}

export function listConversations(agentId?: string): Conversation[] {
  return [...records.values()].filter((item) => !agentId || item.agentId === agentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getConversation(id: string): Conversation | undefined { return records.get(id); }

export async function createConversation(agentId: string, content: string): Promise<Conversation> {
  const agents = await loadAgents();
  const agent = agents.find((item) => item.id === agentId);
  if (!agent) throw new Error('Agent 不存在');
  const configuredChildren = agent.kind === 'main' ? agents.filter((item) => agent.subAgentIds.includes(item.id)) : [];
  const { agents: resolved, fallbacks } = resolveAvailableModels([agent, ...configuredChildren], (await discoverRuntime(true)).models);
  const [effectiveAgent, ...children] = resolved;
  const unavailable = resolved.flatMap((item) => item.mcpServers).find((mcp) => !isAssignable(mcp));
  if (unavailable) throw new Error(`MCP 未通过连接校验或没有工具：${unavailable}`);
  const instructions = Object.fromEntries(await Promise.all(resolved.map(async (item) => [item.id, await loadAgentInstructions(item.id)] as const)));
  const id = randomUUID();
  const mcpToolNames = await snapshotSessionMcp(id, [...new Set(resolved.flatMap((item) => item.mcpServers))]);
  const now = new Date().toISOString();
  const turnId = randomUUID();
  const record: Conversation = {
    id, sdkSessionId: id, sdkEstablished: false, agentId, agentName: agent.name, status: 'running', createdAt: now, updatedAt: now,
    config: { agent: structuredClone(effectiveAgent), children: structuredClone(children), instructions, mcpToolNames, ...(fallbacks.length ? { modelFallbacks: fallbacks } : {}) },
    turns: [{ id: turnId, status: 'running', startedAt: now }],
    messages: [{ id: randomUUID(), turnId, role: 'user', content, at: now }],
    events: [], pending: [], sessionAllowedTools: [], sessionAllowedCategories: [], lastEventId: 0,
  };
  records.set(id, record);
  await persist(record);
  const live = makeLive(record);
  for (const fallback of fallbacks) emit(live, { type: 'diagnostic', label: '模型自动回退到 Qoder Auto', detail: `${fallback.agentId}: ${fallback.requested} → ${fallback.selected}`, agentId: fallback.agentId });
  emit(live, { type: 'status', label: '正在初始化 Qoder SDK' });
  live.queue.push(content);
  void execute(live, false);
  return record;
}

export async function sendMessage(id: string, content: string): Promise<Conversation | null> {
  const record = records.get(id);
  if (!record) return null;
  if (record.demoArchive) throw new Error('演示存档不能续接；请用当前 Agent 开始新对话');
  if (record.status === 'running' || record.status === 'waiting') throw new Error('当前轮仍在执行或等待决策');
  const now = new Date().toISOString();
  const turnId = randomUUID();
  record.turns.push({ id: turnId, status: 'running', startedAt: now });
  record.messages.push({ id: randomUUID(), turnId, role: 'user', content, at: now });
  record.status = 'running';
  record.updatedAt = now;
  await persist(record);
  let live = liveSessions.get(id);
  if (!live || live.closed) {
    live = makeLive(record);
    live.queue.push(content);
    void execute(live, record.sdkEstablished === true);
  } else {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.queue.push(content);
  }
  return record;
}

async function deliverBrowserOutcome(id: string, result: 'confirmed' | 'ready' | 'failed' | 'unverified', message: string): Promise<void> {
  const record = records.get(id);
  if (!record || record.demoArchive || !record.config.agent.mcpServers.includes('jd-browser')) return;
  if (record.status === 'running' || record.status === 'waiting') {
    pendingBrowserOutcomes.set(id, { result, message });
    return;
  }
  const content = result === 'confirmed'
    ? `【系统浏览器核验】新 Browserless 浏览器已恢复并确认京东登录：${message}。请调用 browser_check_login 确认状态；若有未完成的商品任务，继续采集。不要关闭浏览器。`
    : result === 'ready'
      ? `【系统浏览器核验】人工验证后，新浏览器已能访问商城商品：${message}。请调用 browser_task_status 查看结果与进度，继续采集评论。账号登录未单独确认，不得声称已经登录。`
    : result === 'unverified'
      ? `【系统浏览器核验】人工验证后未能取得足够证据：${message}。请调用 browser_get_state 和 browser_task_status 核对状态，不要声称已登录或已采集成功。`
      : `【系统浏览器核验】京东人工验证未完成：${message}。请调用 browser_get_state 和 browser_task_status 核对状态，并如实告知用户。`;
  const now = new Date().toISOString();
  const turnId = randomUUID();
  record.turns.push({ id: turnId, status: 'running', startedAt: now });
  record.messages.push({ id: randomUUID(), turnId, role: 'system', content, at: now });
  record.status = 'running';
  record.updatedAt = now;
  await persist(record);
  let live = liveSessions.get(id);
  if (!live || live.closed) {
    live = makeLive(record);
    live.queue.push(content);
    emit(live, { type: 'status', label: '远程浏览器核验已交给 Agent', detail: message });
    void execute(live, record.sdkEstablished === true);
  } else {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.queue.push(content);
    emit(live, { type: 'status', label: '远程浏览器核验已交给 Agent', detail: message });
  }
}

export function subscribeConversation(id: string, response: Response, after = 0): boolean {
  const record = records.get(id);
  if (!record) return false;
  response.setHeader('Content-Type', 'text/event-stream');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.flushHeaders();
  for (const event of record.events) if (event.id > after) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  const live = liveSessions.get(id);
  if (live) { live.listeners.add(response); response.on('close', () => live.listeners.delete(response)); }
  else response.end();
  return true;
}

export async function submitInteraction(id: string, interactionId: string, decision: InteractionDecision): Promise<'ok' | 'missing' | 'stale' | 'invalid'> {
  const record = records.get(id);
  if (!record) return 'missing';
  const live = liveSessions.get(id);
  const pending = record.pending.find((item) => item.id === interactionId);
  const callback = live?.callbacks.get(interactionId);
  if (!pending || !callback || callback.submitting) return 'stale';
  if (pending.kind === 'approval' && !['allow', 'allow_session_tool', 'allow_session_category', 'allow_global_tool', 'deny'].includes(decision.action)) return 'invalid';
  if (decision.action === 'allow_session_category' && !pending.category) return 'invalid';
  if (decision.action === 'allow_global_tool' && !isConfigurableTool(pending.toolName)) return 'invalid';
  if (pending.kind === 'question') {
    if (decision.action !== 'answer' && decision.action !== 'deny') return 'invalid';
    if (decision.action === 'answer') {
      const answers = decision.answers;
      if (!answers || !pending.questions?.every((item) => typeof answers[item.question] === 'string' && answers[item.question].trim().length > 0 && answers[item.question].length <= 2000)) return 'invalid';
    }
  }
  callback.submitting = true;
  try {
    if (decision.action === 'allow_global_tool') {
      await allowToolGlobally(pending.toolName);
      await refreshConfigCatalog();
    }
    if (decision.action === 'allow_session_tool') record.sessionAllowedTools = [...new Set([...(record.sessionAllowedTools ?? []), pending.toolName])];
    if (decision.action === 'allow_session_category') record.sessionAllowedCategories = [...new Set([...(record.sessionAllowedCategories ?? []), pending.category!])];
    if (decision.action === 'allow_session_tool' || decision.action === 'allow_session_category') await flush(live!);
    live!.callbacks.delete(interactionId);
    callback.resolve(decision);
    return 'ok';
  } catch (error) { callback.submitting = false; throw error; }
}

export function resolveGloballyAllowedPending(toolName: string): void {
  if (!isGloballyAllowed(toolName)) return;
  for (const live of liveSessions.values()) {
    for (const pending of live.record.pending) {
      if (pending.kind !== 'approval' || pending.toolName !== toolName) continue;
      const callback = live.callbacks.get(pending.id);
      if (!callback || callback.submitting) continue;
      live.callbacks.delete(pending.id);
      callback.resolve({ action: 'allow_global_tool' });
    }
  }
}

export async function interruptConversation(id: string): Promise<boolean> {
  const live = liveSessions.get(id);
  if (!live || !['running', 'waiting'].includes(live.record.status)) return false;
  live.interruptRequested = true;
  for (const callback of live.callbacks.values()) callback.resolve({ action: 'cancel' });
  live.callbacks.clear();
  if (!live.query) {
    live.closed = true;
    live.queue.close();
    const turn = currentTurn(live.record);
    turn.status = 'interrupted';
    turn.endedAt = new Date().toISOString();
    live.record.pending = [];
    live.record.status = 'idle';
    emit(live, { type: 'turn_end', label: '本轮已中断，可继续对话' });
    liveSessions.delete(id);
    await flush(live);
    return true;
  }
  emit(live, { type: 'status', label: '正在中断当前轮' });
  await live.query?.interrupt();
  return true;
}
