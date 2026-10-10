export const TOOL_NAMES = ['Read', 'Grep', 'Glob', 'Agent', 'Write', 'Edit', 'Bash'] as const;
export const MCP_NAME = 'repo-facts';
export const MCP_NAMES = [MCP_NAME, 'playwright', 'chrome-devtools', 'bailian-image', 'bailian-video', 'jd-browser'] as const;
export const MCP_TOOL_NAMES: Record<(typeof MCP_NAMES)[number], readonly string[]> = {
  'repo-facts': ['repository_facts'],
  playwright: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_fill_form', 'browser_type', 'browser_press_key', 'browser_select_option', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests', 'browser_resize', 'browser_tabs', 'browser_evaluate', 'browser_wait_for'],
  'chrome-devtools': ['new_page', 'navigate_page', 'take_snapshot', 'take_screenshot', 'list_console_messages', 'list_network_requests', 'get_network_request', 'get_css_styles', 'click', 'fill', 'fill_form', 'press_key', 'type_text', 'resize_page', 'list_pages', 'select_page', 'evaluate_script', 'wait_for'],
  'bailian-image': ['generate_image'],
  'bailian-video': ['generate_video'],
  'jd-browser': ['browser_open', 'browser_search_products', 'browser_collect_reviews', 'browser_task_status', 'browser_get_state', 'browser_handoff', 'browser_check_login', 'browser_close'],
};
export const CONFIGURABLE_PERMISSION_TOOLS = [
  ...TOOL_NAMES,
  ...MCP_NAMES.flatMap((server) => MCP_TOOL_NAMES[server].map((tool) => `mcp__${server}__${tool}`)),
] as const;
export const DEFAULT_ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob', 'Agent', 'mcp__repo-facts__repository_facts',
  'mcp__playwright__browser_snapshot', 'mcp__playwright__browser_console_messages', 'mcp__playwright__browser_network_requests',
  'mcp__chrome-devtools__take_snapshot', 'mcp__chrome-devtools__list_console_messages', 'mcp__chrome-devtools__list_network_requests',
  'mcp__chrome-devtools__list_pages', 'mcp__chrome-devtools__wait_for',
] as const;
export const SKILL_NAME = 'workbench:repo-review';

export type PermissionSettings = { alwaysAllowTools: string[] };
export type McpTransport = 'sdk' | 'stdio' | 'http' | 'sse';
export type McpAuth = 'none' | 'bearer' | 'headers' | 'oauth';
export type McpToolInfo = { name: string; description?: string; annotations?: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean } };
export type McpCheck = { status: 'untested' | 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; checkedAt?: string; error?: string; tools: McpToolInfo[]; serverInfo?: { name: string; version: string } };
export type McpServerRecord = {
  id: string; name: string; source: 'builtin' | 'custom'; transport: McpTransport; auth: McpAuth;
  url?: string; command?: string; args?: string[]; timeoutMs?: number;
  envNames: string[]; headerNames: string[]; hasBearerToken: boolean;
  check: McpCheck; usedBy: Array<{ id: string; name: string; kind: AgentKind }>;
};
export type McpServerInput = {
  id: string; name: string; transport: Exclude<McpTransport, 'sdk'>; auth: McpAuth;
  url?: string; command?: string; args?: string[]; timeoutMs?: number;
  envNames: string[]; headerNames: string[];
  envValues?: Record<string, string>; headerValues?: Record<string, string>; bearerToken?: string;
};
export type AigcSettings = {
  imageModel: 'qwen-image-3.0' | 'qwen-image-3.0-pro' | 'qwen-image-2.1-pro';
  imageSize: '1024*1024' | '1024*768' | '768*1024';
  videoModel: 'wan3.0-video' | 'wan3.0-video-prime';
  videoDuration: number;
  videoResolution: '480P' | '720P';
};
export type MediaArtifact = {
  id: string;
  conversationId: string;
  turnId: string;
  kind: 'image' | 'video';
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  prompt: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  requestId?: string;
  taskId?: string;
  mimeType?: string;
  bytes?: number;
  error?: string;
  url?: string;
};

