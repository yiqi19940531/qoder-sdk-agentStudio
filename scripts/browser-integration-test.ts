import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { BrowserService } from '../server/browser-service.js';
import { classifyJdEvidence, inspectCurrentJdPage, inspectJdBrowserPages, verifyJdLogin, type LoginEvidence } from '../server/jd-login.js';
import { BrowserlessJdProfileProvider } from '../server/jd-profile.js';
import { loadJdTask, searchJdProducts } from '../server/jd-shop.js';

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
    if (method === 'Browserless.saveProfile') return { ok: true, profileId: 'test-profile' };
    throw new Error(`Unexpected CDP method: ${method}`);
  }
}

class FakePage {
  constructor(private readonly cdp: FakeCdp) {}
  currentUrl = 'about:blank';
  cdpSessions = 0;
  async setViewport(size: { width: number; height: number }) { assert.deepEqual(size, { width: 1280, height: 800 }); }
  async setExtraHTTPHeaders(headers: Record<string, string>) { assert.match(headers['Accept-Language'], /zh-CN/); }
  async emulateTimezone(zone: string) { assert.equal(zone, 'Asia/Shanghai'); }
  async goto(url: string) { this.currentUrl = url; }
  url() { return this.currentUrl; }
  async title() { return '京东-欢迎登录'; }
  browserContext() { return {}; }
  async createCDPSession() { this.cdpSessions++; return this.cdp; }
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
    assert.equal(new URL(url).searchParams.get('token'), 'TEST_BROWSERLESS_TOKEN_VALUE');
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
assert.equal(page.cdpSessions, 2, 'The live view must use a fresh CDP session after JD navigation');
assert.equal(cdp.calls.find((call) => call.method === 'Browserless.liveURL')?.params?.showBrowserInterface, false);
assert.equal(Object.hasOwn(cdp.calls.find((call) => call.method === 'Browserless.liveURL')?.params ?? {}, 'instructions'), false, 'Browserless instructions must not cover the login page');
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

const evidence = (change: Partial<LoginEvidence>): LoginEvidence => ({
  host: 'passport.jd.com', path: '/new/login.aspx', authCookiePair: false,
  loginFormVisible: true, loginPromptVisible: true, signedInControlVisible: false,
  accountAreaVisible: false, successTextVisible: false, ...change,
});
assert.equal(classifyJdEvidence(evidence({})).status, 'not-confirmed');
assert.equal(classifyJdEvidence(evidence({ host: 'home.jd.com', path: '/', authCookiePair: true, loginFormVisible: false, loginPromptVisible: false, accountAreaVisible: true })).status, 'confirmed');
assert.equal(classifyJdEvidence(evidence({ host: 'www.jd.com', authCookiePair: true, loginFormVisible: false, loginPromptVisible: false, signedInControlVisible: true })).status, 'confirmed');
assert.equal(classifyJdEvidence(evidence({ host: 'www.jd.com', authCookiePair: true, loginFormVisible: false, loginPromptVisible: false, signedInControlVisible: false })).status, 'confirmed');
assert.equal(classifyJdEvidence(evidence({ host: 'home.jd.com', loginFormVisible: false, loginPromptVisible: false, accountAreaVisible: false })).status, 'unknown');
assert.equal(classifyJdEvidence(evidence({ host: 'corporate.jd.com', authCookiePair: true, loginFormVisible: false, signedInControlVisible: true })).status, 'unknown', 'Corporate site is not China mall login proof');

let accountNavigations = 0;
const signedInPage = {
  url: () => 'https://www.jd.com/',
  evaluate: async () => ({
    loginFormVisible: false, loginPromptVisible: false, signedInControlVisible: true,
    accountAreaVisible: true, successTextVisible: false,
  }),
  browserContext: () => ({ cookies: async () => [
    { name: 'pt_key', domain: '.jd.com' }, { name: 'pt_pin', domain: '.jd.com' },
  ] }),
  goto: async () => { accountNavigations++; },
} as unknown as Page;
const observedVerdict = await verifyJdLogin(signedInPage, 5_000);
assert.equal(observedVerdict.status, 'confirmed');
assert.equal(observedVerdict.source, 'current-page');
assert.equal(accountNavigations, 0, 'Current signed-in page must be checked before navigation');

const mainlandLoggedInPage = {
  url: () => 'https://www.jd.com/',
  evaluate: async () => ({ loginFormVisible: false, loginPromptVisible: false, signedInControlVisible: false,
    accountAreaVisible: false, successTextVisible: false }),
  browserContext: () => ({ cookies: async () => [
    { name: 'thor', domain: '.jd.com' }, { name: 'pin', domain: '.jd.com' },
  ] }),
} as unknown as Page;
assert.equal((await inspectCurrentJdPage(mainlandLoggedInPage)).verdict.status, 'confirmed', 'JD mainland thor/pin signature should confirm login on the mall homepage');

let delayedSearchUrl = 'https://www.jd.com/';
const delayedChallengePage = {
  url: () => delayedSearchUrl,
  goto: async (url: string) => { delayedSearchUrl = url; },
  waitForSelector: async () => { delayedSearchUrl = 'https://cfe.m.jd.com/privatedomain/risk_handler/03101900/'; },
  evaluate: async () => { throw new Error('Delayed challenge must be detected before extracting search cards'); },
} as unknown as Page;
const delayedChallenge = await searchJdProducts(delayedChallengePage, '洗发水');
assert.equal(delayedChallenge.status, 'needs-human', 'An asynchronous JD risk redirect must trigger human handoff');
assert.equal(delayedChallenge.pageHost, 'cfe.m.jd.com');

const corporatePage = {
  url: () => 'https://corporate.jd.com/home',
  evaluate: async () => ({ loginFormVisible: false, loginPromptVisible: false, signedInControlVisible: false, accountAreaVisible: false, successTextVisible: false }),
  browserContext: () => ({ cookies: async () => [] }),
} as unknown as Page;
const multiplePages = { pages: async () => [corporatePage, signedInPage] } as unknown as Browser;
const selected = await inspectJdBrowserPages(multiplePages, corporatePage);
assert.equal(selected.page, signedInPage, 'An authenticated second tab must be checked');
assert.equal(selected.verdict.status, 'confirmed');

const ambiguousPage = {
  url: () => 'https://passport.jd.com/new/login.aspx',
  evaluate: async () => ({
    loginFormVisible: false, loginPromptVisible: false, signedInControlVisible: false,
    accountAreaVisible: false, successTextVisible: false,
  }),
  browserContext: () => ({ cookies: async () => { throw new Error('CDP cookie read unavailable'); } }),
  goto: async () => { accountNavigations++; },
} as unknown as Page;
const nearDeadline = await verifyJdLogin(ambiguousPage, 5_000);
assert.equal(nearDeadline.status, 'unknown');
assert.equal(accountNavigations, 0, 'Near-expiry verification must not navigate away');

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

const unknownCdp = new FakeCdp();
const unknownPage = new FakePage(unknownCdp);
const unknownBrowser = Object.assign(new EventEmitter(), { pages: async () => [unknownPage], close: async () => {} }) as unknown as Browser;
const unknownService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' }, connect: async () => unknownBrowser,
  verify: async () => ({ status: 'unknown', message: '核验时间不足，不能判断。' }),
});
const unknownOutcomes: string[] = [];
unknownService.onOutcome((_id, result) => unknownOutcomes.push(result));
const unknownId = '55555555-5555-4555-8555-555555555555';
await unknownService.open(unknownId);
await unknownService.handoff(unknownId);
assert.equal((await unknownService.complete(unknownId)).state, 'UNVERIFIED');
assert.deepEqual(unknownOutcomes, ['unverified']);
assert.match(unknownService.getState(unknownId).message ?? '', /不能判定你没有登录/);

