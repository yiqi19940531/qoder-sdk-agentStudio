import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import puppeteer, { type Browser, type BrowserContext, type CDPSession, type Page } from 'puppeteer-core';
import type { RemoteBrowserState, RemoteBrowserSummary, RemoteBrowserView } from '../shared/types.js';
import { JD_ACCOUNT_URL, JD_LOGIN_URL, JD_MALL_URL, inspectJdBrowserPages, verifyJdLogin, type LoginVerdict } from './jd-login.js';
import { BrowserlessJdProfileProvider, jdProxySettings, type JdProfileProvider } from './jd-profile.js';
import { collectJdReviews, loadJdTask, newJdTask, saveJdTask, searchJdProducts, type JdReviewObservation, type JdSearchObservation, type JdTask } from './jd-shop.js';

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
  verification?: RemoteBrowserSummary['verification'];
  deadline: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  liveTimer?: ReturnType<typeof setTimeout>;
  completionListener?: (payload: { liveURLId: string; reason: string }) => void;
  monitorTimer?: ReturnType<typeof setInterval>;
  monitorBusy?: boolean;
  monitorNavigationListener?: () => void;
  profileCandidateName?: string;
  profileStatus?: 'creating' | 'restored' | 'saved';
  replacing?: boolean;
  authenticated?: boolean;
  pendingTaskKeyword?: string;
  pendingTaskUrl?: string;
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
  search?: (page: Page, keyword: string, limit: number) => Promise<JdSearchObservation>;
  reviews?: (page: Page, product: JdTask['products'][number]) => Promise<JdReviewObservation>;
  profileProvider?: JdProfileProvider | null;
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
  private outcomeListener?: (conversationId: string, result: 'confirmed' | 'ready' | 'failed' | 'unverified', message: string) => void;

  private readonly profileProvider: JdProfileProvider | null;

  constructor(private readonly deps: BrowserDeps = {}) {
    this.profileProvider = deps.profileProvider === undefined
      ? (deps.connect ? null : new BrowserlessJdProfileProvider(deps.env ?? process.env))
      : deps.profileProvider;
  }

  private get env(): NodeJS.ProcessEnv { return this.deps.env ?? process.env; }
  configured(): boolean { return Boolean(this.env.BROWSERLESS_API_TOKEN?.trim()); }
  onState(listener: (summary: RemoteBrowserSummary) => void): void { this.stateListener = listener; }
  onOutcome(listener: (conversationId: string, result: 'confirmed' | 'ready' | 'failed' | 'unverified', message: string) => void): void { this.outcomeListener = listener; }

  private endpoint(profileName?: string): { url: string; origin: string; sessionMs: number; liveMs: number } {
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
    if (profileName) url.searchParams.set('profile', profileName);
    const proxy = jdProxySettings(this.env);
    if (proxy) {
      url.searchParams.set('proxy', proxy.type);
      url.searchParams.set('proxyCountry', proxy.country);
      url.searchParams.set('proxySticky', 'true');
    }
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
      ...(session.verification ? { verification: session.verification } : {}),
      ...(session.profileStatus ? { profileStatus: session.profileStatus } : {}),
      loginVerified: session.authenticated === true,
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

  async open(conversationId: string, targetUrl = JD_MALL_URL): Promise<RemoteBrowserSummary> {
    const pending = this.opening.get(conversationId);
    if (pending) return pending;
    const existing = this.sessions.get(conversationId);
    if (existing) {
      if (!activeStates.has(existing.state)) throw new Error('原云浏览器会话已结束，请开启新对话。');
      return this.summary(existing);
    }
    const operation = this.start(conversationId, targetUrl);
    this.opening.set(conversationId, operation);
    try { return await operation; }
    finally { this.opening.delete(conversationId); }
  }

  private async start(conversationId: string, targetUrl = JD_MALL_URL): Promise<RemoteBrowserSummary> {
    const config = this.endpoint();
    const saved = await this.profileProvider?.load();
    if (saved) {
      try {
        const session = await this.connectAndNavigate(conversationId, this.endpoint(saved.name).url, saved.mode === 'mall' ? targetUrl : JD_MALL_URL, Date.now(), 'restored');
        if (saved.mode === 'mall') {
          const host = (() => { try { return new URL(session.page.url()).hostname; } catch { return ''; } })();
          if (host === 'www.jd.com' || host === 'search.jd.com' || host === 'item.jd.com') {
            session.state = 'COMPLETED';
            session.message = '已加载保存的商城访问档案；账号登录状态尚未单独确认。';
            this.publish(session);
            return this.summary(session);
          }
        }
        const verdict = await (this.deps.verify ?? verifyJdLogin)(session.page, Math.max(0, session.deadline - Date.now() - 1_000));
        if (verdict.status === 'confirmed' && session.state === 'AI_RUNNING') {
          session.verification = verdict.evidence ? this.safeEvidence(verdict.evidence, verdict.source) : undefined;
          session.state = 'COMPLETED';
          session.authenticated = true;
          session.message = '已从保存的京东登录档案恢复，并在新浏览器中确认登录。';
          this.publish(session);
          return this.summary(session);
        }
        session.replacing = true;
        session.state = 'CLOSED';
        await this.release(session);
        if (this.sessions.get(conversationId) === session) this.sessions.delete(conversationId);
      } catch {
        const session = this.sessions.get(conversationId);
        if (session?.profileStatus === 'restored') {
          session.replacing = true;
          session.state = 'CLOSED';
          await this.release(session);
          this.sessions.delete(conversationId);
        }
      }
    }
    const startedAt = Date.now();
    const creation = await this.profileProvider?.create(config.sessionMs);
    const session = await this.connectAndNavigate(conversationId, creation?.connect ?? config.url, targetUrl, startedAt, creation ? 'creating' : undefined);
    if (creation) session.profileCandidateName = creation.name;
    return this.summary(session);
  }

  private async connectAndNavigate(
    conversationId: string, url: string, targetUrl: string, startedAt: number,
    profileStatus?: Session['profileStatus'],
  ): Promise<Session> {
    const config = this.endpoint();
    const connect = this.deps.connect ?? ((url: string) => puppeteer.connect({ browserWSEndpoint: url, protocolTimeout: 30_000 }));
    let browser: Browser;
    try { browser = await connect(url); }
    catch (error) { throw new Error(`Browserless 连接失败：${this.safeError(error)}`); }
    try {
      const page = (await browser.pages())[0] ?? await browser.newPage();
      const context = page.browserContext();
      await page.setViewport({ width: 1280, height: 800 });
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
      await page.emulateTimezone('Asia/Shanghai');
      const cdp = await page.createCDPSession() as CDPSession as unknown as BrowserlessCDP;
      const session: Session = {
        conversationId, sessionId: randomUUID(), browser, context, page, cdp,
        state: 'CREATED', viewMode: 'none', revision: 0, deadline: startedAt + config.sessionMs - 1_000, profileStatus,
      };
      this.sessions.set(conversationId, session);
      browser.on('disconnected', () => {
        if (!session.replacing && activeStates.has(session.state)) void this.expire(session, 'Browserless 云浏览器连接已断开。');
      });
      session.deadlineTimer = setTimeout(() => void this.expire(session, 'Browserless 云浏览器会话已到期；准备好后可在面板重新开始登录。'), Math.max(1_000, session.deadline - Date.now()));
      this.publish(session);
      try { await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 12_000 }); }
      catch (error) {
        // JD may keep loading subresources after the login document has already navigated.
        // Keep the live browser usable if the page is on an official JD host.
        const host = (() => { try { return new URL(page.url()).hostname; } catch { return ''; } })();
        if (host !== 'jd.com' && !host.endsWith('.jd.com')) throw error;
      }
      if (session.state !== 'CREATED') throw new Error('云浏览器在打开京东页面时已结束。');
      await this.updatePage(session);
      session.state = 'AI_RUNNING';
      session.message = profileStatus === 'restored' ? '正在中国区京东商城检查已保存的登录档案。' : '中国区京东商城已打开；请在页面右上角进入登录。';
      if (session.state !== 'AI_RUNNING') throw new Error('云浏览器在显示登录页时已结束。');
      this.publish(session);
      return session;
    } catch (error) {
      const session = this.sessions.get(conversationId);
      if (session) await this.fail(session, '京东页面打开失败；请检查 Browserless 连接和页面限制。');
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
    const task = await loadJdTask(conversationId);
    const target = task?.status === 'needs-human'
      ? task.products[task.nextReviewIndex]?.url ?? `https://search.jd.com/Search?keyword=${encodeURIComponent(task.keyword)}`
      : JD_MALL_URL;
    const opened = await this.open(conversationId, target);
    const current = this.require(conversationId);
    current.pendingTaskKeyword = task?.keyword;
    current.pendingTaskUrl = task?.status === 'needs-human' ? target : undefined;
    if (opened.state === 'COMPLETED' && task?.status === 'needs-human') {
      if (task.products.length) await this.collectReviews(conversationId, 3);
      else await this.searchProducts(conversationId, task.keyword);
      return this.getState(conversationId);
    }
    return this.handoff(conversationId);
  }

  private async startHandoff(conversationId: string): Promise<RemoteBrowserSummary> {
    const session = this.require(conversationId);
    if (session.state === 'COMPLETED') return this.summary(session);
    if (session.state === 'HUMAN_CONTROL') return this.summary(session);
    if (session.state !== 'AI_RUNNING') throw new Error('当前状态不能进入人工接管。');
    if (session.pendingTaskUrl) await this.openDirectLogin(session);
    await this.mint(session, true);
    if (session.state !== 'AI_RUNNING') throw new Error('云浏览器在切换人工接管时已结束。');
    session.state = 'HUMAN_CONTROL';
    session.message = '京东页面要求人工操作；请在下方实时浏览器中完成登录、滑块或风险验证。';
    this.publish(session);
    this.startMonitor(session);
    return this.summary(session);
  }

  private async openDirectLogin(session: Session): Promise<void> {
    const currentHost = (() => { try { return new URL(session.page.url()).hostname; } catch { return ''; } })();
    if (currentHost === 'passport.jd.com') return;
    const returnUrl = new URL(session.pendingTaskUrl!);
    if (returnUrl.protocol !== 'https:' || (returnUrl.hostname !== 'jd.com' && !returnUrl.hostname.endsWith('.jd.com'))) return;
    const login = new URL(JD_LOGIN_URL);
    login.searchParams.set('ReturnUrl', returnUrl.toString());
    await session.page.goto(login.toString(), { waitUntil: 'domcontentloaded', timeout: 12_000 }).catch(() => {});
    session.pageUrl = safePageUrl(session.page.url());
    const finalHost = (() => { try { return new URL(session.page.url()).hostname; } catch { return ''; } })();
    session.message = finalHost === 'passport.jd.com'
      ? '已直接打开京东官方登录入口，请在下方页面完成登录或验证。'
      : '京东仍要求先完成人工风险验证，请在下方页面操作。';
    this.publish(session);
  }

  private startMonitor(session: Session): void {
    if (session.monitorTimer) clearInterval(session.monitorTimer);
    const inspect = async () => {
      if (session.state !== 'HUMAN_CONTROL' || session.monitorBusy) return;
      session.monitorBusy = true;
      try {
        const { page, evidence, verdict } = await inspectJdBrowserPages(session.browser, session.page);
        if (session.state !== 'HUMAN_CONTROL') return;
        const verification = this.safeEvidence(evidence, 'current-page');
        const evidenceChanged = JSON.stringify(session.verification) !== JSON.stringify(verification);
        session.verification = verification;
        const currentUrl = safePageUrl(page.url());
        if (currentUrl !== session.pageUrl || evidenceChanged) {
          session.pageUrl = currentUrl;
          this.publish(session);
        }
        if (verdict.status === 'confirmed') void this.complete(session.conversationId, { ...verdict, source: 'current-page' }).catch(() => {});
      } catch { /* Read-only monitoring must not interrupt the person's browser input. */ }
      finally { session.monitorBusy = false; }
    };
    session.monitorTimer = setInterval(() => void inspect(), 2_500);
    if (typeof session.page.on === 'function') {
      session.monitorNavigationListener = () => void inspect();
      session.page.on('domcontentloaded', session.monitorNavigationListener);
    }
    void inspect();
  }

  private safeEvidence(evidence: NonNullable<LoginVerdict['evidence']>, source?: LoginVerdict['source']): RemoteBrowserSummary['verification'] {
    return {
      source, host: evidence.host, authCookiePair: evidence.authCookiePair,
      loginFormVisible: evidence.loginFormVisible, loginPromptVisible: evidence.loginPromptVisible,
      signedInControlVisible: evidence.signedInControlVisible, accountAreaVisible: evidence.accountAreaVisible,
    };
  }

  async complete(conversationId: string, observed?: LoginVerdict): Promise<RemoteBrowserSummary> {
    const session = this.require(conversationId);
    if (session.state === 'VERIFYING' || session.state === 'COMPLETED') return this.summary(session);
    if (session.state !== 'HUMAN_CONTROL') throw new Error('当前没有等待完成的人工接管。');
    session.state = 'VERIFYING';
    if (session.monitorTimer) clearInterval(session.monitorTimer);
    session.monitorTimer = undefined;
    if (session.monitorNavigationListener && typeof session.page.off === 'function') session.page.off('domcontentloaded', session.monitorNavigationListener);
    session.monitorNavigationListener = undefined;
    session.pageUrl = safePageUrl(session.page.url());
    session.viewMode = 'none';
    session.liveUrl = undefined;
    session.liveUrlExpiresAt = undefined;
    session.message = '正在使用同一云浏览器检查京东登录状态。';
    this.publish(session);
    if (session.liveTimer) clearTimeout(session.liveTimer);
    const liveURLId = session.liveURLId;
    session.liveURLId = undefined;
    if (session.profileCandidateName && this.profileProvider) {
      if (liveURLId) void session.cdp.send('Browserless.closeLiveURL', { liveURLId }).catch(() => {});
      return this.saveAndRestoreProfile(session);
    }
    if (observed?.status === 'confirmed') {
      if (observed.evidence) session.pageUrl = safePageUrl(`https://${observed.evidence.host}${observed.evidence.path}`);
      if (observed.evidence) session.verification = this.safeEvidence(observed.evidence, observed.source);
      session.state = 'COMPLETED';
      session.authenticated = true;
      session.message = observed.message;
      this.publish(session);
      if (liveURLId) void session.cdp.send('Browserless.closeLiveURL', { liveURLId }).catch(() => {});
      this.outcomeListener?.(conversationId, 'confirmed', observed.message);
      return this.summary(session);
    }
    if (liveURLId) void session.cdp.send('Browserless.closeLiveURL', { liveURLId }).catch(() => {});
    const inspected = observed ? undefined : await inspectJdBrowserPages(session.browser, session.page).catch(() => undefined);
    const verdict = observed ?? (inspected?.verdict.status === 'confirmed'
      ? { ...inspected.verdict, source: 'current-page' as const }
      : await (this.deps.verify ?? verifyJdLogin)(session.page, Math.max(0, session.deadline - Date.now() - 1_000)));
    if (session.state !== 'VERIFYING') return this.summary(session);
    session.pageUrl = verdict.evidence
      ? safePageUrl(`https://${verdict.evidence.host}${verdict.evidence.path}`)
      : safePageUrl(inspected?.page.url() ?? session.page.url());
    if (verdict.evidence) session.verification = this.safeEvidence(verdict.evidence, verdict.source);
    if (verdict.status === 'confirmed') {
      session.state = 'COMPLETED';
      session.authenticated = true;
      session.message = verdict.message;
      this.publish(session);
      this.outcomeListener?.(conversationId, 'confirmed', verdict.message);
    } else if (verdict.status === 'not-confirmed') {
      await this.fail(session, `${verdict.message} 请准备好后在面板重新开始登录。`);
    } else {
      await this.unverify(session, `${verdict.message} 本次不能判定你没有登录。`);
    }
    return this.summary(session);
  }

  private async saveAndRestoreProfile(original: Session): Promise<RemoteBrowserSummary> {
    const name = original.profileCandidateName!;
    let restored: Session | undefined;
    try {
      const saved = await original.cdp.send('Browserless.saveProfile', { name }) as { ok?: boolean; error?: string };
      if (saved.ok !== true) throw new Error('Browserless 未能保存当前浏览器的认证状态');
      original.replacing = true;
      original.state = 'CLOSED';
      await this.release(original);
      if (this.sessions.get(original.conversationId) === original) this.sessions.delete(original.conversationId);

      restored = await this.connectAndNavigate(original.conversationId, this.endpoint(name).url, JD_MALL_URL, Date.now(), 'restored');
      const verdict = await (this.deps.verify ?? verifyJdLogin)(restored.page, Math.max(0, restored.deadline - Date.now() - 1_000));
      if (restored.state !== 'AI_RUNNING') return this.summary(restored);
      if (verdict.evidence) restored.verification = this.safeEvidence(verdict.evidence, verdict.source);
      if (verdict.status !== 'confirmed' && original.pendingTaskKeyword) {
        const search = await (this.deps.search ?? searchJdProducts)(restored.page, original.pendingTaskKeyword, 20);
        if (search.status === 'results' && search.products.length) {
          const task = await loadJdTask(restored.conversationId) ?? newJdTask(restored.conversationId, original.pendingTaskKeyword);
          task.products = search.products.map((item, index) => ({ ...item, rank: index + 1, reviews: [] }));
          task.sortApplied = search.sortApplied;
          task.status = 'collecting';
          task.note = search.note;
          await saveJdTask(task);
          await this.profileProvider!.remember(name, 'mall');
          restored.profileStatus = 'saved';
          restored.state = 'COMPLETED';
          restored.message = '人工验证后，新浏览器已能读取中国区商城商品；账号登录状态仍未单独确认。';
          this.publish(restored);
          this.outcomeListener?.(restored.conversationId, 'ready', restored.message);
          return this.summary(restored);
        }
      }
      if (verdict.status !== 'confirmed') {
        await this.unverify(restored, '认证档案已保存，但新浏览器未能确认京东登录或读取商品；请重新验证后再试。');
        return this.summary(restored);
      }
      await this.profileProvider!.remember(name, 'login');
      restored.profileStatus = 'saved';
      restored.state = 'COMPLETED';
      restored.authenticated = true;
      restored.message = '已关闭首次登录浏览器，并在加载认证档案的新浏览器中确认京东登录。';
      this.publish(restored);
      this.outcomeListener?.(restored.conversationId, 'confirmed', restored.message);
      return this.summary(restored);
    } catch {
      const current = restored ?? original;
      if (current === original) {
        original.replacing = true;
        await this.release(original);
        this.sessions.set(original.conversationId, original);
      }
      if (activeStates.has(current.state) || current.state === 'CLOSED') {
        current.state = 'UNVERIFIED';
        current.message = '保存或恢复京东认证档案失败；不能据此判断是否已登录。';
        this.publish(current);
        this.outcomeListener?.(current.conversationId, 'unverified', current.message);
        if (current !== original) await this.release(current);
      }
      return this.summary(current);
    }
  }

  private async sessionForCollection(conversationId: string, targetUrl = JD_MALL_URL): Promise<Session> {
    const existing = this.sessions.get(conversationId);
    if (existing?.state === 'HUMAN_CONTROL' || existing?.state === 'VERIFYING') throw new Error('正在等待人工操作或核验，Agent 不能同时操作浏览器。');
    if (existing && !activeStates.has(existing.state)) this.sessions.delete(conversationId);
    if (!this.sessions.has(conversationId)) await this.open(conversationId, targetUrl);
    const session = this.require(conversationId);
    if (session.state !== 'AI_RUNNING' && session.state !== 'COMPLETED') throw new Error('当前云浏览器尚未就绪。');
    session.state = 'AI_RUNNING';
    session.message = 'Agent 正在后台访问中国区京东商城；遇到人工关卡时才显示浏览器。';
    this.publish(session);
    return session;
  }

  async searchProducts(conversationId: string, keyword: string): Promise<{ task: JdTask; browser: RemoteBrowserSummary }> {
    const searchUrl = new URL('https://search.jd.com/Search');
    searchUrl.searchParams.set('keyword', keyword.trim().slice(0, 80));
    const session = await this.sessionForCollection(conversationId, searchUrl.toString());
    session.pendingTaskUrl = searchUrl.toString();
    session.pendingTaskKeyword = keyword;
    const task = newJdTask(conversationId, keyword);
    await saveJdTask(task);
    try {
      const result = await (this.deps.search ?? searchJdProducts)(session.page, keyword, 20);
      task.sortApplied = result.sortApplied;
      task.note = result.note;
      if (result.status === 'needs-human') {
        task.status = 'needs-human';
        await saveJdTask(task);
        session.message = `搜索“${task.keyword}”遇到京东人工验证；请在远程浏览器中完成后继续。`;
        this.publish(session);
        await this.handoff(conversationId);
      } else {
        task.products = result.products.map((item, index) => ({ ...item, rank: index + 1, reviews: [] }));
        task.status = task.products.length ? 'collecting' : 'partial';
        await saveJdTask(task);
        if (session.state === 'AI_RUNNING') {
          session.state = 'COMPLETED';
          session.message = task.products.length
            ? `已从商城页面读取 ${task.products.length} 个商品；${task.sortApplied ? '已选择销量排序。' : '销量排序未核实。'}`
            : result.note ?? '京东商品页面暂不可读取。';
          this.publish(session);
        }
      }
      return { task, browser: this.summary(session) };
    } catch (error) {
      task.status = 'partial';
      task.note = session.state === 'EXPIRED' ? '云浏览器会话到期；可在新会话中继续。' : '商城搜索过程未完成。';
      await saveJdTask(task);
      if (session.state === 'AI_RUNNING') {
        session.state = 'COMPLETED';
        session.message = task.note;
        this.publish(session);
      }
      if (session.state !== 'EXPIRED') throw error;
      return { task, browser: this.summary(session) };
    }
  }

  async collectReviews(conversationId: string, maxProducts = 3): Promise<{ task: JdTask; browser: RemoteBrowserSummary }> {
    const task = await loadJdTask(conversationId);
    if (!task || !task.products.length) throw new Error('请先完成商城商品搜索。');
    const session = await this.sessionForCollection(conversationId);
    const end = Math.min(task.products.length, task.nextReviewIndex + Math.max(1, Math.min(maxProducts, 5)));
    try {
      while (task.nextReviewIndex < end && session.state === 'AI_RUNNING') {
        if (session.deadline - Date.now() < 18_000) {
          task.status = 'partial';
          task.note = '本次浏览器剩余时间不足，已保存评论采集进度；下次可从断点继续。';
          break;
        }
        const product = task.products[task.nextReviewIndex];
        session.pendingTaskUrl = product.url;
        session.pendingTaskKeyword = task.keyword;
        const result = await (this.deps.reviews ?? collectJdReviews)(session.page, product);
        if (result.status === 'needs-human') {
          task.status = 'needs-human';
          task.note = result.note;
          await saveJdTask(task);
          session.message = `商品“${product.name.slice(0, 35)}”的评论页要求人工验证。`;
          this.publish(session);
          await this.handoff(conversationId);
          return { task, browser: this.summary(session) };
        }
        product.reviews = result.reviews;
        task.nextReviewIndex += 1;
        task.note = result.note;
        await saveJdTask(task);
      }
      if (task.nextReviewIndex >= task.products.length) task.status = 'complete';
      else if (task.status !== 'needs-human') task.status = 'partial';
      await saveJdTask(task);
      if (session.state === 'AI_RUNNING') {
        session.state = 'COMPLETED';
        session.message = `已检查 ${task.nextReviewIndex}/${task.products.length} 个商品的评论；${task.status === 'complete' ? '采集完成。' : '可继续下一批。'}`;
        this.publish(session);
      }
      return { task, browser: this.summary(session) };
    } catch (error) {
      task.status = 'partial';
      task.note = session.state === 'EXPIRED' ? '云浏览器到期，评论进度已保存。' : '评论采集过程未完成。';
      await saveJdTask(task);
      if (session.state !== 'EXPIRED') throw error;
      return { task, browser: this.summary(session) };
    }
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

  private async unverify(session: Session, message: string): Promise<void> {
    if (!activeStates.has(session.state)) return;
    session.state = 'UNVERIFIED';
    session.message = message;
    session.liveUrl = undefined;
    session.viewMode = 'none';
    this.publish(session);
    this.outcomeListener?.(session.conversationId, 'unverified', message);
    await this.release(session);
  }

  private async expire(session: Session, message: string): Promise<void> {
    if (!activeStates.has(session.state)) return;
    const wasVerifying = session.state === 'VERIFYING';
    const shouldReport = session.state === 'HUMAN_CONTROL' || wasVerifying;
    session.state = wasVerifying ? 'UNVERIFIED' : 'EXPIRED';
    session.message = wasVerifying ? '核验期间云浏览器连接断开，无法确认或否定登录。' : message;
    session.liveUrl = undefined;
    session.viewMode = 'none';
    this.publish(session);
    if (shouldReport) this.outcomeListener?.(session.conversationId, wasVerifying ? 'unverified' : 'failed', session.message);
    await this.release(session);
  }

  private async release(session: Session): Promise<void> {
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    if (session.liveTimer) clearTimeout(session.liveTimer);
    if (session.monitorTimer) clearInterval(session.monitorTimer);
    if (session.monitorNavigationListener && typeof session.page.off === 'function') session.page.off('domcontentloaded', session.monitorNavigationListener);
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
    const shouldReport = activeStates.has(session.state) && session.state !== 'COMPLETED';
    session.state = 'CLOSED';
    session.message = '云浏览器会话已关闭。';
    session.liveUrl = undefined;
    session.viewMode = 'none';
    this.publish(session);
    if (shouldReport) this.outcomeListener?.(session.conversationId, 'failed', '用户已关闭京东云浏览器会话。');
    await this.release(session);
    return this.summary(session);
  }
}

export const browserService = new BrowserService();
