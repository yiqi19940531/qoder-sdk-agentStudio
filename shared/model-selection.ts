import type { AgentConfig, ModelOption } from './types.js';

export function resolveAvailableModels(agents: AgentConfig[], available: ModelOption[]): {
  agents: AgentConfig[];
  fallbacks: Array<{ agentId: string; requested: string; selected: string }>;
} {
  const enabled = new Set(available.filter((item) => item.enabled).map((item) => item.id));
  const fallback = available.find((item) => item.id === 'auto' && item.enabled && item.source === 'qoder');
  const changes: Array<{ agentId: string; requested: string; selected: string }> = [];
  const resolved = agents.map((agent) => {
    if (enabled.has(agent.model)) return agent;
    if (!fallback) throw new Error(`模型 ${agent.model} 当前不可用，且账号未返回可用的 Qoder Auto 模型`);
    changes.push({ agentId: agent.id, requested: agent.model, selected: fallback.id });
    return { ...agent, model: fallback.id };
  });
  return { agents: resolved, fallbacks: changes };
}
