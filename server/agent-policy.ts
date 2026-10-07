import path from 'node:path';
import type { AgentConfig } from '../shared/types.js';
import { DEFAULT_AGENT_PERMISSIONS } from '../shared/types.js';

export function agentPermissions(agent: AgentConfig) {
  return agent.permissions ?? DEFAULT_AGENT_PERMISSIONS;
}

// Qoder's directory authorization extends cwd. This is not an OS sandbox:
// shell commands and MCP processes still run with the local user's privileges.
export function additionalDirectories(agent: AgentConfig): string[] {
  const policy = agentPermissions(agent);
  if (policy.pathAccess === 'all') return [path.parse(process.cwd()).root];
  return policy.pathAccess === 'selected' ? policy.additionalDirectories : [];
}

export function callingAgent(main: AgentConfig, children: AgentConfig[], agentID?: string, toolName?: string): AgentConfig {
  const named = [main, ...children].find((agent) => agent.id === agentID || agent.id.replace(/[^a-zA-Z0-9_-]/g, '-') === agentID);
  if (named) return named;
  const server = /^mcp__(.+?)__/.exec(toolName ?? '')?.[1];
  const owners = server ? children.filter((child) => child.mcpServers.includes(server)) : [];
  if (owners.length === 1 && !main.mcpServers.includes(server!)) return owners[0];
  return main;
}

export function isDirectoryApproval(blockedPath?: string, decisionReason?: string): boolean {
  return Boolean(blockedPath) || /outside allowed working directories/i.test(decisionReason ?? '');
}

export function shouldAutoAllowAgentTool(agent: AgentConfig, directoryApproval: boolean): boolean {
  const policy = agentPermissions(agent);
  return policy.toolApproval === 'allow_all' && !directoryApproval;
}
