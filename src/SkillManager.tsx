import { useEffect, useState } from 'react';
import type { AgentConfig, SkillDraftRecord, SkillRecord, SkillTreeEntry } from '../shared/types';
import { t, type Language } from './i18n';
import './skill.css';

type Props = { language: Language; skills: SkillRecord[]; discovered: string[]; agents: AgentConfig[]; currentAgent?: AgentConfig; onReload: () => Promise<void>; onAssign: (name: string) => void };
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api${url}`, options);
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data as T;
}
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
export function SkillManager({ language, skills, discovered, agents, currentAgent, onReload, onAssign }: Props) {
  const l = (zh: string, en: string) => language === 'en' ? en : zh;
  const [selectedSlug, setSelectedSlug] = useState(skills[0]?.slug ?? '');
  const [draft, setDraft] = useState<SkillDraftRecord | null>(null);
  const [drafts, setDrafts] = useState<SkillDraftRecord[]>([]);
  const [publishedFiles, setPublishedFiles] = useState<SkillTreeEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState('SKILL.md');
  const [fileText, setFileText] = useState('');
  const [fileDirty, setFileDirty] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ slug: '', description: '', body: '# 使用方式\n\n描述使用步骤。' });
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const selected = skills.find((skill) => skill.slug === selectedSlug);
  const files = draft?.files ?? publishedFiles;
  const file = files.find((entry) => entry.path === selectedFile);
  const usedBy = (name: string) => agents.filter((agent) => agent.skills.includes(name)).map((agent) => `${agent.name}${agent.kind === 'subagent' ? ' ↳' : ''}`);
  async function reloadDrafts() { setDrafts(await request<SkillDraftRecord[]>('/skill-drafts')); }
  useEffect(() => { void reloadDrafts().catch((error) => setNotice((error as Error).message)); }, []);
  useEffect(() => { if (!draft && !createOpen && !selectedSlug && skills[0]) setSelectedSlug(skills[0].slug); }, [skills, selectedSlug, draft?.id, createOpen]);
  useEffect(() => {
    if (draft || !selectedSlug) return;
    void request<SkillTreeEntry[]>(`/skills/${selectedSlug}/tree`).then(setPublishedFiles).catch((error) => setNotice((error as Error).message));
  }, [selectedSlug, draft?.id]);
  useEffect(() => {
    if (!selectedFile || !file?.text || file.size > 1024 * 1024) { setFileText(''); setFileDirty(false); return; }
    const url = draft ? `/skill-drafts/${draft.id}/files?path=${encodeURIComponent(selectedFile)}&view=text` : `/skills/${selectedSlug}/files?path=${encodeURIComponent(selectedFile)}`;
    void (draft ? request<{ content: string }>(url).then((value) => value.content) : fetch(`/api${url}`).then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); }))
      .then((value) => { setFileText(value); setFileDirty(false); }).catch((error) => setNotice((error as Error).message));
  }, [draft?.id, selectedSlug, selectedFile, file?.size, file?.text]);
  async function perform(task: () => Promise<void>) {
    setBusy(true); setNotice('');
    try { await task(); } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }
  function selectFile(value: string) {
    if (fileDirty && !window.confirm(l('当前文件有未保存修改，确定切换？', 'Discard unsaved file changes?'))) return;
    setSelectedFile(value);
  }
  async function edit() {
    if (!selected) return;
    await perform(async () => { const item = await request<SkillDraftRecord>('/skill-drafts', json({ mode: 'edit', slug: selected.slug })); setDraft(item); setSelectedFile('SKILL.md'); await reloadDrafts(); setNotice(l('已创建编辑草稿。修改只在发布后生效。', 'Editing draft created. Changes take effect after publishing.')); });
  }
  async function create() {
    await perform(async () => { const item = await request<SkillDraftRecord>('/skill-drafts', json({ mode: 'new', ...form })); setDraft(item); setSelectedSlug(''); setSelectedFile('SKILL.md'); setCreateOpen(false); await reloadDrafts(); setNotice(l('草稿已创建，请校验后发布。', 'Draft created. Validate it before publishing.')); });
  }
  async function upload(blob: File, format: 'markdown' | 'zip') {
    await perform(async () => {
      const item = await request<SkillDraftRecord>(`/skill-drafts/import?format=${format}`, { method: 'POST', headers: { 'Content-Type': format === 'zip' ? 'application/zip' : 'text/markdown' }, body: blob });
      setDraft(item); setSelectedSlug(''); setSelectedFile('SKILL.md'); await reloadDrafts(); setNotice(l('导入到草稿；请查看文件并校验。', 'Imported into a draft. Review files and validate.'));
    });
  }
  async function saveFile() {
    if (!draft || !file || !file.text) return;
    await perform(async () => {
      const result = await request<SkillDraftRecord>(`/skill-drafts/${draft.id}/files?path=${encodeURIComponent(selectedFile)}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': String(draft.version) }, body: fileText });
      setDraft(result); setFileDirty(false); await reloadDrafts(); setNotice(l('文件已保存到草稿，需重新校验。', 'File saved in draft; validation is required.'));
    });
  }
  async function replaceFile(blob: File) {
    if (!draft || !file) return;
    await perform(async () => { const result = await request<SkillDraftRecord>(`/skill-drafts/${draft.id}/files?path=${encodeURIComponent(selectedFile)}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'If-Match': String(draft.version) }, body: blob }); setDraft(result); await reloadDrafts(); setNotice(l('文件已替换，请重新校验。', 'File replaced. Validate again.')); });
  }
  async function entryAction(action: 'mkdir' | 'create' | 'rename' | 'delete', target?: string) {
    if (!draft) return;
    const input = target ?? window.prompt(action === 'mkdir' ? l('新目录路径', 'New directory path') : l('新文件路径', 'New file path'));
    if (!input) return;
    const newPath = action === 'rename' ? window.prompt(l('新路径', 'New path'), input) : undefined;
    if (action === 'rename' && !newPath) return;
    if (action === 'delete' && !window.confirm(l(`删除 ${input}？`, `Delete ${input}?`))) return;
    await perform(async () => { const result = await request<SkillDraftRecord>(`/skill-drafts/${draft.id}/entries`, { ...json({ action, path: input, newPath }), headers: { 'Content-Type': 'application/json', 'If-Match': String(draft.version) } }); setDraft(result); if (selectedFile === input || selectedFile.startsWith(`${input}/`)) setSelectedFile('SKILL.md'); await reloadDrafts(); setNotice(l('草稿目录已更新。', 'Draft tree updated.')); });
  }
  async function validate() {
    if (!draft) return;
    await perform(async () => { const result = await request<SkillDraftRecord>(`/skill-drafts/${draft.id}/validate`, { method: 'POST', headers: { 'If-Match': String(draft.version) } }); setDraft(result); await reloadDrafts(); setNotice(result.validation?.valid ? l('格式合规，SDK 已发现；可以发布。', 'Format valid and discovered by SDK. Ready to publish.') : l('校验未通过，请查看错误清单。', 'Validation failed. Review the issues.')); });
  }
  async function publish() {
    if (!draft || fileDirty) return;
    await perform(async () => { const result = await request<{ skill: SkillRecord }>(`/skill-drafts/${draft.id}/publish`, { method: 'POST', headers: { 'If-Match': String(draft.version) } }); setDraft(null); setSelectedSlug(result.skill.slug); setSelectedFile('SKILL.md'); await Promise.all([onReload(), reloadDrafts()]); setNotice(l(`${result.skill.name} 已发布，后续新会话会加载新版。`, `${result.skill.name} published. New conversations will load this version.`)); });
  }
  async function discard() {
    if (!draft || !window.confirm(l('删除这个草稿？', 'Delete this draft?'))) return;
    await perform(async () => { await request<void>(`/skill-drafts/${draft.id}`, { method: 'DELETE' }); setDraft(null); setSelectedSlug(skills[0]?.slug ?? ''); await reloadDrafts(); });
  }
  async function removeSkill() {
    if (!selected || usedBy(selected.name).length || !window.confirm(l(`删除整个 ${selected.name} 目录？`, `Delete the entire ${selected.name} directory?`))) return;
    await perform(async () => { await request<void>(`/skills/${selected.slug}`, { method: 'DELETE' }); setSelectedSlug(''); setPublishedFiles([]); await onReload(); setNotice(l('Skill 已删除。', 'Skill deleted.')); });
  }
  const fileUrl = draft ? `/api/skill-drafts/${draft.id}/files?path=${encodeURIComponent(selectedFile)}` : `/api/skills/${selectedSlug}/files?path=${encodeURIComponent(selectedFile)}`;
  return <div className="skill-workspace">
    <section className="panel skill-library"><div className="panel-title"><span className="step">SK</span><div><h2>Skills</h2><p>{l('统一管理 workbench 插件中的 Skill', 'Manage Skills in the workbench plugin')}</p></div></div>
      <div className="skill-list">{skills.map((item) => <button key={item.slug} className={`skill-list-item ${selectedSlug === item.slug && !draft ? 'active' : ''}`} onClick={() => { if (fileDirty && !window.confirm(l('放弃未保存的文件修改？', 'Discard unsaved file edits?'))) return; setDraft(null); setSelectedSlug(item.slug); setSelectedFile('SKILL.md'); setNotice(''); }}><strong>{item.name}</strong><small>{item.description || item.error}</small><span>{item.fileCount ?? 0} {l('个文件', 'files')} · {item.validation === 'invalid' ? l('格式无效', 'Invalid format') : discovered.includes(item.name) ? l('SDK 已发现', 'SDK discovered') : l('未发现', 'Undiscovered')}</span><em>{usedBy(item.name).join(' · ') || l('尚未装配', 'Unassigned')}</em></button>)}</div>
      <div className="skill-import-actions"><button className="button ghost" onClick={() => { setCreateOpen(true); setDraft(null); setSelectedSlug(''); }}>＋ {l('表单创建', 'Create')}</button><label className="button ghost">{l('上传 SKILL.md', 'Upload SKILL.md')}<input type="file" accept=".md,text/markdown" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file, 'markdown'); event.target.value = ''; }} /></label><label className="button ghost">{l('上传 ZIP', 'Upload ZIP')}<input type="file" accept=".zip,application/zip" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file, 'zip'); event.target.value = ''; }} /></label></div>
      {drafts.length > 0 && <div className="skill-draft-list"><h3>{l('未发布草稿', 'Unpublished drafts')}</h3>{drafts.map((item) => <button key={item.id} className={draft?.id === item.id ? 'active' : ''} onClick={() => { if (fileDirty && !window.confirm(l('放弃未保存的文件修改？', 'Discard unsaved file edits?'))) return; setDraft(item); setSelectedSlug(item.sourceSlug ?? ''); setSelectedFile('SKILL.md'); setCreateOpen(false); }}>{item.slug || item.sourceSlug || item.origin} <small>{item.validation?.valid ? '✓' : item.validation ? '!' : '…'} · {new Date(item.updatedAt).toLocaleString()}</small></button>)}</div>}
    </section>
    <section className="panel skill-detail"><div className="panel-title"><span className="step">FS</span><div><h2>{draft ? l('Skill 草稿', 'Skill draft') : selected?.name ?? l('选择一个 Skill', 'Select a Skill')}</h2><p>{draft ? `${l('草稿目录', 'Draft folder')}: data/skill-drafts/${draft.id}/files` : selected?.path ?? l('可创建或导入 Skill', 'Create or import a Skill')}</p></div></div>
      {notice && <p className="skill-notice" role="status">{notice}</p>}
      {createOpen && <div className="skill-create-form"><h3>{l('表单创建 Skill', 'Create Skill from form')}</h3><label>{l('名称', 'Name')}<input value={form.slug} onChange={(event) => setForm({ ...form, slug: event.target.value.toLowerCase() })} placeholder="web-audit" /></label><label>{l('描述', 'Description')}<input value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label><label>{l('指令正文', 'Instruction body')}<textarea value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} rows={7} /></label><div className="skill-toolbar"><button className="button ghost" onClick={() => setCreateOpen(false)}>{l('取消', 'Cancel')}</button><button className="button primary" disabled={busy} onClick={() => void create()}>{l('创建草稿', 'Create draft')}</button></div></div>}
      {(draft || selected) && !createOpen && <><div className="skill-meta"><span>{l('调用名', 'Call name')}: {draft?.slug ? `workbench:${draft.slug}` : draft ? l('待校验', 'Pending validation') : selected?.name}</span><span>{l('装配到', 'Assigned to')}: {usedBy(draft ? (draft.sourceSlug ? `workbench:${draft.sourceSlug}` : '') : selected?.name ?? '').join(' · ') || l('暂无', 'None')}</span></div>
        <div className="skill-toolbar">{!draft && <><button className="button ghost" disabled={busy} onClick={() => void edit()}>{l('编辑草稿', 'Edit draft')}</button><button className="button ghost" disabled={!selected || !discovered.includes(selected.name)} onClick={() => selected && onAssign(selected.name)}>{l('装配到当前 Agent', 'Assign to current Agent')}{currentAgent ? ` · ${currentAgent.name}` : ''}</button><button className="button danger" disabled={busy || !selected || usedBy(selected.name).length > 0 || selected.slug === 'repo-review'} onClick={() => void removeSkill()}>{l('删除 Skill', 'Delete Skill')}</button></>}
          {draft && <><button className="button ghost" disabled={busy} onClick={() => void entryAction('mkdir')}>＋ {l('目录', 'Folder')}</button><button className="button ghost" disabled={busy} onClick={() => void entryAction('create')}>＋ {l('文件', 'File')}</button><button className="button ghost" disabled={busy || fileDirty} onClick={() => void validate()}>{l('校验格式与发现', 'Validate format and discovery')}</button><button className="button primary" disabled={busy || fileDirty || !draft.validation?.valid} onClick={() => void publish()}>{l('发布', 'Publish')}</button><button className="button danger" disabled={busy} onClick={() => void discard()}>{l('丢弃草稿', 'Discard')}</button></>}
        </div>
        <div className="skill-file-layout"><div className="skill-tree"><h3>{l('目录树', 'Files')}</h3>{files.map((entry) => <div key={entry.path} className={`skill-tree-row ${selectedFile === entry.path ? 'active' : ''}`}><button className="skill-file-name" style={{ paddingLeft: `${entry.path.split('/').length * 12}px` }} onClick={() => entry.kind === 'file' && selectFile(entry.path)}>{entry.kind === 'directory' ? '▸' : entry.text ? '≡' : '▧'} {entry.path.split('/').at(-1)}</button>{draft && entry.path !== 'SKILL.md' && <span><button title={l('重命名', 'Rename')} onClick={() => void entryAction('rename', entry.path)}>✎</button><button title={l('删除', 'Delete')} onClick={() => void entryAction('delete', entry.path)}>×</button></span>}</div>)}</div>
          <div className="skill-file-editor"><h3>{selectedFile || l('选择文件', 'Select a file')} {file?.kind === 'file' && <small>{(file.size / 1024).toFixed(1)} KiB</small>}</h3>{file?.kind === 'file' ? file.text && file.size <= 1024 * 1024 ? <><textarea className="code-editor large" aria-label={selectedFile} value={fileText} readOnly={!draft} onChange={(event) => { setFileText(event.target.value); setFileDirty(true); }} /><div className="skill-toolbar"><a className="button ghost" href={`${fileUrl}&download=1`}>{l('下载', 'Download')}</a>{draft && <button className="button primary" disabled={busy || !fileDirty} onClick={() => void saveFile()}>{l('保存文件', 'Save file')}</button>}</div></> : <><p>{l('二进制文件或大于 1 MiB 的文件可预览／下载，并通过上传替换。', 'Binary or large files can be previewed, downloaded and replaced.')}</p>{/\.(png|jpe?g|webp)$/i.test(selectedFile) && <img className="skill-image-preview" src={fileUrl} alt={selectedFile} />}<div className="skill-toolbar"><a className="button ghost" href={`${fileUrl}&download=1`}>{l('下载文件', 'Download file')}</a>{draft && <label className="button ghost">{l('上传替换', 'Replace file')}<input hidden type="file" onChange={(event) => { const uploadFile = event.target.files?.[0]; if (uploadFile) void replaceFile(uploadFile); event.target.value = ''; }} /></label>}</div></> : <p>{l('在左侧选择文件。', 'Select a file from the tree.')}</p>}</div></div>
        {draft && <div className="skill-validation"><h3>{l('校验结果', 'Validation')}</h3>{draft.validation ? <><p>{draft.validation.valid ? l('格式通过 · SDK 已发现', 'Format passed · SDK discovered') : l('存在阻断错误', 'Blocking issues found')}</p>{draft.validation.issues.map((issue, index) => <p key={index} className="field-error"><code>{issue.path}</code> · {issue.message}</p>)}</> : <p>{l('文件修改后需要重新校验。', 'Validate after file changes.')}</p>}<small>{l('合规性仅覆盖格式、ZIP 安全与 SDK 可发现性；脚本未在校验时运行，执行仍受 Agent 工具和路径授权约束。', 'Validation covers format, ZIP safety and SDK discovery. Scripts are not run during validation; Agent tool and path permissions still apply.')}</small></div>}
      </>}
    </section>
  </div>;
}