class MonitoredPage extends FakePage {
  signedIn = false;
  async evaluate() {
    return {
      loginFormVisible: !this.signedIn, loginPromptVisible: !this.signedIn,
      signedInControlVisible: this.signedIn, accountAreaVisible: this.signedIn,
      successTextVisible: false,
    };
  }
  override browserContext() {
    return { cookies: async () => this.signedIn
      ? [{ name: 'pt_key', domain: '.jd.com' }, { name: 'pt_pin', domain: '.jd.com' }]
      : [] };
  }
}
const monitoredCdp = new FakeCdp();
const monitoredPage = new MonitoredPage(monitoredCdp);
const monitoredBrowser = Object.assign(new EventEmitter(), { pages: async () => [monitoredPage], close: async () => {} }) as unknown as Browser;
const monitoredService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' }, connect: async () => monitoredBrowser,
  verify: async () => { throw new Error('Current-page evidence should bypass navigation probe'); },
});
let resolveMonitor!: (result: string) => void;
const monitoredOutcome = new Promise<string>((resolve) => { resolveMonitor = resolve; });
monitoredService.onOutcome((_id, result) => resolveMonitor(result));
const monitoredId = '66666666-6666-4666-8666-666666666666';
await monitoredService.open(monitoredId);
await monitoredService.handoff(monitoredId);
monitoredPage.signedIn = true;
monitoredPage.currentUrl = 'https://www.jd.com/';
assert.equal(await Promise.race([monitoredOutcome, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Login monitor did not confirm in time')), 4_000))]), 'confirmed');
assert.equal(monitoredService.getState(monitoredId).state, 'COMPLETED');
assert.equal(monitoredPage.url(), 'https://www.jd.com/', 'Monitor confirmation keeps the same current page');
await monitoredService.close(monitoredId);

const disconnectCdp = new FakeCdp();
const disconnectPage = new FakePage(disconnectCdp);
const disconnectEvents = new EventEmitter();
const disconnectBrowser = Object.assign(disconnectEvents, { pages: async () => [disconnectPage], close: async () => {} }) as unknown as Browser;
let finishSlowCheck!: (verdict: { status: 'not-confirmed'; message: string }) => void;
const slowCheck = new Promise<{ status: 'not-confirmed'; message: string }>((resolve) => { finishSlowCheck = resolve; });
const disconnectService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' }, connect: async () => disconnectBrowser,
  verify: async () => slowCheck,
});
const disconnectOutcomes: string[] = [];
disconnectService.onOutcome((_id, result) => disconnectOutcomes.push(result));
const disconnectId = '77777777-7777-4777-8777-777777777777';
await disconnectService.open(disconnectId);
await disconnectService.handoff(disconnectId);
const interruptedCheck = disconnectService.complete(disconnectId);
disconnectEvents.emit('disconnected');
finishSlowCheck({ status: 'not-confirmed', message: 'Late result must not overwrite disconnect status' });
assert.equal((await interruptedCheck).state, 'UNVERIFIED');
assert.deepEqual(disconnectOutcomes, ['unverified']);
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
class SlowLoginPage extends FakePage {
  override async goto(url: string) {
    this.currentUrl = url;
    throw new Error('Navigation timeout of 12000 ms exceeded');
  }
}
const slowCdp = new FakeCdp();
const slowPage = new SlowLoginPage(slowCdp);
const slowBrowser = Object.assign(new EventEmitter(), { pages: async () => [slowPage], close: async () => {} }) as unknown as Browser;
const slowService = new BrowserService({ env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' }, connect: async () => slowBrowser });
const slowId = '88888888-8888-4888-8888-888888888888';
assert.equal((await slowService.open(slowId)).state, 'AI_RUNNING', 'A slow JD load should still expose a navigated page');
await slowService.close(slowId);

let storedProfile: { name: string; savedAt: string } | null = null;
const profileBrowsers = [new FakeCdp(), new FakeCdp(), new FakeCdp()].map((profileCdp) => {
  const profilePage = new FakePage(profileCdp);
  return { profileCdp, profilePage, browser: Object.assign(new EventEmitter(), {
    pages: async () => [profilePage], close: async () => {},
  }) as unknown as Browser };
});
let profileConnections = 0;
const profileService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' },
  profileProvider: {
    load: async () => storedProfile,
    create: async () => {
      const connect = new URL('wss://production-sfo.browserless.io/session/connect/test');
      connect.searchParams.set('token', 'TEST_BROWSERLESS_TOKEN_VALUE');
      return { name: 'qoder-jd-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', connect: connect.toString() };
    },
    remember: async (name) => { storedProfile = { name, savedAt: new Date().toISOString() }; },
  },
  connect: async (url) => {
    const next = profileBrowsers[profileConnections++];
    assert.ok(next);
    if (profileConnections > 1) assert.match(url, /profile=qoder-jd-/);
    return next.browser;
  },
  verify: async (target) => {
    assert.notEqual(target, profileBrowsers[0].profilePage, 'Login is proved in a new browser');
    return { status: 'confirmed', message: '已在新浏览器确认登录。' };
  },
});
const profileId = '99999999-9999-4999-8999-999999999999';
assert.equal((await profileService.open(profileId)).state, 'AI_RUNNING');
await profileService.handoff(profileId);
assert.equal((await profileService.complete(profileId)).state, 'COMPLETED');
assert.equal(profileService.getState(profileId).profileStatus, 'saved');
assert.equal(profileConnections, 2, 'Profile save must close the login browser and launch a new one');
assert.equal((storedProfile as { name: string } | null)?.name, 'qoder-jd-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
await profileService.close(profileId);
assert.equal((await profileService.restartForHuman(profileId)).state, 'COMPLETED', 'A later session should restore the saved profile without human login');
assert.equal(profileConnections, 3);
await profileService.close(profileId);

const challengeCdp = new FakeCdp();
const challengePage = new FakePage(challengeCdp);
const challengeBrowser = Object.assign(new EventEmitter(), { pages: async () => [challengePage], close: async () => {} }) as unknown as Browser;
const challengeService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' }, connect: async () => challengeBrowser,
  search: async () => ({ status: 'needs-human', pageHost: 'cfe.m.jd.com', sortApplied: false, products: [], note: '需要人工验证。' }),
});
const challengeId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const challenged = await challengeService.searchProducts(challengeId, '洗发水');
assert.equal(challenged.task.status, 'needs-human');
assert.equal(challenged.browser.state, 'HUMAN_CONTROL');
assert.equal(new URL(challengePage.url()).hostname, 'passport.jd.com', 'Human handoff should open JD login directly');
assert.ok(challengeService.view(challengeId).liveUrl, 'Only a challenge should mint an interactive Live URL');
await challengeService.close(challengeId);
const restartedChallenge = await challengeService.restartForHuman(challengeId);
assert.equal(restartedChallenge.state, 'HUMAN_CONTROL', 'A saved needs-human task should reopen the interactive JD login page');
assert.equal(new URL(challengePage.url()).hostname, 'passport.jd.com');
assert.match(restartedChallenge.message ?? '', /同一可交互云浏览器/);
await challengeService.close(challengeId);
await rm(path.join(process.cwd(), 'data/jd-tasks', `${challengeId}.json`), { force: true });

