import { useEffect, useState } from 'react';
import type { McpAuth, McpCheck, McpServerInput, McpServerRecord, McpTransport } from '../shared/types';
import { t, type Language } from './i18n';
import './mcp.css';

type Props = { language: Language; servers: McpServerRecord[]; onReload: () => Promise<void>; onAssign: (id: string) => void; currentAgent?: string };
type Draft = McpServerInput & { isNew: boolean; envText: string; headerText: string };
const blank = (): Draft => ({ id: '', name: '', transport: 'http', auth: 'none', url: '', command: '', args: [], timeoutMs: 30000,
  envNames: [], headerNames: [], bearerToken: '', isNew: true, envText: '', headerText: '' });
function fromRecord(item: McpServerRecord): Draft {
  return { id: item.id, name: item.name, transport: item.transport === 'sdk' ? 'http' : item.transport,
    auth: item.auth, url: item.url ?? '', command: item.command ?? '', args: item.args ?? [], timeoutMs: item.timeoutMs ?? 30000,
    envNames: item.envNames, headerNames: item.headerNames, bearerToken: '', isNew: false,
    envText: item.envNames.map((name) => `${name}=`).join('\n'), headerText: item.headerNames.map((name) => `${name}=`).join('\n') };
}
function parsePairs(text: string): { names: string[]; values: Record<string, string> } {
  const pairs = text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    if (at < 1) throw new Error('每行需填写 NAME=value；已有凭据可留空以保留原值');
    return [line.slice(0, at).trim(), line.slice(at + 1)] as const;
  });
  if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new Error('变量或请求头名称不可重复');
  return { names: pairs.map(([name]) => name), values: Object.fromEntries(pairs.filter(([, value]) => value).map(([name, value]) => [name, value])) };
}
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json' } });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as T;
}
const statusText: Record<string, string> = { untested: '未校验', connected: '已连接', failed: '失败', 'needs-auth': '需要授权', pending: '连接中', disabled: '已停用' };
export function McpManager({ language, servers, onReload, onAssign, currentAgent }: Props) {
  const l = (value: string) => t(language, value);
  const [selectedId, select] = useState(servers[0]?.id ?? '');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState('');
  const [flow, setFlow] = useState<{ flowId: string; authUrl: string } | null>(null);
  const [callbackUrl, setCallbackUrl] = useState('');
  const selected = servers.find((item) => item.id === selectedId);
  useEffect(() => { if (!draft?.isNew && selected) setDraft(fromRecord(selected)); }, [selectedId]);
  useEffect(() => { if (!selectedId && servers[0]) select(servers[0].id); }, [servers, selectedId]);
  useEffect(() => {
    if (!flow || !selectedId) return;
    const timer = window.setInterval(() => {
      void request<McpServerRecord[]>('/mcp-servers').then(async (items) => {
        const item = items.find((entry) => entry.id === selectedId);
        if (item?.check.status === 'connected' && item.check.checkedAt) { setFlow(null); await onReload(); setNotice(l('OAuth 授权已完成')); }
      }).catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [flow?.flowId, selectedId]);
  async function perform(task: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await task(); } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!draft) return;
    await perform(async () => {
      const env = parsePairs(draft.envText), headers = parsePairs(draft.headerText);
      const payload: McpServerInput = { id: draft.id.trim().toLowerCase(), name: draft.name.trim(), transport: draft.transport,
        auth: draft.transport === 'stdio' ? 'none' : draft.auth, url: draft.url || undefined, command: draft.command || undefined,
        args: draft.args, timeoutMs: draft.timeoutMs, envNames: env.names, envValues: env.values,
        headerNames: headers.names, headerValues: headers.values, bearerToken: draft.bearerToken || undefined };
      await request(`/mcp-servers${draft.isNew ? '' : `/${selectedId}`}`, { method: draft.isNew ? 'POST' : 'PUT', body: JSON.stringify(payload) });
      await onReload(); select(payload.id); setDirty(false); setDraft({ ...draft, id: payload.id, isNew: false, bearerToken: '', envText: env.names.map((name) => `${name}=`).join('\n'), headerText: headers.names.map((name) => `${name}=`).join('\n') });
      setNotice(l('MCP 配置已保存。请校验连接并查看发现的工具。'));
    });
  }
  async function check() {
    if (!selected) return;
    await perform(async () => { const result = await request<McpCheck>(`/mcp-servers/${selected.id}/check`, { method: 'POST' }); await onReload();
      setNotice(result.status === 'connected' ? `${l('连接成功，发现')} ${result.tools.length} ${l('个工具')}` : result.error || l(statusText[result.status])); });
  }
  async function remove() {
    if (!selected || selected.source !== 'custom' || !window.confirm(l('确认删除这个 MCP 服务？'))) return;
    await perform(async () => { await request(`/mcp-servers/${selected.id}`, { method: 'DELETE' }); await onReload(); select(''); setDraft(null); setNotice(l('MCP 已删除')); });
  }
  async function authorize() {
    if (!selected) return;
    await perform(async () => {
      const result = await request<{ flowId?: string; authUrl?: string; check?: McpCheck }>(`/mcp-servers/${selected.id}/oauth/start`, { method: 'POST' });
      if (result.authUrl && result.flowId) { setFlow({ authUrl: result.authUrl, flowId: result.flowId }); window.open(result.authUrl, '_blank', 'noopener,noreferrer'); setNotice(l('请在新窗口完成授权；若未自动返回，请粘贴最终回调 URL。')); }
      else { await onReload(); setNotice(l('OAuth 授权已完成')); }
    });
  }
  async function completeOAuth() {
    if (!flow) return;
    await perform(async () => { await request(`/mcp/oauth/${flow.flowId}/complete`, { method: 'POST', body: JSON.stringify({ callbackUrl }) }); setFlow(null); setCallbackUrl(''); await onReload(); setNotice(l('OAuth 授权已完成')); });
  }
  const input = (patch: Partial<Draft>) => { setDirty(true); setDraft((item) => item ? { ...item, ...patch } : item); };
  return <div className="mcp-manager">
    <section className="panel mcp-browser"><div className="panel-title"><span className="step">MC</span><div><h2>{l('MCP 服务')}</h2><p>{l('统一管理内置服务和自定义连接。')}</p></div></div>
      <div className="mcp-list">{servers.map((item) => <button key={item.id} className={`mcp-item ${selectedId === item.id && !draft?.isNew ? 'active' : ''}`} onClick={() => { select(item.id); setDraft(item.source === 'custom' ? fromRecord(item) : null); setDirty(false); setNotice(''); }}>
        <span className={`mcp-status ${item.check.status}`} /><span><strong>{item.name}</strong><small>{item.source === 'builtin' ? l('内置') : l('自定义')} · {item.transport.toUpperCase()} · {l(statusText[item.check.status])}</small></span><em>{item.check.tools.length}</em>
      </button>)}</div>
      <button className="button ghost skill-create" onClick={() => { setDraft(blank()); select(''); setDirty(false); setNotice(''); }}>＋ {l('新增 MCP')}</button>
      {!servers.some((item) => item.id === 'apify') && <button className="inline-link" onClick={() => { setDraft({ ...blank(), id: 'apify', name: 'Apify', transport: 'http', auth: 'bearer', url: 'https://mcp.apify.com?tools=actors,apify/web-fetch' }); select(''); setDirty(false); setNotice(''); }}>{l('添加 Apify MCP')} ↗</button>}
    </section>
    <section className="panel mcp-detail"><div className="panel-title"><span className="step">API</span><div><h2>{draft?.isNew ? l('新增 MCP 服务') : selected?.name ?? l('选择 MCP 服务')}</h2><p>{selected?.source === 'builtin' ? l('内置定义只读，可校验连接和查看能力。') : l('保存配置后校验连接；仅通过校验且发现工具的服务可以装配。')}</p></div></div>
      {selected && !draft?.isNew && <div className="mcp-summary"><span className={`mcp-pill ${selected.check.status}`}>{l(statusText[selected.check.status])}</span><span>{selected.source === 'builtin' ? l('内置') : l('自定义')} / {selected.transport.toUpperCase()}</span><span>{selected.check.checkedAt ? new Date(selected.check.checkedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN') : l('尚未校验')}</span></div>}
      {selected && !draft?.isNew && <div className="mcp-actions"><button className="button ghost" disabled={busy || dirty} title={dirty ? l('请先保存配置') : undefined} onClick={() => void check()}>{busy ? l('校验中…') : l('校验连接')}</button>{selected.auth === 'oauth' && <button className="button ghost" disabled={busy || dirty} onClick={() => void authorize()}>{l('OAuth 授权')}</button>}{selected.source === 'custom' && <button className="button danger" disabled={busy || selected.usedBy.length > 0} onClick={() => void remove()}>{l('删除')}</button>}{selected.check.status === 'connected' && selected.check.tools.length > 0 && <button className="button primary" disabled={!currentAgent} onClick={() => onAssign(selected.id)}>{l('装配到当前 Agent')}</button>}</div>}
      {flow && <div className="mcp-oauth"><a href={flow.authUrl} target="_blank" rel="noreferrer">{l('打开授权页面')}</a><label>{l('回调 URL（自动返回失败时填写）')}<input value={callbackUrl} onChange={(event) => setCallbackUrl(event.target.value)} /></label><button className="button ghost" disabled={!callbackUrl || busy} onClick={() => void completeOAuth()}>{l('完成授权')}</button></div>}
      {(draft?.isNew || selected?.source === 'custom') && draft && <div className="mcp-form"><div className="two-fields"><label>ID<input value={draft.id} disabled={!draft.isNew} placeholder="apify" onChange={(event) => input({ id: event.target.value.toLowerCase() })} /></label><label>{l('显示名称')}<input value={draft.name} placeholder="Apify" onChange={(event) => input({ name: event.target.value })} /></label></div>
        <div className="two-fields"><label>{l('接入方式')}<select value={draft.transport} onChange={(event) => input({ transport: event.target.value as McpTransport as Draft['transport'], auth: event.target.value === 'stdio' ? 'none' : draft.auth })}><option value="stdio">stdio</option><option value="http">Streamable HTTP</option><option value="sse">SSE</option></select></label><label>{l('超时（毫秒）')}<input type="number" min="1000" max="300000" value={draft.timeoutMs ?? 30000} onChange={(event) => input({ timeoutMs: Number(event.target.value) })} /></label></div>
        {draft.transport === 'stdio' ? <><label>{l('启动命令')}<input value={draft.command ?? ''} placeholder="npx" onChange={(event) => input({ command: event.target.value })} /></label><label>{l('参数（每行一个）')}<textarea value={(draft.args ?? []).join('\n')} onChange={(event) => input({ args: event.target.value.split('\n').map((value) => value.trim()).filter(Boolean) })} /></label><label>{l('环境变量（每行 NAME=value；留空保留原值）')}<textarea value={draft.envText} onChange={(event) => input({ envText: event.target.value })} /></label></> : <><label>{l('服务 URL')}<input value={draft.url ?? ''} placeholder="https://mcp.apify.com?tools=actors,apify/web-fetch" onChange={(event) => input({ url: event.target.value })} /></label><label>{l('认证方式')}<select value={draft.auth} onChange={(event) => input({ auth: event.target.value as McpAuth })}><option value="none">{l('无认证')}</option><option value="bearer">Bearer Token</option><option value="headers">{l('自定义请求头')}</option><option value="oauth">OAuth</option></select></label>{draft.auth === 'bearer' && <label>Bearer Token{selected?.hasBearerToken && <span className="mcp-credential-state">{l('凭据已配置')}</span>}<input type="password" autoComplete="off" value={draft.bearerToken ?? ''} placeholder={selected?.hasBearerToken ? l('已配置；留空保留') : ''} onChange={(event) => input({ bearerToken: event.target.value })} /></label>}{draft.auth === 'headers' && <label>{l('请求头（每行 NAME=value；留空保留原值）')}<textarea value={draft.headerText} onChange={(event) => input({ headerText: event.target.value })} /></label>}</>}
        <p className="mcp-secret-note">{l('凭据单独存储在本机 0600 文件中；页面不回显明文。')}</p><button className="button primary" disabled={busy} onClick={() => void save()}>{l('保存 MCP 配置')}</button>
      </div>}
      {selected && !draft?.isNew && <><div className="section-divider" /><h3>{l('工具清单')} <small>{selected.check.tools.length}</small></h3>{selected.source === 'builtin' && selected.check.status === 'untested' && <p className="mcp-secret-note">{l('当前为预置工具名；校验后显示 SDK 实际发现结果。')}</p>}{selected.check.error && <p className="mcp-error">{selected.check.error}</p>}{selected.check.tools.length ? <div className="mcp-tools">{selected.check.tools.map((tool) => <article key={tool.name}><strong>{tool.name}</strong><p>{tool.description || l('SDK 未返回说明')}</p>{tool.annotations && <small>{Object.entries(tool.annotations).filter(([, yes]) => yes).map(([key]) => key).join(' · ')}</small>}</article>)}</div> : <p className="empty-text">{l('尚未发现工具，请先校验连接。')}</p>}<h3>{l('已装配的 Agent')}</h3>{selected.usedBy.length ? <div className="mcp-used">{selected.usedBy.map((agent) => <span key={agent.id}>{agent.name} · {agent.kind === 'main' ? l('主 Agent') : 'Sub-Agent'}</span>)}</div> : <p className="empty-text">{l('尚未装配')}</p>}</>}
      {notice && <p className="save-feedback" role="status">{notice}</p>}
    </section>
  </div>;
}
