import assert from 'node:assert/strict';
import { buildAgentFlow } from '../shared/agent-flow.js';
import type { AgentConfig, Conversation, ConversationEvent } from '../shared/types.js';

const base: AgentConfig = { id: 'main', kind: 'main', name: '编排 Agent', description: '', persona: '', model: 'auto', maxTurns: 8, tools: ['Agent'], skills: [], mcpServers: [], subAgentIds: ['image', 'video'], memoryEnabled: false, permissions: { toolApproval: 'ask', pathAccess: 'workspace', additionalDirectories: [] } };
const image: AgentConfig = { ...base, id: 'image', kind: 'subagent', name: '图片 Agent', tools: [], subAgentIds: [], mcpServers: ['bailian-image'] };
const video: AgentConfig = { ...base, id: 'video', kind: 'subagent', name: '视频 Agent', tools: [], subAgentIds: [], mcpServers: ['bailian-video'] };
const at = new Date().toISOString();
const event = (id: number, patch: Partial<ConversationEvent>): ConversationEvent => ({ id, at, turnId: 'turn', type: 'tool', ...patch });
const conversation: Conversation = {
  id: 'conversation', sdkSessionId: 'session', agentId: base.id, agentName: base.name, status: 'running', createdAt: at, updatedAt: at,
  config: { agent: base, children: [image, video] }, turns: [{ id: 'turn', status: 'running', startedAt: at }], messages: [], pending: [], lastEventId: 4,
  events: [
    event(1, { label: 'Agent', toolName: 'Agent', detail: JSON.stringify({ subagent_type: 'image', prompt: '花' }) }),
    event(2, { label: 'mcp__bailian-image__generate_image', toolName: 'mcp__bailian-image__generate_image', detail: '{"prompt":"花"}' }),
    event(3, { type: 'status', label: '媒体图片：running', detail: 'artifact-image' }),
  ],
  artifacts: [{ id: 'artifact-image', conversationId: 'conversation', turnId: 'turn', kind: 'image', status: 'running', prompt: '花', model: 'qwen-image-3.0', createdAt: at, updatedAt: at }],
};
let flow = buildAgentFlow(base, [image, video], conversation);
assert.equal(flow.nodes[0].status, 'running');
assert.equal(flow.nodes[1].status, 'running');
assert.equal(flow.nodes[1].invocations, 1);
assert.ok(flow.nodes[1].actions.some((item) => item.toolName === 'mcp__bailian-image__generate_image'));
assert.equal(flow.nodes[2].status, 'configured');

conversation.events.push(event(4, { label: 'Agent', toolName: 'Agent', agentId: 'main', targetAgentId: 'video', toolUseId: 'delegate-video', detail: '{}' }));
conversation.events.push(event(5, { label: 'mcp__bailian-video__generate_video', toolName: 'mcp__bailian-video__generate_video', agentId: 'video', parentToolUseId: 'delegate-video', toolUseId: 'video-call' }));
flow = buildAgentFlow(base, [image, video], conversation);
assert.equal(flow.nodes[2].status, 'running');
assert.equal(flow.nodes[2].invocations, 1);
assert.ok(flow.nodes[2].actions.some((item) => item.toolUseId === 'video-call'));

conversation.status = 'waiting';
conversation.pending.push({ id: 'approval', turnId: 'turn', kind: 'approval', toolName: 'mcp__bailian-video__generate_video', title: '允许视频生成', detail: '', at });
conversation.events.push(event(6, { type: 'interaction', interactionId: 'approval', agentId: 'video' }));
flow = buildAgentFlow(base, [image, video], conversation);
assert.equal(flow.nodes[0].status, 'waiting');
assert.equal(flow.nodes[1].status, 'running');
assert.equal(flow.nodes[2].status, 'waiting');
conversation.pending = [];
conversation.status = 'running';

conversation.events.push(event(7, { type: 'status', label: '子 Agent 已完成', agentId: 'video', parentToolUseId: 'delegate-video' }));
assert.equal(buildAgentFlow(base, [image, video], conversation).nodes[2].status, 'done');

conversation.status = 'idle';
conversation.turns[0].status = 'done';
conversation.artifacts![0].status = 'succeeded';
flow = buildAgentFlow(base, [image, video], conversation);
assert.equal(flow.nodes[1].status, 'done');
assert.equal(flow.nodes[2].status, 'done');
conversation.artifacts![0].status = 'failed';
assert.equal(buildAgentFlow(base, [image, video], conversation).nodes[1].status, 'failed');
conversation.events.push(event(8, { type: 'status', label: '媒体图片：failed', detail: 'artifact-image', agentId: 'image' }));
assert.equal(buildAgentFlow(base, [image, { ...image, id: 'image-2' }], conversation).nodes[1].artifacts.length, 1);
console.log('Agent flow: legacy attribution, delegation, per-Agent actions/artifacts, waiting/completed/failed states PASS');