export type AgentKind = 'main' | 'subagent';
export type RemoteBrowserState = 'CREATED' | 'AI_RUNNING' | 'HUMAN_CONTROL' | 'VERIFYING' | 'COMPLETED' | 'FAILED' | 'UNVERIFIED' | 'EXPIRED' | 'CLOSED';
export type RemoteBrowserSummary = {
  conversationId: string;
  sessionId: string;
  state: RemoteBrowserState;
  viewMode: 'none' | 'view-only' | 'interactive';
  revision: number;
  pageUrl?: string;
  pageTitle?: string;
  liveUrlExpiresAt?: string;
  message?: string;
  profileStatus?: 'creating' | 'restored' | 'saved';
  loginVerified?: boolean;
  verification?: { source?: 'current-page' | 'account-probe'; host: string; authCookiePair: boolean | null; loginFormVisible: boolean; loginPromptVisible: boolean; signedInControlVisible: boolean; accountAreaVisible: boolean };
};
export type RemoteBrowserView = {
  configured: boolean;
  session: RemoteBrowserSummary | null;
  /** Short-lived bearer URL. Never persist this field in a conversation or SSE event. */
  liveUrl?: string;
};
export type JdProduct = {
  rank: number; sku: string; name: string; brand?: string; price?: string;
  promotion?: string; commentCount?: string; url: string;
  reviews: Array<{ text: string; helpful?: number }>;
};
export type JdTask = {
  id: string; conversationId: string; keyword: string; createdAt: string; updatedAt: string;
  sortRequested: 'sales'; sortApplied: boolean; products: JdProduct[];
  nextReviewIndex: number; status: 'collecting' | 'needs-human' | 'partial' | 'complete'; note?: string;
};
export type ModelOption = {
  id: string;
  name: string;
  source: 'qoder' | 'custom';
  enabled: boolean;
};
export type SkillRecord = {
  slug: string;
  name: string;
  description: string;
  body: string;
  path: string;
  editable: boolean;
  fileCount?: number;
  validation?: 'valid' | 'invalid';
  error?: string;
};
export type SkillTreeEntry = { path: string; kind: 'file' | 'directory'; size: number; text: boolean };
export type SkillValidationIssue = { path: string; code: string; message: string };
export type SkillDraftRecord = {
  id: string;
  version: number;
  origin: 'new' | 'edit' | 'markdown' | 'zip';
  sourceSlug?: string;
  slug?: string;
  createdAt: string;
  updatedAt: string;
  files: SkillTreeEntry[];
  validation?: { valid: boolean; discovered: boolean; issues: SkillValidationIssue[] };
};
export type AgentConfig = {
  id: string;
  kind: AgentKind;
  name: string;
  description: string;
  persona: string;
  model: string;
  maxTurns: number;
  tools: string[];
  skills: string[];
  mcpServers: string[];
  subAgentIds: string[];
  memoryEnabled: boolean;
  permissions: AgentPermissions;
};

export type AgentPermissions = {
  toolApproval: 'ask' | 'allow_all';
  pathAccess: 'workspace' | 'selected' | 'all';
  additionalDirectories: string[];
};

export const DEFAULT_AGENT_PERMISSIONS: AgentPermissions = {
  toolApproval: 'ask', pathAccess: 'workspace', additionalDirectories: [],
};

export type Bootstrap = {
  agents: AgentConfig[];
  workspacePath: string;
  skillNames: string[];
  skills: SkillRecord[];
  mcpNames: string[];
  mcpServers?: McpServerRecord[];
  sdkVersion: string;
  discoveryError?: string;
  models: ModelOption[];
  modelDiscoveryError?: string;
};

export type ConfigCatalog = {
  path: string;
  generatedAt: string;
  agents: Array<Omit<AgentConfig, 'persona'> & {
    metadataPath: string;
    personaPath: string;
    instructionsPath: string;
    memoryPath: string;
    savedAt: string;
  }>;
  skills: Array<{ name: string; description: string; path: string; savedAt: string }>;
  mcpServers?: McpServerRecord[];
  globalPermissions: PermissionSettings & { path: string; savedAt?: string };
  aigcSettings: AigcSettings & { path: string; savedAt?: string; credentialStatus: 'available' | 'invalid' };
};

export type RunEvent = {
  id: number;
  at: string;
  type: 'status' | 'text' | 'thinking' | 'tool' | 'approval' | 'memory' | 'usage' | 'error' | 'done' | 'diagnostic';
  label?: string;
  detail?: string;
  approvalId?: string;
  toolName?: string;
  credits?: number;
};

export type RunSummary = {
  id: string;
  agentId: string;
  prompt: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
  startedAt: string;
  events: RunEvent[];
};

export type ConversationTurn = {
  id: string;
  status: 'running' | 'done' | 'error' | 'interrupted';
  startedAt: string;
  endedAt?: string;
};

export type ConversationMessage = {
  id: string;
  turnId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
};

export type AgentQuestion = {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect?: boolean;
};

export type PendingInteraction = {
  id: string;
  turnId: string;
  kind: 'approval' | 'question';
  toolName: string;
  title: string;
  detail: string;
  origin?: string;
  category?: string;
  categoryLabel?: string;
  questions?: AgentQuestion[];
  at: string;
};

export type ConversationEvent = {
  id: number;
  turnId: string;
  at: string;
  type: 'status' | 'text' | 'tool' | 'agent_text' | 'interaction' | 'interaction_resolved' | 'memory' | 'usage' | 'error' | 'turn_end' | 'diagnostic';
  label?: string;
  detail?: string;
  toolName?: string;
  /** The Agent that performed this action. Older saved events may omit it. */
  agentId?: string;
  /** Set on an Agent delegation event. */
  targetAgentId?: string;
  /** Qoder tool ID identifies a call and pairs it with its result. */
  toolUseId?: string;
  parentToolUseId?: string;
  taskId?: string;
  interactionId?: string;
  credits?: number;
};

export type Conversation = {
  id: string;
  sdkSessionId: string;
  sdkEstablished?: boolean;
  /** Imported showcase history cannot resume its SDK session on another computer. */
  demoArchive?: boolean;
  agentId: string;
  agentName: string;
  status: 'idle' | 'running' | 'waiting' | 'interrupted';
  createdAt: string;
  updatedAt: string;
  config: { agent: AgentConfig; children: AgentConfig[]; instructions?: Record<string, string>; mcpToolNames?: Record<string, string[]>; modelFallbacks?: Array<{ agentId: string; requested: string; selected: string }> };
  turns: ConversationTurn[];
  messages: ConversationMessage[];
  events: ConversationEvent[];
  pending: PendingInteraction[];
  sessionAllowedTools?: string[];
  sessionAllowedCategories?: string[];
  lastEventId: number;
  artifacts?: MediaArtifact[];
};
