import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentConfig } from '../shared/types.js';
import { DEFAULT_AGENT_PERMISSIONS, MCP_NAME, SKILL_NAME } from '../shared/types.js';

export const projectRoot = process.cwd();
export const dataRoot = path.join(projectRoot, 'data');
export const fixtureRoot = path.join(dataRoot, 'example-repo');
export const pluginRoot = path.join(projectRoot, 'plugins', 'workbench');
export const agentsPath = path.join(dataRoot, 'agents.json');
const legacyInstructionsPath = path.join(fixtureRoot, 'AGENTS.md');
const instructionMigrationPath = path.join(dataRoot, '.agent-instructions-v1');
const neutralInstructions = '# 示例仓库规则\n\n这是 Agent Workbench 的独立测试仓库。请根据文件证据回答。\n';
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

function profilePath(id: string): string {
  if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('Invalid agent ID');
  return path.join(dataRoot, 'profiles', id);
}
export function personaPath(id: string): string { return path.join(profilePath(id), 'persona.md'); }
export function agentInstructionsPath(id: string): string { return path.join(profilePath(id), 'AGENTS.md'); }
export function agentMemoryPath(id: string): string { return path.join(profilePath(id), 'memory', 'INDEX.md'); }

function defaultInstructions(agent: AgentConfig): string {
  if (agent.id === 'aigc-director') return '# AIGC 任务编排 Agent · 规则\n\n- 判断用户要图片、视频，或两者都要；不明确时使用 AskUserQuestion。\n- 把可执行的具体创意简报分别交给图片或视频子 Agent。\n- 只根据工具返回的状态报告结果，不虚构已生成的媒体。\n';
  if (agent.id === 'aigc-image') return '# 图片生成 Agent · 规则\n\n- 仅处理文生图。提炼主体、场景、风格、构图和光线，调用一次图片生成工具。\n- 只在成功返回产物 ID 后报告图片完成。\n';
  if (agent.id === 'aigc-video') return '# 视频生成 Agent · 规则\n\n- 仅处理文生视频。提炼主体、动作、场景、镜头运动，调用一次视频生成工具。\n- 等待工具结果；失败时说明状态和错误，不虚构视频。\n';
  if (agent.id === 'jd-login') return '# 京东商城研究 Agent · 规则\n\n- 先后台搜索商品，只有京东页面要求登录或风险验证时才交给用户操作。\n- 商品名称、价格、促销和评论必须来自真实页面；销量排序未确认时不得声称销量前 20。\n- 人工完成后读取任务进度并继续；不得自动完成滑块或读取手机号、验证码和 Cookie 值。\n';
  if (agent.id === 'repo-coordinator') return '# 仓库协调 Agent · 项目规则\n\n- 在示例仓库中先读取文件证据，再汇总结论。\n- 需要深入代码审查时可委派代码审查 Agent；明确区分自己的发现与子 Agent 的发现。\n- 仅在任务明确要求时修改文件。\n';
  if (agent.id === 'code-reviewer') return '# 代码审查 Agent · 项目规则\n\n- 审查示例仓库代码的正确性与边界情况，并标注具体文件和复现条件。\n- 不自行修改文件；把发现与建议交回主 Agent。\n';
  if (agent.name === '网页效果探索 Agent') return '# 网页效果探索 Agent · 项目规则\n\n- 给定网页时，使用已装配的浏览器工具查看实际渲染结果。\n- 说明可见内容、布局、样式和交互；区分观察结果与推断。\n- 页面加载失败或受到反爬限制时，如实说明。\n';
  return `# ${agent.name} · 项目规则\n\n在示例仓库中执行任务时，根据可核实的文件和工具结果回答。\n`;
}

function defaultMemory(agent: AgentConfig): string {
  return `# ${agent.name} · 长期记忆\n\n<!-- 只保留这个 Agent 已验证、对后续任务仍有用的事实。项目规则请写在同目录的 AGENTS.md。 -->\n`;
}