const firstFreshPage = new FakePage(new FakeCdp());
const secondFreshPage = new FakePage(new FakeCdp());
const freshBrowser = (target: FakePage) => Object.assign(new EventEmitter(), {
  pages: async () => [target], close: async () => {}, disconnect: async () => {},
}) as unknown as Browser;
let freshConnections = 0;
const freshHandoffService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE', BROWSERLESS_SESSION_TIMEOUT_MS: '30000' },
  profileProvider: {
    load: async () => null,
    create: async () => ({ name: 'qoder-jd-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', connect: 'wss://production-sfo.browserless.io/session/connect/fresh' }),
    remember: async () => {},
  },
  connect: async () => ++freshConnections === 1 ? freshBrowser(firstFreshPage) : freshBrowser(secondFreshPage),
  search: async () => (firstFreshPage.currentUrl = 'https://cfe.m.jd.com/privatedomain/risk_handler/03101900/',
    { status: 'needs-human', pageHost: 'cfe.m.jd.com', sortApplied: false, products: [] }),
});
const freshId = '12121212-1212-4121-8121-121212121212';
const freshResult = await freshHandoffService.searchProducts(freshId, '洗发水');
assert.equal(freshConnections, 2, 'A near-expiry Free-plan search must open a fresh browser for the person');
assert.equal(freshResult.browser.state, 'HUMAN_CONTROL');
assert.equal(new URL(secondFreshPage.url()).hostname, 'passport.jd.com');
assert.equal(freshResult.task.status, 'needs-human');
await freshHandoffService.close(freshId);
await rm(path.join(process.cwd(), 'data/jd-tasks', `${freshId}.json`), { force: true });

