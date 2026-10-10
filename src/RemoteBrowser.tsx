import { useEffect, useRef, useState } from 'react';
import type { Conversation, JdTask, RemoteBrowserView } from '../shared/types';
import type { Language } from './i18n';
import './remote-browser.css';

type Props = { conversationId: string; conversationStatus: Conversation['status']; language: Language };

const stateLabels: Record<NonNullable<RemoteBrowserView['session']>['state'], [string, string]> = {
  CREATED: ['正在创建云浏览器', 'Creating cloud browser'],
  AI_RUNNING: ['Agent 正在操作', 'Agent is operating'],
  HUMAN_CONTROL: ['等待你操作', 'Your turn to operate'],
  RECONNECTING: ['正在续接同一浏览器', 'Reconnecting the same browser'],
  VERIFYING: ['正在核验登录', 'Verifying login'],
  COMPLETED: ['已确认登录', 'Login confirmed'],
  FAILED: ['操作失败', 'Session failed'],
  UNVERIFIED: ['当前云浏览器状态未确认', 'Current cloud browser state unverified'],
  EXPIRED: ['会话已到期', 'Session expired'],
  CLOSED: ['会话已关闭', 'Session closed'],
};

export function RemoteBrowser({ conversationId, conversationStatus, language }: Props) {
  const [view, setView] = useState<RemoteBrowserView | null>(null);
  const [task, setTask] = useState<JdTask | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const frameRef = useRef<HTMLIFrameElement>(null);
  const frameContainerRef = useRef<HTMLDivElement>(null);
  const en = language === 'en';

  useEffect(() => {
    let active = true;
    setView(null);
    setTask(null);
    setError('');
    const refresh = async () => {
      try {
        const [response, taskResponse] = await Promise.all([
          fetch(`/api/conversations/${conversationId}/browser`, { cache: 'no-store' }),
          fetch(`/api/conversations/${conversationId}/jd-task`, { cache: 'no-store' }),
        ]);
        const [body, taskBody] = await Promise.all([response.json(), taskResponse.json()]);
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (active) { setView(body as RemoteBrowserView); setTask(taskResponse.ok ? taskBody.task as JdTask | null : null); setError(''); }
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : String(caught)); }
    };
    void refresh();
    const events = new EventSource(`/api/conversations/${conversationId}/browser/events`);
    events.onmessage = () => void refresh();
    events.onerror = () => { if (active) setError(en ? 'Browser status stream disconnected; reconnecting…' : '浏览器状态连接暂时中断，正在重连。'); };
    return () => { active = false; events.close(); };
  }, [conversationId, en]);

  useEffect(() => {
    if (view?.session?.state !== 'HUMAN_CONTROL') return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [view?.session?.state]);

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
  const remainingSeconds = session?.state === 'HUMAN_CONTROL' && session.liveUrlExpiresAt
    ? Math.max(0, Math.ceil((Date.parse(session.liveUrlExpiresAt) - now) / 1_000)) : null;
  const canRestart = view?.configured && (session
    ? ['FAILED', 'UNVERIFIED', 'EXPIRED', 'CLOSED'].includes(session.state)
    : conversationStatus === 'idle' || conversationStatus === 'interrupted');
  return <section className="panel remote-browser-panel" aria-label={en ? 'Remote browser' : '远程浏览器'}>
    <div className="remote-browser-head">
      <div>
        <h2>{en ? 'JD China mall · human handoff' : '京东商城 · 人工接管'}</h2>
        <p>{session ? session.state === 'COMPLETED' && !session.loginVerified ? (en ? 'Mall task processed; login not separately verified' : '商城任务已处理；账号登录未单独确认') : stateLabels[session.state][en ? 1 : 0] : canRestart ? (en ? 'Ready for a fresh browser session' : '可在准备好后重新打开云浏览器') : en ? 'The Agent is browsing in the background' : 'Agent 正在后台浏览商城'}</p>
        {remainingSeconds !== null && <p className={remainingSeconds <= 30 ? 'remote-browser-countdown urgent' : 'remote-browser-countdown'}>{en ? `Time left: ${remainingSeconds}s` : `本次浏览器剩余 ${remainingSeconds} 秒`}</p>}
      </div>
      <div className="remote-browser-actions">
        {session?.state === 'HUMAN_CONTROL' && <button className="button primary" disabled={busy} onClick={() => void submit('complete')}>{en ? 'Done, continue' : '完成并继续'}</button>}
        {canRestart && <button className="button primary" disabled={busy} onClick={() => void submit('restart')}>{task?.status === 'needs-human' ? (en ? 'Reopen JD verification' : '重新打开京东验证') : session?.profileStatus === 'saved' || session?.profileStatus === 'restored' ? (en ? 'Restore saved mall state' : '恢复商城访问状态') : (en ? 'Start a fresh browser' : '准备好后重新打开浏览器')}</button>}
        {view?.liveUrl && <button className="button ghost" onClick={() => frameRef.current?.focus()}>{en ? 'Focus browser' : '聚焦浏览器'}</button>}
        {view?.liveUrl && <button className="button ghost" onClick={() => void frameContainerRef.current?.requestFullscreen().catch(() => setError(en ? 'Full screen is unavailable in this browser.' : '当前浏览器无法进入全屏。'))}>{en ? 'Full screen' : '全屏操作'}</button>}
        {session && !['CLOSED', 'EXPIRED', 'FAILED', 'UNVERIFIED'].includes(session.state) && <button className="button ghost" disabled={busy} onClick={() => void submit('close')}>{en ? 'Close session' : '关闭会话'}</button>}
      </div>
    </div>
    {!view?.configured && <p className="remote-browser-notice">{en ? 'Set BROWSERLESS_API_TOKEN in .env, then restart the local server to use this Agent.' : '请在本机 .env 配置 BROWSERLESS_API_TOKEN，并重启服务后使用此 Agent。'}</p>}
    {session?.message && <p className="remote-browser-note">{session.message}</p>}
    {session?.profileStatus === 'saved' && <p className="remote-browser-note">{session.loginVerified
      ? (en ? 'JD login was saved and verified in a new cloud browser.' : '京东登录已保存，并在新云浏览器中确认。')
      : session.priorLoginVerified
        ? (en ? 'A new browser previously confirmed the saved JD login. The current page or connection needs another check.' : '保存的京东登录曾在新浏览器中确认；当前页面或连接需要再次核验。')
        : (en ? 'Mall access state was saved; account login is not separately confirmed.' : '商城访问状态已保存；账号登录尚未单独确认。')}</p>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {session?.liveUrlExpiresAt && <p className="remote-browser-meta">{en ? 'Viewer link expires: ' : '画面链接有效至：'}{new Date(session.liveUrlExpiresAt).toLocaleTimeString(en ? 'en-US' : 'zh-CN')}</p>}
    {session?.pageUrl && <p className="remote-browser-meta">{en ? 'Current page: ' : '当前页面：'}{session.pageUrl}</p>}
    <p className="remote-browser-help">{en ? 'Complete the JD login, slider or risk check shown in this browser. Click Done, continue in the sticky bar as soon as the check finishes. Press Esc to exit full screen.' : '请在画面内完成京东当前要求的登录、滑块或风险验证；完成后立刻点击上方常驻的“完成并继续”。按 Esc 退出全屏。'}</p>
    {session?.verification && <details className="remote-browser-evidence"><summary>{en ? 'Verification signals' : '查看核验依据（不含账号与验证码）'}</summary><p>{en ? 'Page' : '页面'}：{session.verification.host} · {en ? 'Login credentials' : '登录凭据'}：{session.verification.authCookiePair === null ? (en ? 'unavailable' : '未读取到') : session.verification.authCookiePair ? (en ? 'present' : '已出现') : (en ? 'absent' : '未出现')} · {en ? 'Login form' : '登录表单'}：{session.verification.loginFormVisible ? (en ? 'visible' : '可见') : (en ? 'not visible' : '不可见')} · {en ? 'Account controls' : '账户控件'}：{session.verification.signedInControlVisible ? (en ? 'visible' : '可见') : (en ? 'not visible' : '不可见')}</p></details>}
    {view?.liveUrl ? <div className="remote-browser-frame" ref={frameContainerRef}><iframe
      key={view.liveUrl}
      ref={frameRef}
      src={view.liveUrl}
      title={en ? 'Interactive Browserless JD browser' : '可交互的 Browserless 京东浏览器'}
      sandbox="allow-same-origin allow-scripts"
      allow="clipboard-read; clipboard-write"
      referrerPolicy="no-referrer"
    /></div> : <div className="remote-browser-placeholder">{session?.state === 'RECONNECTING' ? (en ? 'Reconnecting the same cloud browser; your JD page is preserved…' : '正在续接同一云浏览器，京东页面会保留，请稍候…') : session?.state === 'VERIFYING' ? (en ? 'Checking the same browser session…' : '正在检查同一浏览器会话…') : (en ? 'The live browser appears here when ready.' : '云浏览器准备好后会在这里实时显示。')}</div>}
    {task && <div className="jd-task-results">
      <h3>{en ? `JD products · ${task.keyword}` : `京东商品 · ${task.keyword}`}</h3>
      <p>{en ? `Collected ${task.products.length}/20 products; reviews checked ${task.nextReviewIndex}/${task.products.length}.` : `已读取 ${task.products.length}/20 个商品；已检查 ${task.nextReviewIndex}/${task.products.length} 个商品的评论。`}</p>
      <p>{task.sortApplied ? (en ? 'JD sales sorting was selected on the page.' : '已在页面选择“销量”排序。') : (en ? 'Sales sorting has not been verified; these are not a confirmed sales top 20.' : '销量排序尚未核实，不能将这些结果称为销量前 20。')}</p>
      {task.note && <p>{task.note}</p>}
      {!!task.products.length && <div className="jd-task-table-wrap"><table><thead><tr><th>#</th><th>{en ? 'Product / brand' : '商品／品牌'}</th><th>{en ? 'Price' : '价格'}</th><th>{en ? 'Promotion' : '促销'}</th><th>{en ? 'Reviews' : '评论'}</th></tr></thead><tbody>{task.products.map((item) => <tr key={item.sku}><td>{item.rank}</td><td><a href={item.url} target="_blank" rel="noopener noreferrer">{item.name}</a>{item.brand && <small>{item.brand}</small>}</td><td>{item.price ?? '—'}</td><td>{item.promotion ?? '—'}</td><td>{item.reviews.length ? item.reviews.map((review, index) => <p key={index}>{review.text}</p>) : item.commentCount ?? '—'}</td></tr>)}</tbody></table></div>}
    </div>}
  </section>;
}