async function ensureAgentFiles(agent: AgentConfig, instructions?: string): Promise<void> {
  try { await readFile(agentInstructionsPath(agent.id), 'utf8'); }
  catch (error) { if (!missing(error)) throw error; await writeAtomic(agentInstructionsPath(agent.id), instructions ?? defaultInstructions(agent)); }
  const memoryPath = agentMemoryPath(agent.id);
  try {
    const existing = await readFile(memoryPath, 'utf8');
    if (existing.trim() === '# Agent memory') await writeAtomic(memoryPath, defaultMemory(agent));
  } catch (error) { if (!missing(error)) throw error; await writeAtomic(memoryPath, defaultMemory(agent)); }
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, file);
}

const seeds: AgentConfig[] = [
  {
    id: 'repo-coordinator', kind: 'main', name: '仓库协调 Agent',
    description: '读取示例仓库，按需委派代码审查，并汇总结果。',
    persona: '# 仓库协调 Agent\n\n你是谨慎的代码分析助手。先读取证据，再给出简明结论。需要详细审查时，委派给代码审查 Agent。默认不修改文件。',
    model: 'auto', maxTurns: 8, tools: ['Read', 'Grep', 'Glob', 'Agent'],
    skills: [], mcpServers: [MCP_NAME], subAgentIds: ['code-reviewer'], memoryEnabled: true, permissions: { ...DEFAULT_AGENT_PERMISSIONS },
  },
  {
    id: 'code-reviewer', kind: 'subagent', name: '代码审查 Agent',
    description: '审查示例仓库的正确性问题，返回文件证据和建议。',
    persona: '# 代码审查 Agent\n\n你只做代码审查。列出可复现的问题、证据位置和修复建议，不修改文件。',
    model: 'efficient', maxTurns: 6, tools: ['Read', 'Grep', 'Glob'],
    skills: [SKILL_NAME], mcpServers: [MCP_NAME], subAgentIds: [], memoryEnabled: false, permissions: { ...DEFAULT_AGENT_PERMISSIONS },
  },
];

const aigcSeeds: AgentConfig[] = [
  {
    id: 'aigc-director', kind: 'main', name: 'AIGC 任务编排 Agent',
    description: '识别文生图、文生视频需求，拆解创意简报并委派对应子 Agent。',
    persona: '# AIGC 任务编排 Agent\n\n你负责客户的文字生成图片或视频任务。先判断媒介：只要图片就委派 aigc-image，只要视频就委派 aigc-video，明确两者都要就分别委派。意图不明确时用 AskUserQuestion 让用户选择。主 Agent 不直接生成媒体，不读取凭据。向子 Agent 传递完整的创意简报；只根据真实工具结果报告成功、失败或等待。',
    model: 'auto', maxTurns: 24, tools: ['Read', 'Agent'], skills: [], mcpServers: [], subAgentIds: ['aigc-image', 'aigc-video'], memoryEnabled: false, permissions: { ...DEFAULT_AGENT_PERMISSIONS },
  },
  {
    id: 'aigc-image', kind: 'subagent', name: '图片生成 Agent',
    description: '当用户要求生成图片、插画、海报、照片时调用；只负责文生图。',
    persona: '# 图片生成 Agent\n\n你只负责生成一张图片。先使用已预载的 bailian-image Skill，然后调用 mcp__bailian-image__generate_image 一次。不要调用视频工具，不要读取凭据。返回真实产物 ID、状态与简短说明。',
    model: 'auto', maxTurns: 12, tools: [], skills: ['workbench:bailian-image'], mcpServers: ['bailian-image'], subAgentIds: [], memoryEnabled: false,
    permissions: { toolApproval: 'allow_all', pathAccess: 'workspace', additionalDirectories: [] },
  },
  {
    id: 'aigc-video', kind: 'subagent', name: '视频生成 Agent',
    description: '当用户要求生成视频、动画、短片时调用；只负责文生视频。',
    persona: '# 视频生成 Agent\n\n你只负责生成一段短视频。先使用已预载的 bailian-video Skill，然后调用 mcp__bailian-video__generate_video 一次。不要调用图片工具，不要读取凭据。返回真实产物 ID、状态与简短说明。',
    model: 'auto', maxTurns: 20, tools: [], skills: ['workbench:bailian-video'], mcpServers: ['bailian-video'], subAgentIds: [], memoryEnabled: false,
    permissions: { toolApproval: 'allow_all', pathAccess: 'workspace', additionalDirectories: [] },
  },
];

