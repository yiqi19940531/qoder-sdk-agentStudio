import type { AgentConfig, Conversation, ConversationEvent, ConversationTurn, MediaArtifact } from './types.js';

export type FlowStatus = 'configured' | 'waiting' | 'running' | 'done' | 'failed';
export type AgentFlowNode = {
  agent: AgentConfig;
  status: FlowStatus;
  invocations: number;
  actions: ConversationEvent[];
  artifacts: MediaArtifact[];
};
export type AgentFlow = { turn?: ConversationTurn; nodes: AgentFlowNode[]; events: ConversationEvent[] };

function targetOf(event: ConversationEvent, children: AgentConfig[]): string | undefined {
  if (event.targetAgentId) return event.targetAgentId;
  if (event.toolName !== 'Agent' || !event.detail) return undefined;
  try {
    const input = JSON.parse(event.detail) as { subagent_type?: string };
    return children.find((child) => child.id === input.subagent_type || child.id.replace(/[^a-zA-Z0-9_-]/g, '-') === input.subagent_type)?.id;
  } catch { return undefined; }
}

function artifactOwner(artifact: MediaArtifact, root: AgentConfig, children: AgentConfig[], events: ConversationEvent[]): string | undefined {
  const attributed = events.find((event) => event.agentId && event.type === 'status' && event.label?.startsWith('媒体') && event.detail === artifact.id);
  if (attributed?.agentId && [root, ...children].some((agent) => agent.id === attributed.agentId)) return attributed.agentId;
  const server = artifact.kind === 'image' ? 'bailian-image' : 'bailian-video';
  const owners = [root, ...children].filter((agent) => agent.mcpServers.includes(server));
  return owners.length === 1 ? owners[0].id : undefined;
}

function eventOwner(event: ConversationEvent, root: AgentConfig, children: AgentConfig[], artifacts: MediaArtifact[], events: ConversationEvent[]): string | undefined {
  if (event.agentId) return event.agentId;
  if (event.toolName === 'Agent' || event.type === 'text') return root.id;
  if (event.toolName?.startsWith('mcp__')) {
    const server = /^mcp__(.+?)__/.exec(event.toolName)?.[1];
    const owners = [root, ...children].filter((agent) => server && agent.mcpServers.includes(server));
    if (owners.length === 1) return owners[0].id;
  }
  if (event.detail) {
    const related = artifacts.find((artifact) => event.detail?.includes(artifact.id));
    if (related) return artifactOwner(related, root, children, events);
  }
  if (event.type === 'interaction_resolved' && event.label) {
    const matched = children.filter((child) => event.label?.includes(`Agent「${child.name}」`));
    if (matched.length === 1) return matched[0].id;
  }
  if (event.type === 'usage' || event.type === 'diagnostic' || event.type === 'turn_end' || event.type === 'memory' || event.type === 'error') return root.id;
  return undefined;
}

export function buildAgentFlow(root: AgentConfig, children: AgentConfig[], conversation?: Conversation, requestedTurnId?: string): AgentFlow {
  const turn = conversation?.turns.find((item) => item.id === requestedTurnId) ?? conversation?.turns.at(-1);
  const events = turn ? conversation?.events.filter((event) => event.turnId === turn.id) ?? [] : [];
  const artifacts = turn ? conversation?.artifacts?.filter((artifact) => artifact.turnId === turn.id) ?? [] : [];
  const nodes = [root, ...children].map((agent): AgentFlowNode => {
    const invocations = agent.id === root.id ? 0 : events.filter((event) => event.type === 'tool' && event.toolName === 'Agent' && targetOf(event, children) === agent.id).length;
    const ownArtifacts = artifacts.filter((artifact) => artifactOwner(artifact, root, children, events) === agent.id);
    const actions = events.filter((event) => {
      if (event.type === 'text') return false;
      return eventOwner(event, root, children, artifacts, events) === agent.id || (agent.id !== root.id && event.type === 'tool' && event.toolName === 'Agent' && targetOf(event, children) === agent.id);
    });
    let status: FlowStatus = 'configured';
    if (turn) {
      if (agent.id === root.id) status = turn.status === 'running' ? conversation?.status === 'waiting' ? 'waiting' : 'running' : turn.status === 'done' ? 'done' : 'failed';
      else if (invocations) {
        const failedArtifacts = ownArtifacts.length > 0 && ownArtifacts.every((item) => item.status === 'failed');
        const taskFinished = actions.some((event) => event.label === '子 Agent 已完成');
        const failedTask = actions.some((event) => event.label?.includes('已结束') && event.detail?.includes('failed'));
        const ownDecisionPending = conversation?.pending.some((pending) => pending.turnId === turn.id && events.some((event) => event.interactionId === pending.id && event.agentId === agent.id));
        status = failedArtifacts || failedTask ? 'failed' : taskFinished ? 'done' : turn.status === 'running' ? ownDecisionPending ? 'waiting' : 'running' : turn.status === 'done' ? 'done' : 'failed';
      }
    }
    return { agent, status, invocations, actions, artifacts: ownArtifacts };
  });
  return { turn, nodes, events };
}
