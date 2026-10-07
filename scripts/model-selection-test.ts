import assert from 'node:assert/strict';
import { resolveAvailableModels } from '../shared/model-selection.js';
import type { AgentConfig, ModelOption } from '../shared/types.js';

const agent = (id: string, model: string): AgentConfig => ({
  id, kind: 'main', name: id, description: '', persona: '', model, maxTurns: 8,
  tools: ['Read'], skills: [], mcpServers: [], subAgentIds: [], memoryEnabled: false,
  permissions: { toolApproval: 'ask', pathAccess: 'workspace', additionalDirectories: [] },
});
const models: ModelOption[] = [
  { id: 'auto', name: 'Auto', source: 'qoder', enabled: true },
  { id: 'efficient', name: 'Efficient', source: 'qoder', enabled: true },
];
const original = [agent('browser', 'bailian/qwen3.8-flash-tp'), agent('review', 'efficient')];
const result = resolveAvailableModels(original, models);
assert.deepEqual(result.agents.map((item) => item.model), ['auto', 'efficient']);
assert.deepEqual(result.fallbacks, [{ agentId: 'browser', requested: 'bailian/qwen3.8-flash-tp', selected: 'auto' }]);
assert.equal(original[0].model, 'bailian/qwen3.8-flash-tp');
assert.deepEqual(resolveAvailableModels(original, [...models, { id: original[0].model, name: 'Custom', source: 'custom', enabled: true }]).fallbacks, []);
assert.throws(() => resolveAvailableModels(original, [{ id: 'auto', name: 'Auto', source: 'qoder', enabled: false }]), /Auto/);
console.log('Model fallback without Token Plan PASS');
