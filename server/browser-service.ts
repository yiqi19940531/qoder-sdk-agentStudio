import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import puppeteer, { type Browser, type BrowserContext, type CDPSession, type Page } from 'puppeteer-core';
import type { RemoteBrowserState, RemoteBrowserSummary, RemoteBrowserView } from '../shared/types.js';
import { JD_LOGIN_URL, verifyJdLogin, type LoginVerdict } from './jd-login.js';

type Session = {
  conversationId: string;
  sessionId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: BrowserlessCDP;
  state: RemoteBrowserState;
  viewMode: RemoteBrowserSummary['viewMode'];
  revision: number;
  pageUrl?: string;
  pageTitle?: string;
  liveUrl?: string;
  liveURLId?: string;
  liveUrlExpiresAt?: string;
  message?: string;
  deadline: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  liveTimer?: ReturnType<typeof setTimeout>;
  completionListener?: (payload: { liveURLId: string; reason: string }) => void;
};

// Browserless CDP extensions are intentionally absent from the standard CDP types.
type BrowserlessCDP = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (payload: { liveURLId: string; reason: string }) => void): void;
  off(event: string, listener: (payload: { liveURLId: string; reason: string }) => void): void;
};

type BrowserDeps = {
  connect?: (url: string) => Promise<Browser>;
  verify?: (page: Page) => Promise<LoginVerdict>;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_ENDPOINT = 'wss://production-sfo.browserless.io/chromium';
const DEFAULT_SESSION_MS = 120_000;
const activeStates = new Set<RemoteBrowserState>(['CREATED', 'AI_RUNNING', 'HUMAN_CONTROL', 'VERIFYING', 'COMPLETED']);

function milliseconds(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 30_000 && value <= 3_600_000 ? value : fallback;
}

function safePageUrl(raw: string): string | undefined {
  try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
  catch { return undefined; }
}

export class BrowserService {
  private readonly sessions = new Map<string, Session>();
  private readonly opening = new Map<string, Promise<RemoteBrowserSummary>>();
  private readonly handingOff = new Map<string, Promise<RemoteBrowserSummary>>();
  private readonly viewers = new Map<string, Set<Response>>();
  private stateListener?: (summary: RemoteBrowserSummary) => void;
  private outcomeListener?: (conversationId: string, result: 'confirmed' | 'failed', message: string) => void;

  constructor(private readonly deps: BrowserDeps = {}) {}

  private get env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }
  configured(): boolean { return Boolean(this.env.BROWSERLESS_API_TOKEN?.trim()); }
  onState(listener: (summary: RemoteBrowserSummary) => void): void { this.stateListener = listener; }
  onOutcome(listener: (conversationId: string, result: 'confirmed' | 'failed', message: string) => void): void { this.outcomeListener = listener; }

  private endpoint(): { url: string; origin: string; sessionMs: number; liveMs: number } {
    const token = this.env.BROWSERLESS_API_TOKEN?.trim();
    if (!token) throw new Error('尚未配置 BROWSERLESS_API_TOKEN；请先在本机设置环境变量并重启服务。');
    const url = new URL(this.env.BROWSERLESS_WS_ENDPOINT || DEFAULT_ENDPOINT);
    if (url.protocol !== 'wss:' || url.username || url.password || url.searchParams.has('token')) {
      throw new Error('BROWSERLESS_WS_ENDPOINT 必须是不含 Token 的 wss:// 地址。');
    }
    const sessionMs = milliseconds(this.env.BROWSERLESS_SESSION_TIMEOUT_MS, DEFAULT_SESSION_MS);
    const liveMs = milliseconds(this.env.BROWSERLESS_LIVE_TIMEOUT_MS, sessionMs);
    url.searchParams.set('token', token);
    url.searchParams.set('timeout', String(sessionMs));
    const origin = this.env.BROWSERLESS_LIVE_ORIGIN?.trim() || `https://${url.host}`;
    if (new URL(origin).protocol !== 'https:') throw new Error('BROWSERLESS_LIVE_ORIGIN 必须是 HTTPS 来源。');
    return { url: url.toString(), origin: new URL(origin).origin, sessionMs, liveMs };
  }

  liveOrigin(): string {
    try {
      const endpoint = new URL(this.env.BROWSERLESS_WS_ENDPOINT || DEFAULT_ENDPOINT);
      return new URL(this.env.BROWSERLESS_LIVE_ORIGIN?.trim() || `https://${endpoint.host}`).origin;
    } catch { return 'https://production-sfo.browserless.io'; }
  }

  private summary(session: Session): RemoteBrowserSummary {
    return {
      conversationId: session.conversationId, sessionId: session.sessionId,
      state: session.state, viewMode: session.viewMode, revision: session.revision,
      ...(session.pageUrl ? { pageUrl: session.pageUrl } : {}),
      ...(session.pageTitle ? { pageTitle: session.pageTitle } : {}),
      ...(session.liveUrlExpiresAt ? { liveUrlExpiresAt: session.liveUrlExpiresAt } : {}),
      ...(session.message ? { message: session.message } : {}),
    };
  }

  private publish(session: Session): void {
    session.revision += 1;
    const summary = this.summary(session);
    this.stateListener?.(summary);
    const payload = `data: ${JSON.stringify(summary)}\n\n`;
    for (const response of this.viewers.get(session.conversationId) ?? []) response.write(payload);
  }

  view(conversationId: string): RemoteBrowserView {
    const session = this.sessions.get(conversationId);
    return {
      configured: this.configured(), session: session ? this.summary(session) : null,
      ...(session?.liveUrl && session.liveUrlExpiresAt && Date.now() < Date.parse(session.liveUrlExpiresAt) ? { liveUrl: session.liveUrl } : {}),
    };
  }

  subscribe(conversationId: string, response: Response): void {
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    const listeners = this.viewers.get(conversationId) ?? new Set<Response>();
    listeners.add(response);
    this.viewers.set(conversationId, listeners);
    const session = this.sessions.get(conversationId);
    if (session) response.write(`data: ${JSON.stringify(this.summary(session))}\n\n`);
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 20_000);
    response.on('close', () => {
      clearInterval(heartbeat);
      listeners.delete(response);
      if (!listeners.size) this.viewers.delete(conversationId);
    });
  }

  private require(conversationId: string): Session {
    const session = this.sessions.get(conversationId);
    if (!session) throw new Error('当前对话还没有云浏览器会话。');
    return session;
  }

  private async updatePage(session: Session): Promise<void> {
    session.pageUrl = safePageUrl(session.page.url());
    try { session.pageTitle = (await session.page.title()).slice(0, 120); }
    catch { session.pageTitle = undefined; }
  }

  private async mint(session: Session, interactable: boolean): Promise<void> {
    if (session.completionListener) session.cdp.off('Browserless.liveComplete', session.completionListener);
    if (session.liveTimer) clearTimeout(session.liveTimer);
    const config = this.endpoint();
    const remaining = Math.min(config.liveMs, session.deadline - Date.now());
    if (remaining < 1000) throw new Error('云浏览器会话已到期，请开启新对话。');
    const result = await session.cdp.send('Browserless.liveURL', {
      interactable, showBrowserInterface: true, quality: 80, resizable: false,
      timeout: Math.floor(remaining),
      ...(interactable ? { instructions: '请在京东页面自行完成手机号、滑块和短信验证；完成后点击“完成并继续”或浏览器中的 Done。' } : {}),
    }) as { error?: string | null; liveURL?: string; liveURLId?: string; timeout?: number };
    if (result.error || !result.liveURL || !result.liveURLId) throw new Error(`Browserless 实时画面创建失败：${result.error || '未返回链接'}`);
    if (!activeStates.has(session.state) || Date.now() >= session.deadline) {
      await session.cdp.send('Browserless.closeLiveURL', { liveURLId: result.liveURLId }).catch(() => {});
      throw new Error('云浏览器会话已结束，请开启新对话。');
    }
    const liveUrl = new URL(result.liveURL);
    if (liveUrl.protocol !== 'https:' || liveUrl.origin !== config.origin) throw new Error('Browserless 返回了非预期来源的实时画面地址。');
    session.liveUrl = liveUrl.toString();
    session.liveURLId = result.liveURLId;
    session.viewMode = interactable ? 'interactive' : 'view-only';
    const appliedMs = Math.min(result.timeout ?? remaining, session.deadline - Date.now());
    session.liveUrlExpiresAt = new Date(Date.now() + appliedMs).toISOString();
    session.liveTimer = setTimeout(() => {
      if (session.state === 'HUMAN_CONTROL') void this.expire(session, '人工接管链接已到期；准备好后可在面板重新开始登录。');
      else {
        session.liveUrl = undefined;
        session.liveURLId = undefined;
        session.liveUrlExpiresAt = undefined;
        session.viewMode = 'none';
        this.publish(session);
      }
    }, appliedMs);
    if (interactable) {
      // Register after mint: replacing a link emits "closed" for the previous mint.
      const listener = (payload: { liveURLId: string; reason: string }) => {
        if (session.state !== 'HUMAN_CONTROL' || payload.liveURLId !== session.liveURLId) return;
        if (payload.reason === 'userDone') void this.complete(session.conversationId).catch(() => {});
        else if (payload.reason === 'userFailed') void this.fail(session, '用户表示未能完成京东验证。');
        else if (payload.reason === 'viewerDisconnected') {
          session.message = '实时画面已断开；链接有效期内可重新打开。';
          this.publish(session);
        }
      };
      session.completionListener = listener;
      session.cdp.on('Browserless.liveComplete', listener);
    } else session.completionListener = undefined;
  }

  async open(conversationId: string): Promise<RemoteBrowserSummary> {
    const pending = this.opening.get(conversationId);
    if (pending) return pending;
    const existing = this.sessions.get(conversationId);
    if (existing) {
      if (!activeStates.has(existing.state)) throw new Error('原云浏览器会话已结束，请开启新对话。');
      return this.summary(existing);
    }
    const operation = this.start(conversationId);
    this.opening.set(conversationId, operation);
    try { return await operation; }
    finally { this.opening.delete(conversationId); }
  }

  private async start(conversationId: string): Promise<RemoteBrowserSummary> {
    const config = this.endpoint();
    const connect = this.deps.connect ?? ((url: string) => puppeteer.connect({ browserWSEndpoint: url, protocolTimeout: 30_000 }));
    let browser: Browser;
    try { browser = await connect(config.url); }
    catch (error) { throw new Error(`Browserless 连接失败：${this.safeError(error)}`); }
    try {
      const page = (await browser.pages())[0] ?? await browser.newPage();
      const context = page.browserContext();
      await page.setViewport({ width: 1280, height: 800 });
      const cdp = await page.createCDPSession() as CDPSession as unknown as BrowserlessCDP;
      const session: Session = {
        conversationId, sessionId: randomUUID(), browser, context, page, cdp,
        state: 'CREATED', viewMode: 'none', revision: 0, deadline: Date.now() + config.sessionMs,
      };
      this.sessions.set(conversationId, session);
      browser.on('disconnected', () => {
        if (activeStates.has(session.state)) void this.expire(session, 'Browserless 云浏览器连接已断开。');
      });
      session.deadlineTimer = setTimeout(() => void this.expire(session, 'Browserless 云浏览器会话已到期；准备好后可在面板重新开始登录。'), config.sessionMs);
      this.publish(session);
      await page.goto(JD_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      if (session.state !== 'CREATED') throw new Error('云浏览器在打开京东页面时已结束。');
      await this.updatePage(session);
      session.state = 'AI_RUNNING';
      session.message = '京东登录页已打开，等待 Agent 交给用户操作。';
      if (session.state !== 'AI_RUNNING') throw new Error('云浏览器在显示登录页时已结束。');
      this.publish(session);
      return this.summary(session);
    } catch (error) {
      const session = this.sessions.get(conversationId);
      if (session) await this.fail(session, '京东登录页面打开失败；请检查 Browserless 连接和页面限制。');
      else await browser.close().catch(() => {});
      throw new Error(`云浏览器启动失败：${this.safeError(error)}`);
    }
  }

  async handoff(conversationId: string): Promise<RemoteBrowserSummary> {
    const pending = this.handingOff.get(conversationId);
    if (pending) return pending;
    const operation = this.startHandoff(conversationId);
    this.handingOff.set(conversationId, operation);
    try { return await operation; }
    finally { this.handingOff.delete(conversationId); }
  }

  async restartForHuman(conversationId: string): Promise<RemoteBrowserSummary> {
    const existing = this.sessions.get(conversationId);
    if (existing && activeStates.has(existing.state)) throw new Error('当前云浏览器仍在运行，请先完成或关闭本次操作。');
    if (existing) this.sessions.delete(conversationId);
    await this.open(conversationId);
    return this.handoff(conversationId);
  }

  private async startHandoff(conversationId: string): Promise<RemoteBrowserSummary> {
    const session = this.require(conversationId);
    if (session.state === 'HUMAN_CONTROL') return this.summary(session);
    if (session.state !== 'AI_RUNNING') throw new Error('当前状态不能进入人工接管。');
    await this.mint(session, true);
    if (session.state !== 'AI_RUNNING') throw new Error('云浏览器在切换人工接管时已结束。');
    session.state = 'HUMAN_CONTROL';
    session.message = '请在下方实时浏览器中自行完成京东登录与验证。';
    this.publish(session);
    return this.summary(session);
  }

  async complete(conversationId: string): Promise<RemoteBrowserSummary> {
    const session = this.require(conversationId);
    if (session.state === 'VERIFYING' || session.state === 'COMPLETED') return this.summary(session);
    if (session.state !== 'HUMAN_CONTROL') throw new Error('当前没有等待完成的人工接管。');
    session.state = 'VERIFYING';
    session.viewMode = 'none';
    session.liveUrl = undefined;
    session.liveUrlExpiresAt = undefined;
    session.message = '正在使用同一云浏览器检查京东登录状态。';
    this.publish(session);
    if (session.liveTimer) clearTimeout(session.liveTimer);
    if (session.liveURLId) await session.cdp.send('Browserless.closeLiveURL', { liveURLId: session.liveURLId }).catch(() => {});
    session.liveURLId = undefined;
    const verdict = await (this.deps.verify ?? verifyJdLogin)(session.page);
    if (session.state !== 'VERIFYING') return this.summary(session);
    await this.updatePage(session);
    if (verdict.status === 'confirmed') {
      session.state = 'COMPLETED';
      session.message = verdict.message;
      this.publish(session);
      this.outcomeListener?.(conversationId, 'confirmed', verdict.message);
    } else {
      await this.fail(session, `${verdict.message} 请准备好后在面板重新开始登录。`);
    }
    return this.summary(session);
  }

  getState(conversationId: string): RemoteBrowserSummary {
    return this.summary(this.require(conversationId));
  }

  private safeError(error: unknown): string {
    const token = this.env.BROWSERLESS_API_TOKEN?.trim();
    const raw = error instanceof Error ? error.message : String(error);
    return (token ? raw.replaceAll(token, '[REDACTED]') : raw).replace(/([?&](?:token|api[_-]?key)=)[^\s&]+/gi, '$1[REDACTED]').slice(0, 500);
  }

  private async fail(session: Session, message: string): Promise<void> {
    if (!activeStates.has(session.state)) return;
    const shouldReport = session.state === 'HUMAN_CONTROL' || session.state === 'VERIFYING';
    session.state = 'FAILED';
    session.message = message;
    session.liveUrl = undefined;
    session.viewMode = 'none';
    this.publish(session);
    if (shouldReport) this.outcomeListener?.(session.conversationId, 'failed', message);
    await this.release(session);
  }

  private async expire(session: Session, message: string): Promise<void> {
    if (!activeStates.has(session.state)) return;
    const shouldReport = session.state === 'HUMAN_CONTROL' || session.state === 'VERIFYING';
    session.state = 'EXPIRED';
    session.message = message;
    session.liveUrl = undefined;
    session.viewMode = 'none';
    this.publish(session);
    if (shouldReport) this.outcomeListener?.(session.conversationId, 'failed', message);
    await this.release(session);
  }

  private async release(session: Session): Promise<void> {
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    if (session.liveTimer) clearTimeout(session.liveTimer);
    if (session.completionListener) session.cdp.off('Browserless.liveComplete', session.completionListener);
    if (session.liveURLId) await session.cdp.send('Browserless.closeLiveURL', { liveURLId: session.liveURLId }).catch(() => {});
    await session.browser.close().catch(() => {});
  }

  async close(conversationId: string, actor: 'user' | 'agent' = 'user'): Promise<RemoteBrowserSummary> {
    const session = this.require(conversationId);
    if (session.state === 'CLOSED') return this.summary(session);
    if (actor === 'agent' && (session.state === 'HUMAN_CONTROL' || session.state === 'VERIFYING')) {
      throw new Error('人工接管或核验期间，Agent 不得关闭云浏览器。');
    }
    const wasVerified = session.state === 'COMPLETED';
    session.state = 'CLOSED';
    session.message = '云浏览器会话已关闭。';
    session.liveUrl = undefined;
    session.viewMode = 'none';
    this.publish(session);
    if (!wasVerified) this.outcomeListener?.(session.conversationId, 'failed', '用户已关闭京东云浏览器会话。');
    await this.release(session);
    return this.summary(session);
  }
}

export const browserService = new BrowserService();
