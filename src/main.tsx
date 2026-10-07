import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentConfig, AigcSettings, Bootstrap, ConfigCatalog, Conversation, ConversationEvent, McpServerRecord, PendingInteraction, PermissionSettings } from '../shared/types';
import { CONFIGURABLE_PERMISSION_TOOLS, DEFAULT_AGENT_PERMISSIONS, DEFAULT_ALLOWED_TOOLS, MCP_NAMES, MCP_TOOL_NAMES, TOOL_NAMES } from '../shared/types';
import { AgentFlow } from './AgentFlow';
import { McpManager } from './McpManager';
import { SkillManager } from './SkillManager';
import { displayStatus, eventLabel, t, type Language, type Theme } from './i18n';
import './styles.css';
import './light.css';

type Section = 'assembly' | 'skills' | 'permissions' | 'instructions' | 'memory' | 'aigc' | 'catalog' | 'run' | 'mcp';
type SaveNotice = { target: 'agent' | 'skill' | 'permissions' | 'instructions' | 'memory' | 'aigc'; ok: boolean; message: string };
type AigcSettingsResponse = AigcSettings & { credentialStatus: 'available' | 'invalid' };
function editableAigc(value: AigcSettingsResponse): AigcSettings {
  const { imageModel, imageSize, videoModel, videoDuration, videoResolution } = value;
  return { imageModel, imageSize, videoModel, videoDuration, videoResolution };
}
type AgentFiles = { instructions: string; memory: string; instructionPath: string; memoryPath: string; loaded: boolean; loading: boolean; instructionsDirty: boolean; memoryDirty: boolean; error?: string };
type ConversationListItem = Pick<Conversation, 'id' | 'agentId' | 'agentName' | 'status' | 'createdAt' | 'updatedAt'> & { firstMessage: string };
const defaultAllowed = new Set<string>(DEFAULT_ALLOWED_TOOLS);
const defaultTask = {
  zh: '请先用 repository_facts 工具了解示例仓库，再委派代码审查 Agent 检查 calculator.ts，并汇总有证据的问题。',
  en: 'First inspect the example repository with repository_facts, then delegate a review of calculator.ts to the code review Agent and summarize findings with evidence.',
};
const permissionGroups = [
  { label: 'Chrome DevTools', tools: MCP_TOOL_NAMES['chrome-devtools'].map((name) => `mcp__chrome-devtools__${name}`) },
  { label: 'Playwright', tools: MCP_TOOL_NAMES.playwright.map((name) => `mcp__playwright__${name}`) },
  { label: '文件与命令', tools: ['Write', 'Edit', 'Bash'] },
].map((group) => ({ ...group, tools: group.tools.filter((name) => !defaultAllowed.has(name)) }));

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}

function freshAgent(kind: AgentConfig['kind'], language: Language): AgentConfig {
  return {
    id: `draft-${Date.now()}`,
    kind,
    name: t(language, kind === 'main' ? '新主 Agent' : '新 Sub-Agent'),
    description: '',
    persona: language === 'en' ? `# ${kind === 'main' ? 'Main Agent' : 'Sub-Agent'}\n\nDescribe your role, task boundaries and output requirements.` : `# ${kind === 'main' ? '主 Agent' : 'Sub-Agent'}\n\n说明你的角色、任务边界与输出要求。`,
    model: 'auto', maxTurns: 8,
    tools: kind === 'main' ? ['Read', 'Grep', 'Glob', 'Agent'] : ['Read', 'Grep', 'Glob'],
    skills: [], mcpServers: [], subAgentIds: [], memoryEnabled: false, permissions: { ...DEFAULT_AGENT_PERMISSIONS },
  };
}

function agentFingerprint(agent: AgentConfig): string {
  const { id, kind, name, description, persona, model, maxTurns, tools, skills, mcpServers, subAgentIds, memoryEnabled, permissions } = agent;
  return JSON.stringify({
    id, kind, name, description, persona, model, maxTurns, tools, skills, mcpServers, subAgentIds, memoryEnabled,
    permissions: { toolApproval: permissions.toolApproval, pathAccess: permissions.pathAccess, additionalDirectories: permissions.additionalDirectories },
  });
}

function checkboxList(
  values: string[],
  choices: readonly string[],
  setValues: (values: string[]) => void,
  labels: Record<string, string> = {},
) {
  return <div className="check-grid">{choices.map((choice) => (
    <label className="check-item" key={choice}>
      <input type="checkbox" checked={values.includes(choice)} onChange={(event) => setValues(event.target.checked ? [...values, choice] : values.filter((item) => item !== choice))} />
      <span>{labels[choice] ?? choice}</span>
    </label>
  ))}</div>;
}

function LanguageIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c-2.6 2.5-4 5.5-4 9s1.4 6.5 4 9M12 3c2.6 2.5 4 5.5 4 9s-1.4 6.5-4 9" />
  </svg>;
}

function SunIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
  </svg>;
}

