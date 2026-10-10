import type { Browser, Page } from 'puppeteer-core';

export const JD_LOGIN_URL = 'https://passport.jd.com/new/login.aspx';
export const JD_ACCOUNT_URL = 'https://home.jd.com/';
export const JD_MALL_URL = 'https://www.jd.com/';

export type LoginEvidence = {
  host: string;
  path: string;
  authCookiePair: boolean | null;
  loginFormVisible: boolean;
  loginPromptVisible: boolean;
  signedInControlVisible: boolean;
  accountAreaVisible: boolean;
  successTextVisible: boolean;
};
export type LoginVerdict = { status: 'confirmed' | 'not-confirmed' | 'unknown'; message: string; source?: 'current-page' | 'account-probe'; evidence?: LoginEvidence };

function jdHost(host: string): boolean { return host === 'jd.com' || host.endsWith('.jd.com'); }

export function classifyJdEvidence(evidence: LoginEvidence): LoginVerdict {
  if (!jdHost(evidence.host)) return { status: 'unknown', message: '当前不是京东页面，无法确认登录。' };
  if (evidence.host === 'corporate.jd.com' || evidence.host === 'global.jd.com') return { status: 'unknown', message: '当前是京东集团或国际站，不是中国区商城登录结果。' };
  const loginPage = evidence.host === 'passport.jd.com';
  const noLoginPrompt = !evidence.loginFormVisible && !evidence.loginPromptVisible;
  if (evidence.authCookiePair === true && noLoginPrompt && (evidence.host === 'home.jd.com' || evidence.host === 'www.jd.com' || evidence.signedInControlVisible || evidence.accountAreaVisible)) {
    return { status: 'confirmed', message: '已通过当前京东页面与登录凭据同时确认登录。' };
  }
  if (evidence.signedInControlVisible && noLoginPrompt && !loginPage) {
    return { status: 'confirmed', message: '已通过当前京东页面的登录后账户控件确认登录。' };
  }
  if (loginPage && evidence.successTextVisible && evidence.authCookiePair === true) {
    return { status: 'confirmed', message: '京东登录页显示完成状态，且浏览器已获得登录凭据。' };
  }
  if (loginPage && evidence.loginFormVisible && evidence.authCookiePair === false) {
    return { status: 'not-confirmed', message: '京东登录表单仍可见，浏览器尚无登录凭据。' };
  }
  if (evidence.loginPromptVisible && evidence.authCookiePair === false) {
    return { status: 'not-confirmed', message: '页面仍提示登录，浏览器尚无登录凭据。' };
  }
  return { status: 'unknown', message: '当前页面有部分登录迹象，但证据不足，无法确认或否定登录。' };
}

/** Return only booleans and the URL host/path, never DOM text, phone, OTP or cookie values. */
export async function inspectCurrentJdPage(page: Page): Promise<{ evidence: LoginEvidence; verdict: LoginVerdict }> {
  let location: URL;
  try { location = new URL(page.url()); }
  catch { location = new URL('about:blank'); }
  const dom = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const text = document.body?.innerText ?? '';
    const inputs = [...document.querySelectorAll('input')].filter(visible);
    const loginFormVisible = inputs.some((input) => {
      const item = input as HTMLInputElement;
      const hint = `${item.placeholder} ${item.name}`;
      return item.type === 'password' || /手机号|验证码|mobile|phone|verify/i.test(hint);
    });
    const signedInControlVisible = /退出登录|注销登录/.test(text) ||
      [...document.querySelectorAll('#ttbar-login .nickname, .user-info .nickname, .user-name')].some(visible);
    return {
      loginFormVisible,
      loginPromptVisible: /你好，请登录|请先登录|登录并领取/.test(text) || (loginFormVisible && /短信登录|密码登录/.test(text)),
      signedInControlVisible,
      accountAreaVisible: /账户设置|个人中心|我的订单|我的京东/.test(text),
      successTextVisible: /登录成功|欢迎回来/.test(text),
    };
  }).catch(() => ({
    loginFormVisible: false, loginPromptVisible: false, signedInControlVisible: false,
    accountAreaVisible: false, successTextVisible: false,
  }));
  let authCookiePair: boolean | null = null;
  try {
    const names = new Set((await page.browserContext().cookies())
      .filter((cookie) => cookie.domain === 'jd.com' || cookie.domain.endsWith('.jd.com'))
      .map((cookie) => cookie.name));
    authCookiePair = (names.has('pt_key') && names.has('pt_pin')) || (names.has('thor') && names.has('pin'));
  } catch { /* Unknown is different from logged out. */ }
  const evidence: LoginEvidence = {
    host: location.host, path: location.pathname, authCookiePair, ...dom,
  };
  return { evidence, verdict: { ...classifyJdEvidence(evidence), evidence } };
}

/** Live View can open or switch tabs. Inspect every JD tab in the same browser before deciding. */
export async function inspectJdBrowserPages(browser: Browser, originalPage: Page): Promise<{ page: Page; evidence: LoginEvidence; verdict: LoginVerdict }> {
  const pages = [originalPage, ...(await browser.pages()).filter((page) => page !== originalPage)];
  let selected: { page: Page; evidence: LoginEvidence; verdict: LoginVerdict } | undefined;
  for (const page of pages) {
    let result: Awaited<ReturnType<typeof inspectCurrentJdPage>>;
    try { result = await inspectCurrentJdPage(page); }
    catch { continue; }
    if (result.verdict.status === 'confirmed') return { page, ...result };
    if (!selected || (selected.verdict.status === 'not-confirmed' && result.verdict.status === 'unknown')) selected = { page, ...result };
  }
  if (!selected) throw new Error('没有可读取的京东浏览器页面。');
  return selected;
}

export async function verifyJdLogin(page: Page, remainingMs = 20_000): Promise<LoginVerdict> {
  const deadline = Date.now() + Math.max(0, remainingMs);
  let current = await inspectCurrentJdPage(page);
  if (current.verdict.status === 'confirmed') return { ...current.verdict, source: 'current-page' };

  // A login redirect may finish just after the person clicks Done.
  if (deadline - Date.now() > 2_500) {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    current = await inspectCurrentJdPage(page);
    if (current.verdict.status === 'confirmed') return { ...current.verdict, source: 'current-page' };
  }

  const budget = deadline - Date.now();
  if (budget < 12_000) return {
    status: 'unknown', source: 'current-page',
    message: '云浏览器剩余时间不足以完成账户页复核；不能据此判断未登录。',
    evidence: current.evidence,
  };
  try {
    await page.goto(JD_ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(8_000, budget - 3_000) });
    const probed = await inspectCurrentJdPage(page);
    return { ...probed.verdict, source: 'account-probe' };
  } catch {
    return { status: 'unknown', source: 'account-probe', message: '京东账户页复核未能完成，无法确认或否定登录。' };
  }
}
