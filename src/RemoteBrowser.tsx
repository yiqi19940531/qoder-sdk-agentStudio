import { useEffect, useRef, useState } from 'react';
import type { Conversation, RemoteBrowserView } from '../shared/types';
import type { Language } from './i18n';
import './remote-browser.css';

type Props = { conversationId: string; conversationStatus: Conversation['status']; language: Language };

const stateLabels: Record<NonNullable<RemoteBrowserView['session']>['state'], [string, string]> = {
  CREATED: ['正在创建云浏览器', 'Creating cloud browser'],
  AI_RUNNING: ['Agent 正在操作', 'Agent is operating'],
  HUMAN_CONTROL: ['等待你操作', 'Your turn to operate'],
  VERIFYING: ['正在核验登录', 'Verifying login'],
  COMPLETED: ['已确认登录', 'Login confirmed'],
  FAILED: ['操作失败', 'Session failed'],
  EXPIRED: ['会话已到期', 'Session expired'],
  CLOSED: ['会话已关闭', 'Session closed'],
};

export function RemoteBrowser({ conversationId, conversationStatus, language }: Props) {
  const [view, setView] = useState<RemoteBrowserView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const en = language === 'en';

  useEffect(() => {
    let active = true;
    setView(null);
    setError('');
    const refresh = async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/browser`, { cache: 'no-store' });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (active) { setView(body as RemoteBrowserView); setError(''); }
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : String(caught)); }
    };
    void refresh();
    const events = new EventSource(`/api/conversations/${conversationId}/browser/events`);
    events.onmessage = () => void refresh();
    events.onerror = () => { if (active) setError(en ? 'Browser status stream disconnected; reconnecting…' : '浏览器状态连接暂时中断，正在重连。'); };
    return () => { active = false; events.close(); };
  }, [conversationId, en]);

  async function submit(action: 'complete' | 'close' | 'restart') {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/conversations/${conversationId}/browser/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setView(body as RemoteBrowserView);
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setBusy(false); }
  }

  const session = view?.session;
  const canRestart = view?.configured && (session
    ? ['FAILED', 'EXPIRED', 'CLOSED'].includes(session.state)
    : conversationStatus === 'idle' || conversationStatus === 'interrupted');
  return <section className="panel remote-browser-panel" aria-label={en ? 'Remote browser' : '远程浏览器'}>
    <div className="remote-browser-head">
      <div>
        <h2>{en ? 'Remote browser · JD login' : '远程浏览器 · 京东登录'}</h2>
        <p>{session ? stateLabels[session.state][en ? 1 : 0] : canRestart ? (en ? 'Ready for a fresh browser session' : '可在准备好后重新打开云浏览器') : en ? 'Waiting for the Agent to open JD' : '等待 Agent 打开京东登录页'}</p>
      </div>
      <div className="remote-browser-actions">
        {session?.state === 'HUMAN_CONTROL' && <button className="button primary" disabled={busy} onClick={() => void submit('complete')}>{en ? 'Done, continue' : '完成并继续'}</button>}
        {canRestart && <button className="button primary" disabled={busy} onClick={() => void submit('restart')}>{en ? 'Start a fresh login' : '准备好后重新开始登录'}</button>}
        {view?.liveUrl && <button className="button ghost" onClick={() => frameRef.current?.focus()}>{en ? 'Focus browser' : '聚焦浏览器'}</button>}
        {session && !['CLOSED', 'EXPIRED', 'FAILED'].includes(session.state) && <button className="button ghost" disabled={busy} onClick={() => void submit('close')}>{en ? 'Close session' : '关闭会话'}</button>}
      </div>
    </div>
    {!view?.configured && <p className="remote-browser-notice">{en ? 'Set BROWSERLESS_API_TOKEN in .env, then restart the local server to use this Agent.' : '请在本机 .env 配置 BROWSERLESS_API_TOKEN，并重启服务后使用此 Agent。'}</p>}
    {session?.message && <p className="remote-browser-note">{session.message}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {session?.liveUrlExpiresAt && <p className="remote-browser-meta">{en ? 'Viewer link expires: ' : '画面链接有效至：'}{new Date(session.liveUrlExpiresAt).toLocaleTimeString(en ? 'en-US' : 'zh-CN')}</p>}
    {view?.liveUrl ? <div className="remote-browser-frame"><iframe
      key={view.liveUrl}
      ref={frameRef}
      src={view.liveUrl}
      title={en ? 'Interactive Browserless JD browser' : '可交互的 Browserless 京东浏览器'}
      sandbox="allow-same-origin allow-scripts"
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
    /></div> : <div className="remote-browser-placeholder">{session?.state === 'VERIFYING' ? (en ? 'Checking the same browser session…' : '正在检查同一浏览器会话…') : (en ? 'The live browser appears here when ready.' : '云浏览器准备好后会在这里实时显示。')}</div>}
    <p className="remote-browser-help">{en ? 'Enter your phone number and SMS code only inside this browser. The Agent pauses while you handle the slider.' : '手机号、短信验证码只在此浏览器中输入。人工拖动滑块时，Agent 暂停页面操作。'}</p>
  </section>;
}