const signedChallengeCdp = new FakeCdp();
const signedChallengePage = new FakePage(signedChallengeCdp);
const signedChallengeBrowser = Object.assign(new EventEmitter(), { pages: async () => [signedChallengePage], close: async () => {} }) as unknown as Browser;
let signedSearches = 0;
const signedChallengeService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' }, connect: async () => signedChallengeBrowser,
  profileProvider: {
    load: async () => ({ name: 'qoder-jd-eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee', savedAt: new Date().toISOString(), mode: 'login' }),
    create: async () => { throw new Error('A verified profile must not create a fresh login session'); },
    remember: async () => {},
  },
  verify: async () => ({ status: 'confirmed', message: '已登录。' }),
  search: async () => ++signedSearches === 1
    ? (signedChallengePage.currentUrl = 'https://cfe.m.jd.com/privatedomain/risk_handler/03101900/',
      { status: 'needs-human', pageHost: 'cfe.m.jd.com', sortApplied: false, products: [] })
    : (signedChallengePage.currentUrl = 'https://search.jd.com/Search?keyword=%E6%B4%97%E5%8F%91%E6%B0%B4',
      { status: 'results', pageHost: 'search.jd.com', sortApplied: true, products: [
        { sku: '30001', name: '验证后可见商品', url: 'https://item.jd.com/30001.html' },
      ] }),
});
const signedChallengeId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const signedChallenge = await signedChallengeService.searchProducts(signedChallengeId, '洗发水');
assert.equal(signedChallenge.browser.state, 'HUMAN_CONTROL');
assert.equal(signedChallenge.browser.loginVerified, true);
assert.equal(new URL(signedChallengePage.url()).hostname, 'cfe.m.jd.com', 'Authenticated risk checks must not reopen the login page');
assert.equal((await signedChallengeService.complete(signedChallengeId)).state, 'COMPLETED');
assert.equal((await loadJdTask(signedChallengeId))?.products.length, 1, 'Human completion should resume the pending product task');
await signedChallengeService.close(signedChallengeId);
assert.equal(signedChallengeService.getState(signedChallengeId).loginVerified, false, 'Closed sessions cannot claim current login');
assert.equal(signedChallengeService.getState(signedChallengeId).priorLoginVerified, true, 'A prior confirmed login remains distinguishable');
await rm(path.join(process.cwd(), 'data/jd-tasks', `${signedChallengeId}.json`), { force: true });

