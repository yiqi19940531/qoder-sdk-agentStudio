import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Browser, Page } from 'puppeteer-core';
import { BrowserService } from '../server/browser-service.js';
import { classifyJdLogin } from '../server/jd-login.js';

class FakeCdp extends EventEmitter {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  async send(method: string, params?: Record<string, unknown>) {
    this.calls.push({ method, params });
    if (method === 'Browserless.liveURL') return {
      error: null, liveURLId: 'viewer-id', timeout: 90_000,
      liveURL: `https://production-sfo.browserless.io/live/index.html?i=viewer-id&v=${this.calls.length}`,
    };
    if (method === 'Browserless.closeLiveURL') {
      this.emit('Browserless.liveComplete', { liveURLId: 'viewer-id', reason: 'closed' });
      return { error: null };
    }
    throw new Error(`Unexpected CDP method: ${method}`);
  }
}

class FakePage {
  constructor(private readonly cdp: FakeCdp) {}
  currentUrl = 'about:blank';
  async setViewport(size: { width: number; height: number }) { assert.deepEqual(size, { width: 1280, height: 800 }); }
  async goto(url: string) { this.currentUrl = url; }
  url() { return this.currentUrl; }
  async title() { return '京东-欢迎登录'; }
  browserContext() { return {}; }
  async createCDPSession() { return this.cdp; }
}

const cdp = new FakeCdp();
const page = new FakePage(cdp);
let closed = false;
let connectCount = 0;
const browserEvents = new EventEmitter();
const browser = Object.assign(browserEvents, {
  pages: async () => [page],
  close: async () => { closed = true; browserEvents.emit('disconnected'); },
}) as unknown as Browser;
const service = new BrowserService({
  env: {
    BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE',
    BROWSERLESS_WS_ENDPOINT: 'wss://production-sfo.browserless.io/chromium',
    BROWSERLESS_SESSION_TIMEOUT_MS: '120000',
  },
  connect: async (url) => {
    connectCount++;
    assert.match(url, /^wss:\/\/production-sfo\.browserless\.io\/chromium\?/);
    assert.ok(url.includes('token=TEST_BROWSERLESS_TOKEN_VALUE'));
    return browser;
  },
  verify: async (target: Page) => {
    assert.equal(target, page);
    page.currentUrl = 'https://home.jd.com/index.html?private=ignore';
    return { status: 'confirmed', message: '已通过京东账户页确认登录。' };
  },
});

const updates: string[] = [];
const outcomes: string[] = [];
service.onState((summary) => updates.push(JSON.stringify(summary)));
service.onOutcome((_conversationId, result) => outcomes.push(result));
const id = '11111111-1111-4111-8111-111111111111';
const opened = await service.open(id);
assert.equal(opened.state, 'AI_RUNNING');
assert.equal(connectCount, 1);
assert.equal(service.view(id).session?.viewMode, 'none');
assert.equal(service.view(id).liveUrl, undefined);
assert.ok(!updates.join('\n').includes('viewer-id'));
assert.ok(!updates.join('\n').includes('TEST_BROWSERLESS_TOKEN_VALUE'));

const handoff = await service.handoff(id);
assert.equal(handoff.state, 'HUMAN_CONTROL');
assert.equal(service.view(id).session?.viewMode, 'interactive');
assert.equal(cdp.calls.filter((call) => call.method === 'Browserless.liveURL').length, 1);
assert.deepEqual(await service.handoff(id), handoff);
await assert.rejects(service.close(id, 'agent'), /人工接管/);

const verified = await service.complete(id);
assert.equal(verified.state, 'COMPLETED');
assert.equal(verified.pageUrl, 'https://home.jd.com/index.html');
assert.equal(closed, false, 'Browserless session remains available after login');
assert.deepEqual(outcomes, ['confirmed']);
assert.equal(service.view(id).session?.viewMode, 'none');
await service.close(id);
assert.equal(closed, true);
assert.equal(service.view(id).session?.state, 'CLOSED');

assert.equal(classifyJdLogin('https://passport.jd.com/new/login.aspx', '请输入手机号').status, 'not-confirmed');
assert.equal(classifyJdLogin('https://home.jd.com/index.html', '我的订单 账户设置').status, 'confirmed');
assert.equal(classifyJdLogin('https://home.jd.com/index.html', '服务器出错').status, 'unknown');

const retryCdp = new FakeCdp();
const retryPage = new FakePage(retryCdp);
const retryBrowser = Object.assign(new EventEmitter(), {
  pages: async () => [retryPage], close: async () => {},
}) as unknown as Browser;
let attempts = 0;
let resolveConfirmed!: (result: string) => void;
const confirmedOutcome = new Promise<string>((resolve) => { resolveConfirmed = resolve; });
const retryOutcomes: string[] = [];
const retryService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' },
  connect: async () => retryBrowser,
  verify: async () => (++attempts === 1
    ? { status: 'not-confirmed', message: '仍在登录页。' }
    : { status: 'confirmed', message: '已确认登录。' }),
});
retryService.onOutcome((_id, result) => { retryOutcomes.push(result); if (result === 'confirmed') resolveConfirmed(result); });
const retryId = '22222222-2222-4222-8222-222222222222';
await retryService.open(retryId);
await retryService.handoff(retryId);
retryCdp.emit('Browserless.liveComplete', { liveURLId: 'viewer-id', reason: 'viewerDisconnected' });
assert.equal(retryService.getState(retryId).state, 'HUMAN_CONTROL');
assert.equal((await retryService.complete(retryId)).state, 'FAILED', 'User Done without account evidence must not be success');
await retryService.restartForHuman(retryId);
retryCdp.emit('Browserless.liveComplete', { liveURLId: 'viewer-id', reason: 'userDone' });
assert.equal(await confirmedOutcome, 'confirmed');
assert.deepEqual(retryOutcomes, ['failed', 'confirmed']);
assert.equal(retryService.getState(retryId).state, 'COMPLETED');
const previousRetrySessionId = retryService.getState(retryId).sessionId;
await retryService.close(retryId);
const restarted = await retryService.restartForHuman(retryId);
assert.equal(restarted.state, 'HUMAN_CONTROL');
assert.notEqual(restarted.sessionId, previousRetrySessionId);
await retryService.close(retryId);

const leakedToken = 'TEST_SECRET_BROWSERLESS_TOKEN';
const failingService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: leakedToken },
  connect: async (url) => { throw new Error(`Handshake failed at ${url}`); },
});
await assert.rejects(failingService.open('33333333-3333-4333-8333-333333333333'), (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.ok(!error.message.includes(leakedToken));
  assert.match(error.message, /\[REDACTED\]/);
  return true;
});
await assert.rejects(new BrowserService({ env: {} }).open('44444444-4444-4444-8444-444444444444'), /BROWSERLESS_API_TOKEN/);
console.log('BrowserService: same page, single-link handoff, verification, retry, session retention and secret-free events passed');