function App() {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('qoder-language') === 'en' ? 'en' : 'zh');
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('qoder-theme') === 'light' ? 'light' : 'dark');
  const l = (text: string) => t(language, text);
  const formatList = (items: string[]) => items.join(language === 'en' ? ', ' : '、');
  const formatPath = (value: string) => language === 'en' ? ({ workspace: 'working directory', selected: 'selected directories', all: 'all local paths' } as Record<string, string>)[value] ?? value : value;
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [permissionSettings, setPermissionSettings] = useState<PermissionSettings | null>(null);
  const [configCatalog, setConfigCatalog] = useState<ConfigCatalog | null>(null);
  const [aigcSettings, setAigcSettings] = useState<AigcSettingsResponse | null>(null);
  const [aigcDraft, setAigcDraft] = useState<AigcSettings | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [section, setSection] = useState<Section>('assembly');
  const [filesByAgent, setFilesByAgent] = useState<Record<string, AgentFiles>>({});
  const filesLoading = useRef(new Set<string>());
  const [fileReloadKey, setFileReloadKey] = useState(0);
  const [task, setTask] = useState(() => defaultTask[localStorage.getItem('qoder-language') === 'en' ? 'en' : 'zh']);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversationList, setConversationList] = useState<ConversationListItem[]>([]);
  const [dismissedInteractionId, setDismissedInteractionId] = useState('');
  const [questionSelections, setQuestionSelections] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState('');
  const [saveNotice, setSaveNotice] = useState<SaveNotice | null>(null);
  const [busy, setBusy] = useState(false);
  const eventsRef = useRef<EventSource | null>(null);
  const selected = useMemo(() => bootstrap?.agents.find((agent) => agent.id === selectedId), [bootstrap, selectedId]);
  const selectedFiles = filesByAgent[selectedId];
  const qoderModels = bootstrap?.models.filter((model) => model.source === 'qoder') ?? [];
  const customModels = bootstrap?.models.filter((model) => model.source === 'custom') ?? [];
  const draftDirty = Boolean(draft && (draft.id.startsWith('draft-') || !selected || agentFingerprint(draft) !== agentFingerprint(selected)));
  const assignableMcpNames = [...new Set([...(bootstrap?.mcpServers?.filter((item) => item.source === 'builtin' || item.check.status === 'connected' && item.check.tools.length > 0).map((item) => item.id) ?? MCP_NAMES), ...(draft?.mcpServers ?? [])])];
  const allPermissionGroups = [...permissionGroups, ...(bootstrap?.mcpServers?.filter((item) => item.source === 'custom' && item.check.status === 'connected').map((item) => ({ label: item.name, tools: item.check.tools.map((tool) => `mcp__${item.id}__${tool.name}`) })) ?? [])];

  useEffect(() => {
    localStorage.setItem('qoder-language', language);
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.title = language === 'en' ? 'Qoder Agent Workbench' : 'Qoder Agent 装配台';
    setTask((current) => current === defaultTask.zh || current === defaultTask.en ? defaultTask[language] : current);
  }, [language]);
  useEffect(() => {
    localStorage.setItem('qoder-theme', theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  async function refresh(preferredId?: string): Promise<Bootstrap> {
    const [data, permissions, catalog, aigc] = await Promise.all([api<Bootstrap>('/bootstrap'), api<PermissionSettings>('/permissions'), api<ConfigCatalog>('/config-catalog'), api<AigcSettingsResponse>('/aigc-settings')]);
    setBootstrap(data);
    setPermissionSettings(permissions);
    setConfigCatalog(catalog);
    setAigcSettings(aigc);
    setAigcDraft(editableAigc(aigc));
    if (data.discoveryError) setBanner(`${language === 'en' ? 'Skill discovery failed: ' : 'Skill 发现失败：'}${data.discoveryError}`);
    const savedId = localStorage.getItem('qoder-selected-agent');
    const id = [preferredId, selectedId, savedId].find((value) => value && data.agents.some((agent) => agent.id === value)) ?? data.agents[0]?.id ?? '';
    setSelectedId(id);
    if (id) localStorage.setItem('qoder-selected-agent', id);
    setDraft(data.agents.find((agent) => agent.id === id) ?? null);
    return data;
  }

  function clearSaveFeedback() { setSaveNotice(null); setBanner(''); }

  function showSaveNotice(target: SaveNotice['target'], ok: boolean, message: string) {
    setSaveNotice({ target, ok, message });
    setBanner(message);
  }

  async function refreshCatalog() {
    setConfigCatalog(await api<ConfigCatalog>('/config-catalog'));
  }
  async function refreshMcp() {
    const servers = await api<McpServerRecord[]>('/mcp-servers');
    setBootstrap((current) => current ? { ...current, mcpServers: servers, mcpNames: servers.map((item) => item.id) } : current);
    await refreshCatalog();
  }

  async function saveAigc() {
    if (!aigcDraft) return;
    setBusy(true);
    try {
      const saved = await api<AigcSettingsResponse>('/aigc-settings', { method: 'PUT', body: JSON.stringify(aigcDraft) });
      setAigcSettings(saved);
      setAigcDraft(editableAigc(saved));
      await refreshCatalog();
      showSaveNotice('aigc', true, language === 'en' ? 'AIGC settings saved to data/aigc-settings.json. Future generation tasks will use them.' : 'AIGC 规格已保存到 data/aigc-settings.json；后续生成任务使用新设置。');
    } catch (error) { showSaveNotice('aigc', false, `${language === 'en' ? 'Save failed: ' : '保存失败：'}${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  useEffect(() => { void refresh().catch((error) => setBanner(error.message)); return () => eventsRef.current?.close(); }, []);
  useEffect(() => {
    if (section === 'permissions') void api<PermissionSettings>('/permissions').then(setPermissionSettings).catch((error) => setBanner((error as Error).message));
    if (section === 'catalog') void refreshCatalog().catch((error) => setBanner((error as Error).message));
    if (section === 'mcp') void refreshMcp().catch((error) => setBanner((error as Error).message));
  }, [section]);
  useEffect(() => {
    if (!selectedId || selectedId.startsWith('draft-') || filesLoading.current.has(selectedId)) return;
    if (filesByAgent[selectedId]?.instructionsDirty || filesByAgent[selectedId]?.memoryDirty) return;
    const id = selectedId;
    filesLoading.current.add(id);
    setFilesByAgent((current) => ({ ...current, [id]: { instructions: '', memory: '', instructionPath: '', memoryPath: '', loaded: false, loading: true, instructionsDirty: false, memoryDirty: false } }));
    void Promise.all([
      api<{ content: string; path: string }>(`/agents/${id}/instructions`),
      api<{ content: string; path: string }>(`/agents/${id}/memory`),
    ]).then(([rules, memory]) => {
      setFilesByAgent((current) => ({ ...current, [id]: { instructions: rules.content, memory: memory.content, instructionPath: rules.path, memoryPath: memory.path, loaded: true, loading: false, instructionsDirty: false, memoryDirty: false } }));
    }).catch((error) => {
      setFilesByAgent((current) => ({ ...current, [id]: { ...current[id], loading: false, error: (error as Error).message } }));
    }).finally(() => { filesLoading.current.delete(id); });
  }, [selectedId, fileReloadKey]);

  function reloadAgentFiles() {
    if (!selectedId || selectedId.startsWith('draft-') || filesLoading.current.has(selectedId)) return;
    if (selectedFiles?.instructionsDirty || selectedFiles?.memoryDirty) return;
    setFileReloadKey((value) => value + 1);
  }
  useEffect(() => {
    if (!selectedId || selectedId.startsWith('draft-')) { setConversation(null); setConversationList([]); return; }
    let cancelled = false;
    eventsRef.current?.close();
    void api<ConversationListItem[]>(`/conversations?agentId=${encodeURIComponent(selectedId)}`).then(async (items) => {
      if (cancelled) return;
      setConversationList(items);
      const saved = localStorage.getItem(`qoder-conversation:${selectedId}`);
      const choice = items.find((item) => item.id === saved) ?? items[0];
      if (!choice) { setConversation(null); return; }
      const item = await api<Conversation>(`/conversations/${choice.id}`);
      if (cancelled) return;
      setConversation(item);
      setTask('');
      localStorage.setItem(`qoder-conversation:${selectedId}`, choice.id);
      if (item.pending.length || item.status === 'interrupted') setSection('run');
      if (item.status === 'running' || item.status === 'waiting') connectConversation(choice.id, item.lastEventId);
    }).catch((error) => { if (!cancelled) setBanner((error as Error).message); });
    return () => { cancelled = true; eventsRef.current?.close(); };
  }, [selectedId]);
  useEffect(() => { setQuestionSelections({}); setCustomAnswers({}); setDismissedInteractionId(''); }, [conversation?.pending[0]?.id]);

  function choose(agent: AgentConfig) {
    setSelectedId(agent.id);
    localStorage.setItem('qoder-selected-agent', agent.id);
    setDraft({ ...agent, tools: [...agent.tools], skills: [...agent.skills], mcpServers: [...agent.mcpServers], subAgentIds: [...agent.subAgentIds], permissions: { ...agent.permissions, additionalDirectories: [...agent.permissions.additionalDirectories] } });
    setSection('assembly');
    setTask('');
    clearSaveFeedback();
  }

  function change(patch: Partial<AgentConfig>) { setDraft((current) => current ? { ...current, ...patch } : current); clearSaveFeedback(); }

  async function toggleGlobalTool(toolName: string, allowed: boolean) {
    if (!permissionSettings) return;
    setBusy(true); setBanner(language === 'en' ? 'Saving global tool permission…' : '正在保存全局工具授权…');
    try {
      const updated = await api<PermissionSettings>('/permissions', { method: 'PATCH', body: JSON.stringify({ toolName, allowed }) });
      setPermissionSettings(updated);
      void refreshCatalog().catch((error) => setBanner((error as Error).message));
      showSaveNotice('permissions', true, language === 'en' ? `${allowed ? 'Globally allowed' : 'Global permission revoked for'} ${toolName} · saved to data/permission-settings.json` : `${allowed ? '已全局允许' : '已取消全局允许'} ${toolName} · 已保存到 data/permission-settings.json`);
    } catch (error) { showSaveNotice('permissions', false, `${language === 'en' ? 'Save failed: ' : '保存失败：'}${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!draft) return;
    if (!Number.isSafeInteger(draft.maxTurns) || draft.maxTurns < 1 || draft.maxTurns > 1000) {
      showSaveNotice('agent', false, language === 'en' ? 'Save failed: maximum turns must be an integer from 1 to 1000.' : '保存失败：最大轮数必须是 1–1000 的整数');
      return;
    }
    setBusy(true); setBanner(language === 'en' ? 'Saving and verifying Agent settings…' : '正在保存并核对 Agent 配置…');
    let written = false;
    try {
      const { id: _id, ...input } = draft;
      input.permissions = { ...draft.permissions, additionalDirectories: draft.permissions.additionalDirectories.map((item) => item.trim()).filter(Boolean) };
      const created = draft.id.startsWith('draft-');
      const result = await api<AgentConfig>(created ? '/agents' : `/agents/${draft.id}`, { method: created ? 'POST' : 'PUT', body: JSON.stringify(input) });
      written = true;
      const reloaded = await refresh(result.id);
      const verified = reloaded.agents.find((agent) => agent.id === result.id);
      if (!verified || agentFingerprint(verified) !== agentFingerprint(result)) throw new Error(language === 'en' ? 'Saved Agent settings did not match the reloaded file; check the configuration catalog.' : '已写入但重新读取的 Agent 配置不一致，请查看配置清单');
      showSaveNotice('agent', true, language === 'en' ? `${result.name} saved · maximum turns ${result.maxTurns} · applies to new conversations · data/agents.json` : `${result.name} 已保存 · 最大轮数 ${result.maxTurns} · 新对话生效 · data/agents.json`);
    } catch (error) { showSaveNotice('agent', false, `${language === 'en' ? written ? 'Saved, but reload verification failed' : 'Save failed' : written ? '配置已写入，但回读核对失败' : '保存失败'}: ${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!draft || draft.id.startsWith('draft-')) { setDraft(null); return; }
    if (!window.confirm(language === 'en' ? `Delete ${draft.name}?` : `删除 ${draft.name}？`)) return;
    setBusy(true);
    try { await api<void>(`/agents/${draft.id}`, { method: 'DELETE' }); await refresh(''); setBanner(language === 'en' ? 'Agent deleted' : 'Agent 已删除'); }
    catch (error) { setBanner((error as Error).message); }
    finally { setBusy(false); }
  }

  async function saveInstructions() {
    const id = selectedId;
    const content = filesByAgent[id]?.instructions;
    if (!id || !filesByAgent[id]?.loaded || content === undefined) return;
    setBusy(true);
    try {
      await api(`/agents/${id}/instructions`, { method: 'PUT', body: JSON.stringify({ content }) });
      setFilesByAgent((current) => ({ ...current, [id]: { ...current[id], instructionsDirty: current[id].instructions !== content } }));
      void refreshCatalog().catch((error) => setBanner((error as Error).message));
      showSaveNotice('instructions', true, language === 'en' ? `Project rules saved to ${filesByAgent[id].instructionPath} · applies to new conversations` : `项目规则已保存到 ${filesByAgent[id].instructionPath} · 新对话生效`);
    }
    catch (error) { showSaveNotice('instructions', false, `${language === 'en' ? 'Save failed: ' : '保存失败：'}${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function saveMemory() {
    const id = selectedId;
    const content = filesByAgent[id]?.memory;
    if (!id || !filesByAgent[id]?.loaded || content === undefined) return;
    setBusy(true);
    try {
      await api(`/agents/${id}/memory`, { method: 'PUT', body: JSON.stringify({ content }) });
      setFilesByAgent((current) => ({ ...current, [id]: { ...current[id], memoryDirty: current[id].memory !== content } }));
      void refreshCatalog().catch((error) => setBanner((error as Error).message));
      showSaveNotice('memory', true, language === 'en' ? `Agent memory saved to ${filesByAgent[id].memoryPath} · read by new conversations` : `Agent 记忆已保存到 ${filesByAgent[id].memoryPath} · 新会话读取`);
    }
    catch (error) { showSaveNotice('memory', false, `${language === 'en' ? 'Save failed: ' : '保存失败：'}${(error as Error).message}`); }
    finally { setBusy(false); }
  }

  async function refreshModels() {
    setBusy(true);
    try {
      const result = await api<{ models: Bootstrap['models']; error?: string }>('/models');
      setBootstrap((current) => current ? { ...current, models: result.models, modelDiscoveryError: result.error } : current);
      setBanner(result.error ? `${language === 'en' ? 'Model discovery failed: ' : '模型发现失败：'}${result.error}` : language === 'en' ? `Model list refreshed: ${result.models.length} models` : `已刷新模型列表，共 ${result.models.length} 个`);
    } catch (error) { setBanner((error as Error).message); }
    finally { setBusy(false); }
  }

  async function refreshSkills() {
    const [result, catalog] = await Promise.all([api<{ skills: Bootstrap['skills']; skillNames: string[] }>('/skills'), api<ConfigCatalog>('/config-catalog')]);
    setBootstrap((current) => current ? { ...current, skills: result.skills, skillNames: result.skillNames } : current);
    setConfigCatalog(catalog);
  }

  function connectConversation(id: string, after = 0) {
    eventsRef.current?.close();
    const source = new EventSource(`/api/conversations/${id}/events?after=${after}`);
    eventsRef.current = source;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ConversationEvent;
      setConversation((current) => {
        if (!current || current.id !== id || current.events.some((item) => item.id === event.id)) return current;
        const next = { ...current, events: [...current.events, event], lastEventId: event.id };
        if (event.type === 'text') {
          const messageId = `assistant-${event.turnId}`;
          const existing = next.messages.find((item) => item.id === messageId);
          next.messages = existing
            ? next.messages.map((item) => item.id === messageId ? { ...item, content: item.content + (event.detail ?? '') } : item)
            : [...next.messages, { id: messageId, turnId: event.turnId, role: 'assistant', content: event.detail ?? '', at: event.at }];
        }
        if (event.type === 'interaction') next.status = 'waiting';
        if (event.type === 'interaction_resolved') next.status = 'running';
        return next;
      });
      if (event.type === 'interaction' || event.type === 'interaction_resolved' || event.type === 'turn_end' || (event.type === 'status' && event.label?.startsWith('媒体'))) {
        void api<Conversation>(`/conversations/${id}`).then((item) => {
          setConversation((current) => current?.id === id ? item : current);
        }).catch((error) => setBanner((error as Error).message));
      }
      if (event.type === 'turn_end') {
        source.close();
        void api<ConversationListItem[]>(`/conversations?agentId=${encodeURIComponent(selectedId)}`).then(setConversationList);
      }
    };
    source.onerror = () => { setBanner(language === 'en' ? 'Event stream disconnected temporarily; reconnecting…' : '事件流暂时断开，正在自动重连。'); };
  }

  async function start(smoke = false) {
    if (!draft || draft.id.startsWith('draft-')) { setBanner(l('请先保存 Agent')); return; }
    if (draftDirty) { setBanner(language === 'en' ? 'This Agent has unsaved changes. Save its configuration before starting a new conversation.' : '当前 Agent 有未保存的修改，请先保存配置，再开启新对话'); setSection('assembly'); return; }
    setBusy(true); setBanner(''); setSection('run');
    try {
      const content = smoke ? (language === 'en' ? 'Read-only check: explain in one sentence what add in calculator.ts does. Do not call Sub-Agents or modify files.' : '只读检查：请用一句话说明 calculator.ts 中 add 函数做什么。不要调用子 Agent，不要修改文件。') : task.trim();
      if (!content) throw new Error(language === 'en' ? 'Enter a task.' : '请输入任务内容');
      const item = await api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ agentId: draft.id, content }) });
      setConversation(item);
      setTask('');
      localStorage.setItem(`qoder-conversation:${draft.id}`, item.id);
      setConversationList((current) => [{ id: item.id, agentId: item.agentId, agentName: item.agentName, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt, firstMessage: content.slice(0, 100) }, ...current]);
      connectConversation(item.id, item.lastEventId);
    } catch (error) { setBanner((error as Error).message); }
    finally { setBusy(false); }
  }

  async function followUp() {
    if (!conversation || !task.trim()) return;
    setBusy(true); setBanner('');
    try {
      const content = task.trim();
      const item = conversation.demoArchive
        ? await api<Conversation>('/conversations', { method: 'POST', body: JSON.stringify({ agentId: conversation.agentId, content }) })
        : await api<Conversation>(`/conversations/${conversation.id}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
      setConversation(item);
      setTask('');
      if (conversation.demoArchive) {
        localStorage.setItem(`qoder-conversation:${item.agentId}`, item.id);
        setConversationList((current) => [{ id: item.id, agentId: item.agentId, agentName: item.agentName, status: item.status, createdAt: item.createdAt, updatedAt: item.updatedAt, firstMessage: content.slice(0, 100) }, ...current]);
        setBanner(language === 'en' ? 'A new conversation started with your account. The imported history was not passed to the model.' : '已用你的账号开始新对话；旧演示记录未作为模型上下文传入。');
      }
      connectConversation(item.id, item.lastEventId);
    } catch (error) { setBanner((error as Error).message); }
    finally { setBusy(false); }
  }

  async function selectConversation(id: string) {
    try {
      eventsRef.current?.close();
      const item = await api<Conversation>(`/conversations/${id}`);
      setConversation(item);
      localStorage.setItem(`qoder-conversation:${item.agentId}`, id);
      setDismissedInteractionId('');
      if (item.status === 'running' || item.status === 'waiting') connectConversation(id, item.lastEventId);
    } catch (error) { setBanner((error as Error).message); }
  }

  async function decideInteraction(item: PendingInteraction, action: 'allow' | 'allow_session_tool' | 'allow_session_category' | 'allow_global_tool' | 'deny' | 'answer') {
    if (!conversation) return;
    const answers: Record<string, string> = {};
    if (action === 'answer') {
      for (const question of item.questions ?? []) {
        const answer = customAnswers[question.question]?.trim() || (questionSelections[question.question] ?? []).join(', ');
        if (!answer) { setBanner(language === 'en' ? `Please answer: ${question.question}` : `请回答：${question.question}`); return; }
        answers[question.question] = answer;
      }
    }
    setBusy(true); setBanner('');
    try {
      await api(`/conversations/${conversation.id}/interactions/${item.id}`, { method: 'POST', body: JSON.stringify(action === 'answer' ? { action, answers } : { action }) });
      setDismissedInteractionId(item.id);
      setConversation(await api<Conversation>(`/conversations/${conversation.id}`));
      if (action === 'allow_global_tool') { setPermissionSettings(await api<PermissionSettings>('/permissions')); void refreshCatalog().catch((error) => setBanner((error as Error).message)); }
    } catch (error) { setBanner((error as Error).message); }
    finally { setBusy(false); }
  }

  async function stop() {
    if (!conversation) return;
    try { await api(`/conversations/${conversation.id}/interrupt`, { method: 'POST' }); }
    catch (error) { setBanner((error as Error).message); }
  }

  const activity = conversation?.events.filter((event) => event.type !== 'text').slice(-150) ?? [];
  const pendingInteraction = conversation?.pending[0];
  const modalInteraction = pendingInteraction?.id === dismissedInteractionId ? undefined : pendingInteraction;

  useEffect(() => {
    if (!conversation || (conversation.status !== 'running' && !conversation.artifacts?.some((item) => item.status === 'queued' || item.status === 'running'))) return;
    const id = conversation.id;
    const timer = window.setInterval(() => {
      void api<Conversation>(`/conversations/${id}`).then((item) => setConversation((current) => current?.id === id ? item : current)).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [conversation?.id, conversation?.status, conversation?.artifacts?.map((item) => item.status).join(',')]);

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">Q</span><div><strong>Agent Workbench</strong><small>Qoder SDK · {l('本地探索')}</small></div></div>
      <div className="side-heading">AGENTS <span>{bootstrap?.agents.length ?? 0}</span></div>
      <div className="agent-list">{bootstrap?.agents.map((agent) => <button className={`agent-item ${selectedId === agent.id ? 'active' : ''}`} key={agent.id} onClick={() => choose(agent)}>
        <span className={`agent-avatar ${agent.kind}`}>{agent.kind === 'main' ? '◇' : '↳'}</span><span><strong>{agent.name}</strong><small>{agent.kind === 'main' ? l('主 Agent') : 'Sub-Agent'}</small></span>
      </button>)}</div>
      <div className="sidebar-actions"><button onClick={() => { const item = freshAgent('main', language); setDraft(item); setSelectedId(item.id); setSection('assembly'); clearSaveFeedback(); }}>＋ {l('主 Agent')}</button><button onClick={() => { const item = freshAgent('subagent', language); setDraft(item); setSelectedId(item.id); setSection('assembly'); clearSaveFeedback(); }}>＋ Sub-Agent</button></div>
      <div className="sidebar-config"><div className="side-heading">{l('配置')}</div><button className={`sidebar-nav-item ${section === 'mcp' ? 'active' : ''}`} onClick={() => setSection('mcp')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M8 4h8v5H8zM4 15h6v5H4zM14 15h6v5h-6zM12 9v3m-5 3v-3h10v3" /></svg>{l('MCP 服务')}</button><button className={`sidebar-nav-item ${section === 'skills' ? 'active' : ''}`} onClick={() => setSection('skills')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 16h8" /></svg>Skills</button></div>
      <div className="sidebar-foot"><span className="status-dot" />SDK {bootstrap?.sdkVersion ?? '…'}<br /><small>{l('运行服务仅监听 127.0.0.1')}</small></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div><div className="eyebrow">AGENT BUILDER / LOCAL PROTOTYPE</div><h1>{section === 'mcp' ? l('MCP 服务') : section === 'skills' ? 'Skills' : draft?.name ?? l('Agent 装配台')}</h1><p>{section === 'mcp' ? l('配置和校验 MCP，再把服务装配到需要的 Agent。') : section === 'skills' ? (language === 'en' ? 'Create, import, validate and assign Skills.' : '创建、导入、校验和装配 Skill。') : draft?.description || l('配置角色、能力与记忆，然后在示例仓库中运行任务。')}</p></div><div className="top-actions">{section !== 'mcp' && section !== 'skills' && <><button className="button ghost" onClick={() => void start(true)} disabled={busy || !bootstrap}>{l('SDK 冒烟验证')}</button><button className="button primary" onClick={() => setSection('run')} disabled={busy || !draft}>{l('打开运行台')} <span>↗</span></button></>}<div className="display-controls" role="group" aria-label={language === 'en' ? 'Display preferences' : '显示偏好'}><button type="button" className="display-toggle language-toggle" onClick={() => setLanguage((current) => current === 'zh' ? 'en' : 'zh')} aria-label={language === 'en' ? 'Switch to Chinese' : '切换为英文'} title={language === 'en' ? 'Switch to Chinese' : '切换为英文'}><LanguageIcon /></button><button type="button" className="display-toggle theme-toggle" onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')} aria-label={language === 'en' ? (theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme') : (theme === 'dark' ? '切换为浅色主题' : '切换为深色主题')} title={language === 'en' ? (theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme') : (theme === 'dark' ? '切换为浅色主题' : '切换为深色主题')}><SunIcon /></button></div></div></header>
      {banner && <div className="banner" role="status">{banner}<button onClick={() => setBanner('')}>×</button></div>}
      {section !== 'mcp' && section !== 'skills' && <div className="tabs"><button className={section === 'assembly' ? 'active' : ''} onClick={() => setSection('assembly')}>{l('装配配置')}</button><button className={section === 'permissions' ? 'active' : ''} onClick={() => setSection('permissions')}>{l('工具授权')}</button><button className={section === 'instructions' ? 'active' : ''} onClick={() => setSection('instructions')}>{l('项目规则')}</button><button className={section === 'memory' ? 'active' : ''} onClick={() => setSection('memory')}>{l('Agent 记忆')}</button><button className={section === 'aigc' ? 'active' : ''} onClick={() => setSection('aigc')}>{l('AIGC 设置')}</button><button className={section === 'catalog' ? 'active' : ''} onClick={() => setSection('catalog')}>{l('配置清单')}</button><button className={section === 'run' ? 'active' : ''} onClick={() => setSection('run')}>{l('运行台')} {(conversation?.status === 'running' || conversation?.status === 'waiting') && <span className="running-dot" />}</button></div>}

      {section === 'mcp' && <McpManager language={language} servers={bootstrap?.mcpServers ?? []} onReload={refreshMcp} currentAgent={draft?.id.startsWith('draft-') ? undefined : draft?.name} onAssign={(id) => { if (!draft) return; change({ mcpServers: draft.mcpServers.includes(id) ? draft.mcpServers : [...draft.mcpServers, id] }); setSection('assembly'); setBanner(l('已加入当前 Agent 草稿，请保存 Agent 配置')); }} />}

      {section === 'assembly' && draft && <>
      {draft.kind === 'main' && <AgentFlow root={draft} children={draft.subAgentIds.map((id) => bootstrap?.agents.find((agent) => agent.id === id)).filter((agent): agent is AgentConfig => Boolean(agent))} mode="assembly" language={language} />}
      <div className="content-grid">
        <div className="column"><section className="panel"><div className="panel-title"><span className="step">01</span><div><h2>{l('身份与人格')}</h2><p>{l('人格 Markdown 会作为 Agent 提示词传给 SDK。')}</p></div></div>
          <div className="two-fields"><label>{l('Agent 名称')}<input value={draft.name} onChange={(event) => change({ name: event.target.value })} /></label><label>{l('角色类型')}<select value={draft.kind} onChange={(event) => change({ kind: event.target.value as AgentConfig['kind'], subAgentIds: [], tools: event.target.value === 'subagent' ? draft.tools.filter((name) => name !== 'Agent') : draft.tools })}><option value="main">{l('主 Agent')}</option><option value="subagent">Sub-Agent</option></select></label></div>
          <label>{l('用途描述')}<input value={draft.description} onChange={(event) => change({ description: event.target.value })} placeholder={l('告诉主 Agent 何时调用这个角色')} /></label>
          <label>{l('人格文件 · persona.md')}<textarea className="code-editor" rows={9} value={draft.persona} onChange={(event) => change({ persona: event.target.value })} /></label>
        </section>
        <section className="panel"><div className="panel-title"><span className="step">02</span><div><h2>{l('执行参数')}</h2><p>{l('模型来自当前 Qoder 账号的实时列表。')}</p></div></div><div className="two-fields"><label>{l('模型')}<select value={draft.model} onChange={(event) => change({ model: event.target.value })}>{!bootstrap?.models.some((model) => model.id === draft.model) && <option value={draft.model}>{draft.model} · {l('当前不可用')}</option>}<optgroup label={l('Qoder 模型')}>{qoderModels.map((model) => <option key={model.id} value={model.id} disabled={!model.enabled}>{model.name} ({model.id})</option>)}</optgroup><optgroup label={l('已接入的自定义模型')}>{customModels.map((model) => <option key={model.id} value={model.id} disabled={!model.enabled}>{model.name} ({model.id})</option>)}</optgroup></select></label><label>{l('最大轮数')}<input type="number" min="1" max="1000" step="1" value={draft.maxTurns} onChange={(event) => change({ maxTurns: Number(event.target.value) })} /></label></div><p className="permission-hint">{l('SDK maxTurns 限制当前 Query 的模型与工具往返，范围 1–1000；持续对话会复用该 Query。保存后只对新对话生效；被委派的 Sub-Agent 的此值可能由 SDK 忽略。')}</p><div className="model-note"><span>{customModels.length ? (language === 'en' ? `${customModels.length} custom models connected. ` : `当前账号有 ${customModels.length} 个已接入模型。`) : l('当前账号没有返回已接入模型。')}{l('在 Qoder CLI 的 /model 中添加或更新，然后刷新列表。')}</span><button type="button" onClick={() => void refreshModels()} disabled={busy}>{l('刷新模型')}</button></div>{bootstrap?.modelDiscoveryError && <p className="field-error">{l('模型发现失败：')}{bootstrap.modelDiscoveryError}</p>}<label className="switch-row"><input type="checkbox" checked={draft.memoryEnabled} onChange={(event) => change({ memoryEnabled: event.target.checked })} /><span><strong>{l('启用 Agent 专属记忆')}</strong><small>{l('直接运行时尝试自动生成；被委派时读取已有记忆。')}</small></span></label></section></div>
        <div className="column"><section className="panel"><div className="panel-title"><span className="step">03</span><div><h2>{l('工具与扩展')}</h2><p>{l('选择 Agent 能看见的工具、Skill 和 MCP；默认授权在下方单独设置。')}</p></div></div><h3>{l('可用工具')}</h3>{checkboxList(draft.tools, draft.kind === 'subagent' ? TOOL_NAMES.filter((name) => name !== 'Agent') : TOOL_NAMES, (values) => change({ tools: values }), { Read: l('Read · 读取文件'), Grep: l('Grep · 搜索内容'), Glob: l('Glob · 搜索文件'), Agent: l('Agent · 委派任务'), Write: l('Write · 创建文件'), Edit: l('Edit · 编辑文件'), Bash: l('Bash · 运行命令') })}<div className="section-divider" /><h3>Skills</h3>{checkboxList(draft.skills, bootstrap?.skillNames ?? [], (values) => change({ skills: values }))}<button className="inline-link" onClick={() => setSection('skills')}>{l('创建或编辑 Skill')} ↗</button><div className="section-divider" /><h3>{l('MCP Servers')}</h3>{checkboxList(draft.mcpServers, assignableMcpNames, (values) => change({ mcpServers: values }), { 'repo-facts': l('repo-facts · 示例仓库信息'), playwright: l('Playwright · 页面交互与截图'), 'chrome-devtools': l('Chrome DevTools · 页面调试') })}<button className="inline-link" onClick={() => setSection('mcp')}>{l('管理 MCP 服务')} ↗</button><p className="extension-note">{l('浏览器 MCP 使用独立的无痕浏览器；工具调用会显示在运行台。')}</p></section>
          <section className="panel agent-permissions"><div className="panel-title"><span className="step">04</span><div><h2>{l('此 Agent 的默认授权')}</h2><p>{l('保存后用于新对话；已建立的会话继续使用创建时的配置。')}</p></div></div>
            <label>{l('工具调用')}<select value={draft.permissions.toolApproval} onChange={(event) => change({ permissions: { ...draft.permissions, toolApproval: event.target.value as AgentConfig['permissions']['toolApproval'] } })}><option value="ask">{l('按现有规则审批')}</option><option value="allow_all">{l('默认允许所有已装配工具')}</option></select></label>
            <p className="permission-hint">{l('只授权当前 Agent 已勾选的工具与 MCP；新增工具仍需先装配。Agent 提问依然需要你回答。')}</p>
            <div className="section-divider" />
            <label>{l('本地路径')}<select value={draft.permissions.pathAccess} onChange={(event) => change({ permissions: { ...draft.permissions, pathAccess: event.target.value as AgentConfig['permissions']['pathAccess'] } })}><option value="workspace">{l('仅当前工作目录')}</option><option value="selected">{l('工作目录 + 指定目录')}</option><option value="all">{l('所有本地路径（当前系统用户可访问）')}</option></select></label>
            <p className="permission-hint">{l('工作目录：')}{bootstrap?.workspacePath ?? '…'}{l('。额外目录通过 Qoder SDK 授权。')}</p>
            {draft.permissions.pathAccess === 'selected' && <label>{l('额外目录（每行一个绝对路径）')}<textarea rows={4} spellCheck={false} value={draft.permissions.additionalDirectories.join('\n')} onChange={(event) => change({ permissions: { ...draft.permissions, additionalDirectories: event.target.value.split('\n') } })} placeholder="/path/to/another-project" /></label>}
            {draft.permissions.pathAccess === 'all' && <p className="permission-warning">{l('此 Agent 可在当前系统用户权限内访问本地文件。仅给可信任的 Agent 和任务启用；它不会突破操作系统权限。')}</p>}
            <p className="permission-hint">{l('目录授权不是操作系统沙箱；Bash 与外部 MCP 进程仍以本机用户身份运行。被委派的 Sub-Agent 使用主会话的目录范围。')}</p>
          </section>
          {draft.kind === 'main' && <section className="panel"><div className="panel-title"><span className="step">05</span><div><h2>{l('Sub-Agent 装配')}</h2><p>{l('主 Agent 可向下委派一层；委派由模型决定。')}</p></div></div>{checkboxList(draft.subAgentIds, bootstrap?.agents.filter((agent) => agent.kind === 'subagent').map((agent) => agent.id) ?? [], (values) => change({ subAgentIds: values }), Object.fromEntries((bootstrap?.agents ?? []).map((agent) => [agent.id, agent.name])))}{!bootstrap?.agents.some((agent) => agent.kind === 'subagent') && <p className="empty-text">{l('先创建一个 Sub-Agent。')}</p>}</section>}
        </div><div className="form-actions"><button className="button danger" onClick={() => void remove()} disabled={busy}>{l('删除 Agent')}</button><span>{draftDirty ? l('有未保存的配置修改；新对话仍会使用上次保存的值。') : l('已保存配置可在“配置清单”查看。')}</span><button className="button primary" onClick={() => void save()} disabled={busy}>{l('保存配置')}</button></div>
        {saveNotice?.target === 'agent' && <p className={`save-feedback ${saveNotice.ok ? 'ok' : 'error'}`}>{saveNotice.message}</p>}
      </div></>}

      {section === 'skills' && <SkillManager language={language} skills={bootstrap?.skills ?? []} discovered={bootstrap?.skillNames ?? []} agents={bootstrap?.agents ?? []} currentAgent={draft && !draft.id.startsWith('draft-') ? draft : undefined} onReload={refreshSkills} onAssign={(name) => { if (!draft) return; change({ skills: draft.skills.includes(name) ? draft.skills : [...draft.skills, name] }); setSection('assembly'); setBanner(l('已加入当前 Agent 草稿，请保存 Agent 配置')); }} />}

      {section === 'aigc' && <section className="panel wide"><div className="panel-title"><span className="step">AI</span><div><h2>{l("百炼生成设置")}</h2><p>{l("此处控制媒体生成模型与规格；Qoder 对话模型在 Agent 装配中设置。")}</p></div></div><p>{l('凭据状态：')}{aigcSettings?.credentialStatus === 'available' ? l('可用') : l('配置错误或不可用')}{l('。凭据从本地 api-key.md 读取，不在页面展示。')}</p>{aigcDraft && <><div className="two-fields"><label>{l("图片模型")}<select value={aigcDraft.imageModel} onChange={(event) => setAigcDraft({ ...aigcDraft, imageModel: event.target.value as AigcSettings['imageModel'] })}><option value="qwen-image-3.0">qwen-image-3.0</option><option value="qwen-image-3.0-pro">qwen-image-3.0-pro</option><option value="qwen-image-2.1-pro">qwen-image-2.1-pro</option></select></label><label>{l("图片尺寸")}<select value={aigcDraft.imageSize} onChange={(event) => setAigcDraft({ ...aigcDraft, imageSize: event.target.value as AigcSettings['imageSize'] })}><option value="1024*1024">1024 × 1024</option><option value="1024*768">1024 × 768</option><option value="768*1024">768 × 1024</option></select></label></div><div className="two-fields"><label>{l("视频模型")}<select value={aigcDraft.videoModel} onChange={(event) => setAigcDraft({ ...aigcDraft, videoModel: event.target.value as AigcSettings['videoModel'] })}><option value="wan3.0-video">wan3.0-video</option><option value="wan3.0-video-prime">wan3.0-video-prime</option></select></label><label>{l("视频分辨率")}<select value={aigcDraft.videoResolution} onChange={(event) => setAigcDraft({ ...aigcDraft, videoResolution: event.target.value as AigcSettings['videoResolution'] })}><option value="480P">480P</option><option value="720P">720P</option></select></label></div><label>{l("视频时长（秒）")}<input type="number" min={2} max={15} value={aigcDraft.videoDuration} onChange={(event) => setAigcDraft({ ...aigcDraft, videoDuration: Number(event.target.value) })} /></label><div className="form-actions"><span>{l("默认每次生成 1 张图或 1 段视频；已创建的任务保留原模型。")}</span><button className="button primary" disabled={busy} onClick={() => void saveAigc()}>{l("保存生成设置")}</button></div>{saveNotice?.target === 'aigc' && <p className={`save-feedback ${saveNotice.ok ? 'ok' : 'error'}`}>{saveNotice.message}</p>}</>}</section>}

      {section === 'catalog' && <section className="panel wide"><div className="panel-title"><span className="step">CF</span><div><h2>{l("已保存配置清单")}</h2><p>{l("从磁盘上的 Agent、Skill 与全局授权生成，便于核对实际保存值。")}</p></div></div><p className="agent-file-path">{l('清单文件：')}{configCatalog?.path ?? l('正在读取…')}</p><div className="catalog-list">{configCatalog?.agents.map((agent) => <article className="catalog-item" key={agent.id}><div className="catalog-title"><strong>{agent.name}</strong><span>{agent.kind === 'main' ? l('主 Agent') : 'Sub-Agent'} · {l('最大轮数')} {agent.maxTurns} · {l('模型')} {agent.model}</span></div><p>{l('工具：')}{formatList(agent.tools) || l('无')} · MCP: {formatList(agent.mcpServers) || l('无')} · Skills: {formatList(agent.skills) || l('无')}</p><p>{l('授权：工具 ')}{agent.permissions.toolApproval === 'allow_all' ? l('默认允许') : l('按现有规则审批')} · {l('路径 ')}{formatPath(agent.permissions.pathAccess)} · {l('记忆 ')}{agent.memoryEnabled ? l('启用') : l('停用')}</p><small>{l('配置：')}{agent.metadataPath}<br />{l('人格：')}{agent.personaPath}<br />{l('规则：')}{agent.instructionsPath}<br />{l('记忆：')}{agent.memoryPath}</small></article>)}</div><div className="catalog-extra"><h3>{l("全局工具授权")}</h3><p>{formatList(configCatalog?.globalPermissions.alwaysAllowTools ?? []) || l('无')}</p><small>{configCatalog?.globalPermissions.path}</small><h3>{l("AIGC 生成设置")}</h3><p>{configCatalog?.aigcSettings.imageModel} · {configCatalog?.aigcSettings.imageSize}{language === 'en' ? '; ' : '；'}{configCatalog?.aigcSettings.videoModel} · {configCatalog?.aigcSettings.videoDuration} {language === 'en' ? 'sec' : '秒'} · {configCatalog?.aigcSettings.videoResolution}</p><small>{configCatalog?.aigcSettings.path} · {l('凭据：')}{configCatalog?.aigcSettings.credentialStatus === 'available' ? l('可用') : l('不可用')}</small><h3>Skills</h3>{configCatalog?.skills.length ? configCatalog.skills.map((skill) => <p key={skill.name}>{skill.name} · {skill.path}</p>) : <p>{l("无")}</p>}<h3>{l("MCP 服务")}</h3>{configCatalog?.mcpServers?.map((server) => <p key={server.id}>{server.name} · {server.source === "builtin" ? l("内置") : l("自定义")} · {server.transport.toUpperCase()} · {server.check.tools.length} {l("个工具")}</p>)}</div></section>}

      {section === 'run' && <div className="run-layout">
        {(conversation?.config.agent.kind === 'main' || (!conversation && draft?.kind === 'main')) && <AgentFlow root={conversation?.config.agent ?? draft!} children={conversation?.config.children ?? draft!.subAgentIds.map((id) => bootstrap?.agents.find((agent) => agent.id === id)).filter((agent): agent is AgentConfig => Boolean(agent))} conversation={conversation} mode="run" language={language} />}
        <section className="panel run-compose"><div className="panel-title"><span className="step">▶</span><div><h2>{l("多轮对话")}</h2><p>{l('工作目录：')}{bootstrap?.workspacePath}</p></div></div>
          <div className="conversation-picker"><label>{l("会话")}<select value={conversation?.id ?? ''} onChange={(event) => { if (event.target.value) void selectConversation(event.target.value); }}><option value="">{l("新对话")}</option>{conversationList.map((item) => <option key={item.id} value={item.id}>{item.firstMessage || item.id.slice(0, 8)} · {item.id.slice(0, 8)}</option>)}</select></label><button className="button ghost" onClick={() => { eventsRef.current?.close(); setConversation(null); setTask(''); setDismissedInteractionId(''); if (draft) localStorage.removeItem(`qoder-conversation:${draft.id}`); }}>{l("新对话")}</button></div>
          <div className="conversation-messages">{conversation?.messages.length ? conversation.messages.map((message) => <div className={`chat-message chat-${message.role}`} key={message.id}><strong>{message.role === 'user' ? l('你') : conversation.agentName}</strong><div>{message.content || l('正在生成…')}</div></div>) : <p className="empty-text">{l("输入任务，开始与当前 Agent 对话。")}</p>}</div>
          {conversation?.status === 'waiting' && <button className="button pending-banner" onClick={() => setDismissedInteractionId('')}>{l("等待你的决策 · 点击查看")}</button>}
          {conversation?.demoArchive && <p className="permission-hint">{language === 'en' ? 'Imported showcase history is read-only. Sending below starts a new conversation with your account; previous messages are not carried over.' : '这是只读演示存档。下方发送后会用你的账号开始新对话，旧消息不会自动成为新对话的上下文。'}</p>}
          {conversation?.status === 'interrupted' && <p className="field-error">{l("服务重启中断了上一轮。输入追问即可恢复同一会话。")}</p>}
          <textarea value={task} onChange={(event) => setTask(event.target.value)} rows={4} placeholder={conversation ? l('继续提问，例如：选择第 1 项，然后分析页面配色。') : l('描述要让 Agent 执行的任务')} disabled={conversation?.status === 'running' || conversation?.status === 'waiting'} />
          <div className="editor-actions"><span>{l("审批与 Agent 提问会在弹窗中显示。")}</span><div className="composer-buttons">{(conversation?.status === 'running' || conversation?.status === 'waiting') && <button className="button ghost" onClick={() => void stop()}>{l("中断当前轮")}</button>}<button className="button primary" onClick={() => void (conversation ? followUp() : start())} disabled={busy || !draft || !task.trim() || conversation?.status === 'running' || conversation?.status === 'waiting'}>{conversation?.demoArchive ? (language === 'en' ? 'Start a new conversation' : '用此提问开启新对话') : conversation ? l('发送追问') : l('开始运行')}</button></div></div>
        </section>
        <section className="panel run-output"><div className="output-head"><div><h2>{l("会话状态")}</h2><p>{conversation ? `${displayStatus(language, conversation.status)} · ${conversation.id.slice(0, 8)}` : l('等待启动任务')}</p></div></div><div className="conversation-summary">{conversation ? <><p>{language === 'en' ? `${conversation.turns.filter((turn) => turn.status === 'done').length} completed turns · Current turn: ` : `已完成 ${conversation.turns.filter((turn) => turn.status === 'done').length} 轮 · 当前轮：`}{displayStatus(language, conversation.turns.at(-1)?.status ?? 'idle')}</p><p>{language === 'en' ? 'Conversation settings snapshot: ' : '本会话配置快照：'}{conversation.config.agent.model} · {l('最大轮数')} {conversation.config.agent.maxTurns}</p>{selected && selected.maxTurns !== conversation.config.agent.maxTurns && <p className="field-error">{language === 'en' ? `Saved configuration: ${selected.maxTurns} turns. This conversation keeps its original ${conversation.config.agent.maxTurns} turns. Start a new conversation to apply the change.` : `当前已保存配置是 ${selected.maxTurns} 轮；本会话继续使用创建时的 ${conversation.config.agent.maxTurns} 轮。开启新对话后生效。`}</p>}<p>{l("刷新页面后可继续；服务重启后从 SDK 会话恢复。")}</p>{(conversation.sessionAllowedTools?.length || conversation.sessionAllowedCategories?.length) ? <p className="session-grants">{language === 'en' ? 'Automatically allowed in this conversation: ' : '本会话自动允许：'}{[...(conversation.sessionAllowedTools ?? []), ...(conversation.sessionAllowedCategories ?? []).map((category) => language === 'en' ? `${category} category` : `${category} 类`) ].join(language === 'en' ? ', ' : '、')}</p> : null}</> : <p className="empty-text">{language === 'en' ? 'New conversations use saved settings: ' : '新对话将使用已保存配置：'}{selected?.model ?? '—'} · {l('最大轮数')} {selected?.maxTurns ?? '—'}{draftDirty && (language === 'en' ? '. There are unsaved changes.' : '。当前还有未保存修改。')}</p>}</div></section>
        {!!conversation?.artifacts?.length && <section className="panel media-panel"><h2>{l("生成产物")}</h2><div className="media-grid">{conversation.artifacts.map((item) => <article className="media-card" key={item.id}><strong>{item.kind === 'image' ? l('图片') : l('视频')} · {displayStatus(language, item.status)}</strong><small>{item.model} · {item.id.slice(0, 8)}{item.taskId ? ` · ${l('任务 ')}${item.taskId}` : ''}</small>{item.status === 'succeeded' && item.url && (item.kind === 'image' ? <img src={item.url} alt={item.prompt} /> : <video controls preload="metadata" src={item.url} />)}{item.status === 'running' && <p>{l("正在生成；视频任务会持续查询百炼状态。")}</p>}{item.error && <p className="field-error">{item.error}</p>}{item.url && <a href={item.url} download>{l("下载本地产物")}</a>}<p>{item.prompt}</p></article>)}</div></section>}
        <section className="panel activity"><h2>{l("执行事件")}</h2><p>{l("每一轮的工具、决策、记忆与 Credits")}</p><div className="event-list">{activity.length ? activity.map((event) => <div className={`event event-${event.type}`} key={event.id}><div className="event-time">{new Date(event.at).toLocaleTimeString(language === 'en' ? 'en-US' : 'zh-CN')}</div><div className="event-body"><strong>{eventLabel(language, event.label ?? event.type)}</strong>{event.detail && <pre>{event.detail}</pre>}{event.credits !== undefined && <span>{event.credits} Credits</span>}</div></div>) : <div className="empty-text">{l("尚无事件。")}</div>}</div></section>
      </div>}
      {modalInteraction && <div className="dialog-backdrop" role="presentation"><div className="decision-dialog" role="dialog" aria-modal="true" aria-labelledby="decision-title"><div className="dialog-heading"><span className="step">?</span><div><h2 id="decision-title">{modalInteraction.kind === 'question' ? l('Agent 需要你的选择') : l('操作需要授权')}</h2><p>{eventLabel(language, modalInteraction.title)}</p></div></div>{modalInteraction.kind === 'approval' ? <><p className="dialog-tool">{modalInteraction.toolName}</p>{modalInteraction.origin && <p className="dialog-origin">{l('目标来源：')}{modalInteraction.origin}</p>}<pre className="dialog-detail">{modalInteraction.detail}</pre><p className="dialog-note">{l("选择自动允许后，后续匹配的调用会直接执行，包括不同参数、网址和文件路径。")}</p><div className="approval-options"><button className="approval-option" onClick={() => void decideInteraction(modalInteraction, 'allow')} disabled={busy}><strong>{l("允许一次")}</strong><small>{l("仅批准当前调用；导航仍按当前来源记住授权。")}</small></button><button className="approval-option" onClick={() => void decideInteraction(modalInteraction, 'allow_session_tool')} disabled={busy}><strong>{l("本会话允许此工具")}</strong><small>{language === 'en' ? `Later calls to ${modalInteraction.toolName} run directly in this conversation.` : `此会话后续调用 ${modalInteraction.toolName} 直接执行。`}</small></button>{modalInteraction.category && <button className="approval-option" onClick={() => void decideInteraction(modalInteraction, 'allow_session_category')} disabled={busy}><strong>{l("本会话允许同类操作")}</strong><small>{l(modalInteraction.categoryLabel ?? '')}{l('，跨 Playwright 与 Chrome DevTools。')}</small></button>}{(CONFIGURABLE_PERMISSION_TOOLS as readonly string[]).includes(modalInteraction.toolName) && <button className="approval-option global" onClick={() => void decideInteraction(modalInteraction, 'allow_global_tool')} disabled={busy}><strong>{l("全局始终允许此工具")}</strong><small>{l("所有 Agent 和以后会话生效，可在“工具授权”取消。")}</small></button>}</div><div className="dialog-actions"><button className="button ghost" onClick={() => setDismissedInteractionId(modalInteraction.id)}>{l("稍后处理")}</button><button className="button danger" onClick={() => void decideInteraction(modalInteraction, 'deny')} disabled={busy}>{l("拒绝")}</button></div></> : <><div className="question-list">{modalInteraction.questions?.map((question) => <fieldset key={question.question}><legend>{question.header} · {question.question}</legend>{question.options.map((option) => { const selected = (questionSelections[question.question] ?? []).includes(option.label); return <label key={option.label} className="question-option"><input type={question.multiSelect ? 'checkbox' : 'radio'} name={question.question} checked={selected} onChange={() => setQuestionSelections((current) => { const existing = current[question.question] ?? []; return { ...current, [question.question]: question.multiSelect ? (selected ? existing.filter((label) => label !== option.label) : [...existing, option.label]) : [option.label] }; })} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>; })}<input className="custom-answer" value={customAnswers[question.question] ?? ''} onChange={(event) => setCustomAnswers((current) => ({ ...current, [question.question]: event.target.value }))} placeholder={l('其他回答（填写后优先采用）')} /></fieldset>)}</div><div className="dialog-actions"><button className="button ghost" onClick={() => setDismissedInteractionId(modalInteraction.id)}>{l("稍后处理")}</button><button className="button danger" onClick={() => void decideInteraction(modalInteraction, 'deny')} disabled={busy}>{l("取消提问")}</button><button className="button primary" onClick={() => void decideInteraction(modalInteraction, 'answer')} disabled={busy}>{l("提交选择并继续")}</button></div></>}</div></div>}
      <footer>{l("Qoder Agent SDK 原型 · 单人本地使用 · 示例仓库与配置保存在 data/")}</footer>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