const reauthCdp = new FakeCdp();
const reauthPage = new FakePage(reauthCdp);
const reauthBrowser = Object.assign(new EventEmitter(), { pages: async () => [reauthPage], close: async () => {} }) as unknown as Browser;
const reauthService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' }, connect: async () => reauthBrowser,
  profileProvider: {
    load: async () => ({ name: 'qoder-jd-eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee', savedAt: new Date().toISOString(), mode: 'login' }),
    create: async () => { throw new Error('Saved profile must be reused'); }, remember: async () => {},
  },
  verify: async () => ({ status: 'confirmed', message: '曾在商城首页确认登录。' }),
  search: async () => (reauthPage.currentUrl = 'https://passport.jd.com/new/login.aspx',
    { status: 'needs-human', pageHost: 'passport.jd.com', sortApplied: false, products: [] }),
});
const reauthId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const reauth = await reauthService.searchProducts(reauthId, '洗发水');
assert.equal(reauth.browser.state, 'HUMAN_CONTROL');
assert.equal(reauth.browser.loginVerified, false, 'A JD re-login page supersedes earlier account evidence');
assert.equal(reauth.browser.priorLoginVerified, true);
assert.match(reauth.task.note ?? '', /再次要求登录/);
await reauthService.close(reauthId);
await rm(path.join(process.cwd(), 'data/jd-tasks', `${reauthId}.json`), { force: true });

const researchCdp = new FakeCdp();
const researchPage = new FakePage(researchCdp);
const researchBrowser = Object.assign(new EventEmitter(), { pages: async () => [researchPage], close: async () => {} }) as unknown as Browser;
const researchService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' }, connect: async () => researchBrowser,
  search: async () => ({ status: 'results', pageHost: 'search.jd.com', sortApplied: true, products: [
    { sku: '10001', name: '洗发水 A', price: '29.90', promotion: '满减', url: 'https://item.jd.com/10001.html' },
    { sku: '10002', name: '洗发水 B', price: '39.90', url: 'https://item.jd.com/10002.html' },
  ] }),
  reviews: async () => ({ status: 'results', pageHost: 'item.jd.com', reviews: [{ text: '真实页面中可见的好评', helpful: 3 }] }),
});
const researchId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const researched = await researchService.searchProducts(researchId, '洗发水');
assert.equal(researched.task.products.length, 2);
assert.equal(researched.task.sortApplied, true);
assert.equal(researchService.view(researchId).liveUrl, undefined, 'No human challenge means the browser stays hidden');
const reviewed = await researchService.collectReviews(researchId, 1);
assert.equal(reviewed.task.nextReviewIndex, 1);
assert.equal((await loadJdTask(researchId))?.products[0].reviews[0].text, '真实页面中可见的好评');
await researchService.close(researchId);
await rm(path.join(process.cwd(), 'data/jd-tasks', `${researchId}.json`), { force: true });

