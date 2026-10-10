import type { Page } from 'puppeteer-core';

export const JD_LOGIN_URL = 'https://passport.jd.com/new/login.aspx';
export const JD_ACCOUNT_URL = 'https://home.jd.com/';

export type LoginVerdict = { status: 'confirmed' | 'not-confirmed' | 'unknown'; message: string };

/** A positive result needs both the account-center origin and visible account UI. */
export function classifyJdLogin(url: string, visibleText: string): LoginVerdict {
  let location: URL;
  try { location = new URL(url); }
  catch { return { status: 'unknown', message: '京东页面地址无法识别，未确认登录。' }; }
  if (location.hostname === 'passport.jd.com' || /请输入手机号|短信登录|密码登录/.test(visibleText)) {
    return { status: 'not-confirmed', message: '页面仍在京东登录流程中，请完成验证后再试。' };
  }
  if (location.hostname === 'home.jd.com' && /我的京东|我的订单|个人中心|账户设置|账户中心/.test(visibleText)) {
    return { status: 'confirmed', message: '已通过京东账户页确认登录。' };
  }
  return { status: 'unknown', message: '尚未看到足够的京东账户页证据，未确认登录。' };
}

export async function verifyJdLogin(page: Page): Promise<LoginVerdict> {
  try {
    await page.goto(JD_ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    const visibleText = (await page.$eval('body', (body) => (body as HTMLElement).innerText)).slice(0, 20_000);
    return classifyJdLogin(page.url(), visibleText);
  } catch {
    return { status: 'unknown', message: '无法读取京东账户页，可能受到网络或风控限制；未确认登录。' };
  }
}