const jdSeeds: AgentConfig[] = [{
  id: 'jd-login', kind: 'main', name: '京东商城研究 Agent',
  description: '后台搜索中国区京东商城商品、促销与评论；仅在需要登录或风险验证时请用户接管。',
  persona: '# 京东商城研究 Agent\n\n直接调用 browser_search_products 后台搜索；它会自行创建或恢复浏览器，不要先调用 browser_open。只有工具返回 needs-human 才请用户在 Web 页面人工验证并停止当前轮。取得可核实的商品后，分批调用 browser_collect_reviews。销量排序未确认时不得声称销量前 20；不编造促销或评论。人工完成后读取 browser_task_status 并续接。不要读取手机号、验证码或 Cookie。',
  model: 'auto', maxTurns: 40, tools: [], skills: [], mcpServers: ['jd-browser'], subAgentIds: [], memoryEnabled: false,
  permissions: { ...DEFAULT_AGENT_PERMISSIONS },
}];

export async function initializeStorage(): Promise<void> {
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  try { await readFile(legacyInstructionsPath, 'utf8'); } catch {
    await writeFile(legacyInstructionsPath, neutralInstructions, 'utf8');
  }
  const codePath = path.join(fixtureRoot, 'calculator.ts');
  try { await readFile(codePath, 'utf8'); } catch {
    await writeFile(codePath, 'export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function average(values: number[]): number {\n  return values.reduce((sum, value) => sum + value, 0) / values.length;\n}\n', 'utf8');
  }
  try { await readFile(agentsPath, 'utf8'); } catch { await saveAgents(seeds); }
  for (const agent of seeds) {
    try { await readFile(personaPath(agent.id), 'utf8'); } catch { await writeAtomic(personaPath(agent.id), agent.persona); }
  }
  const agents = await loadAgents();
  try { await readFile(instructionMigrationPath, 'utf8'); }
  catch (error) {
    if (!missing(error)) throw error;
    const legacy = await readFile(legacyInstructionsPath, 'utf8');
    const owner = agents.find((agent) => agent.persona.trim() === legacy.trim()) ?? agents.find((agent) => legacy.includes(agent.name));
    if (legacy.trim() !== neutralInstructions.trim()) await writeAtomic(path.join(dataRoot, 'legacy-shared-AGENTS.md'), legacy);
    for (const agent of agents) await ensureAgentFiles(agent, owner?.id === agent.id ? `${defaultInstructions(agent)}\n## 之前的共享规则\n\n${legacy.trim()}\n` : undefined);
    await writeAtomic(legacyInstructionsPath, neutralInstructions);
    await writeAtomic(instructionMigrationPath, 'Per-agent AGENTS.md files initialized.\n');
  }
  for (const agent of agents) await ensureAgentFiles(agent);
  const additions = [...aigcSeeds, ...jdSeeds].filter((agent) => !agents.some((existing) => existing.id === agent.id));
  if (additions.length) await saveAgents([...agents, ...additions]);
}

export async function loadAgents(): Promise<AgentConfig[]> {
  const agents = JSON.parse(await readFile(agentsPath, 'utf8')) as AgentConfig[];
  return Promise.all(agents.map(async (agent) => ({ ...agent, permissions: agent.permissions ?? { ...DEFAULT_AGENT_PERMISSIONS }, persona: await readFile(personaPath(agent.id), 'utf8') })));
}

export async function saveAgents(agents: AgentConfig[]): Promise<void> {
  const metadata = agents.map(({ persona: _persona, ...rest }) => rest);
  await writeAtomic(agentsPath, JSON.stringify(metadata, null, 2));
  for (const agent of agents) {
    await writeAtomic(personaPath(agent.id), agent.persona);
    await ensureAgentFiles(agent);
  }
}

export async function loadAgentInstructions(id: string): Promise<string> {
  return readFile(agentInstructionsPath(id), 'utf8');
}

export async function saveAgentInstructions(id: string, content: string): Promise<void> {
  await writeAtomic(agentInstructionsPath(id), content);
}

export async function loadAgentMemory(id: string): Promise<string> { return readFile(agentMemoryPath(id), 'utf8'); }
export async function saveAgentMemory(id: string, content: string): Promise<void> { await writeAtomic(agentMemoryPath(id), content); }