class ReturningPage extends FakePage {
  async evaluate() {
    const login = this.currentUrl.includes('passport.jd.com');
    return { loginFormVisible: login, loginPromptVisible: login, signedInControlVisible: false,
      accountAreaVisible: false, successTextVisible: false };
  }
  override browserContext() { return { cookies: async () => [] }; }
}
const returnCdp = new FakeCdp();
const returnPage = new ReturningPage(returnCdp);
const restoreCdp = new FakeCdp();
const restorePage = new ReturningPage(restoreCdp);
const makeBrowser = (target: FakePage) => Object.assign(new EventEmitter(), { pages: async () => [target], close: async () => {} }) as unknown as Browser;
let returnConnections = 0;
let returnSearches = 0;
let savedMode = '';
const returnService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' },
  profileProvider: {
    load: async () => null,
    create: async () => ({ name: 'qoder-jd-cccccccc-cccc-4ccc-cccc-cccccccccccc', connect: 'wss://production-sfo.browserless.io/session/connect/test' }),
    remember: async (_name, mode) => { savedMode = mode ?? ''; },
  },
  connect: async () => ++returnConnections === 1 ? makeBrowser(returnPage) : makeBrowser(restorePage),
  verify: async () => ({ status: 'unknown', message: '账号状态未单独确认。' }),
  search: async () => ++returnSearches === 1
    ? { status: 'needs-human', pageHost: 'passport.jd.com', sortApplied: false, products: [] }
    : { status: 'results', pageHost: 'search.jd.com', sortApplied: true, products: [
      { sku: '20001', name: '验证后可见的洗发水', url: 'https://item.jd.com/20001.html' },
    ] },
});
let finishReturn!: (outcome: string) => void;
const returnOutcome = new Promise<string>((resolve) => { finishReturn = resolve; });
returnService.onOutcome((_id, result) => finishReturn(result));
const returnId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
await returnService.searchProducts(returnId, '洗发水');
assert.equal(returnService.getState(returnId).state, 'HUMAN_CONTROL');
returnPage.currentUrl = 'https://search.jd.com/Search?keyword=%E6%B4%97%E5%8F%91%E6%B0%B4';
assert.equal(await Promise.race([returnOutcome, new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Return redirect did not auto-save')), 5_000))]), 'ready');
assert.equal(returnService.getState(returnId).state, 'COMPLETED');
assert.equal(returnService.getState(returnId).loginVerified, false);
assert.equal(savedMode, 'mall');
assert.equal((await loadJdTask(returnId))?.products.length, 1);
await returnService.close(returnId);
await rm(path.join(process.cwd(), 'data/jd-tasks', `${returnId}.json`), { force: true });

const renewCdp = new FakeCdp();
const renewPage = new FakePage(renewCdp);
const renewBrowser = () => Object.assign(new EventEmitter(), {
  pages: async () => [renewPage],
  disconnect: async function (this: EventEmitter) { this.emit('disconnected'); },
  close: async () => {},
}) as unknown as Browser;
let renewConnections = 0;
const renewService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE', BROWSERLESS_SESSION_TIMEOUT_MS: '150000' },
  profileProvider: {
    load: async () => null,
    create: async () => ({ name: 'qoder-jd-dddddddd-dddd-4ddd-dddd-dddddddddddd', connect: 'wss://production-sfo.browserless.io/session/connect/renew' }),
    remember: async () => {},
  },
  connect: async () => { renewConnections++; return renewBrowser(); },
});
const renewId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
await renewService.open(renewId);
await renewService.handoff(renewId);
const originalRenewUrl = renewService.view(renewId).liveUrl;
const renewInternals = renewService as unknown as { sessions: Map<string, unknown>; renewConnection: (session: unknown) => Promise<void> };
await renewInternals.renewConnection(renewInternals.sessions.get(renewId));
assert.equal(renewConnections, 2, 'A paid-plan session can reconnect when explicitly needed');
assert.equal(renewService.getState(renewId).state, 'HUMAN_CONTROL');
assert.notEqual(renewService.view(renewId).liveUrl, originalRenewUrl, 'A renewed connection must mint a fresh Live URL');
assert.equal(renewPage.url(), 'https://www.jd.com/', 'The same page remains after reconnection');
await renewService.close(renewId);

const firstBlankCdp = new FakeCdp();
const secondBlankCdp = new FakeCdp();
const firstBlankPage = new FakePage(firstBlankCdp);
const secondBlankPage = new FakePage(secondBlankCdp);
const blankBrowser = (target: FakePage) => Object.assign(new EventEmitter(), {
  pages: async () => [target],
  disconnect: async function (this: EventEmitter) { this.emit('disconnected'); },
  close: async () => {},
}) as unknown as Browser;
let blankConnections = 0;
const blankRenewService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE', BROWSERLESS_SESSION_TIMEOUT_MS: '150000' },
  profileProvider: {
    load: async () => null,
    create: async () => ({ name: 'qoder-jd-dddddddd-dddd-4ddd-dddd-dddddddddddd', connect: 'wss://production-sfo.browserless.io/session/connect/blank' }),
    remember: async () => {},
  },
  connect: async () => ++blankConnections === 1 ? blankBrowser(firstBlankPage) : blankBrowser(secondBlankPage),
});
const blankId = 'abababab-abab-4bab-8bab-abababababab';
await blankRenewService.open(blankId);
await blankRenewService.handoff(blankId);
const blankInternals = blankRenewService as unknown as { sessions: Map<string, unknown>; renewConnection: (session: unknown) => Promise<void> };
await blankInternals.renewConnection(blankInternals.sessions.get(blankId));
assert.equal(blankConnections, 2);
assert.equal(blankRenewService.getState(blankId).state, 'HUMAN_CONTROL', blankRenewService.getState(blankId).message);
assert.equal(secondBlankPage.url(), 'https://www.jd.com/', 'A blank reconnected tab must reopen the prior JD page');
assert.match(blankRenewService.getState(blankId).message ?? '', /重新打开京东官方页面/);
await blankRenewService.close(blankId);

const freeCdp = new FakeCdp();
const freePage = new FakePage(freeCdp);
const freeBrowser = Object.assign(new EventEmitter(), { pages: async () => [freePage], disconnect: async () => {}, close: async () => {} }) as unknown as Browser;
let freeConnections = 0;
const freeService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE', BROWSERLESS_SESSION_TIMEOUT_MS: '120000' },
  profileProvider: {
    load: async () => null,
    create: async () => ({ name: 'qoder-jd-dddddddd-dddd-4ddd-dddd-dddddddddddd', connect: 'wss://production-sfo.browserless.io/session/connect/free' }),
    remember: async () => {},
  },
  connect: async () => { freeConnections++; return freeBrowser; },
});
const freeId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
await freeService.open(freeId);
await freeService.handoff(freeId);
assert.equal(freeConnections, 1, 'Free-plan handoff must not reconnect before exposing the viewer');
assert.equal((freeService as unknown as { sessions: Map<string, { renewalTimer?: ReturnType<typeof setTimeout> }> }).sessions.get(freeId)?.renewalTimer, undefined,
  'Free-plan human input must not be interrupted by automatic renewal');
await freeService.close(freeId);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response("You've reached the units usage limit allowed under our free plan", { status: 401 });
  const quotaProvider = new BrowserlessJdProfileProvider({ BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' });
  await assert.rejects(quotaProvider.create(120_000), /免费套餐用量已达上限/);
} finally { globalThis.fetch = originalFetch; }
let attemptedFreshProfile = false;
const quotaService = new BrowserService({
  env: { BROWSERLESS_API_TOKEN: 'TEST_BROWSERLESS_TOKEN_VALUE' }, connect: async () => { throw new Error('Should not connect'); },
  profileProvider: {
    load: async () => ({ name: 'qoder-jd-eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee', savedAt: new Date().toISOString(), mode: 'login' }),
    reopen: async () => { throw new Error('Browserless 免费套餐用量已达上限'); },
    create: async () => { attemptedFreshProfile = true; throw new Error('Should not create'); },
    remember: async () => {},
  },
});
await assert.rejects(quotaService.open('ffffffff-ffff-4fff-8fff-ffffffffffff'), /免费套餐用量已达上限/);
assert.equal(attemptedFreshProfile, false, 'Quota errors must not trigger a blank browser fallback');
await assert.rejects(new BrowserService({ env: {} }).open('44444444-4444-4444-8444-444444444444'), /BROWSERLESS_API_TOKEN/);
console.log('BrowserService: hidden search, challenge handoff, persistent browser renewal, profile restore, review checkpoints and secret-free events passed');
