import { existsSync } from 'node:fs';
import puppeteer, { type Browser } from 'puppeteer-core';
import { BrowserlessJdProfileProvider } from '../server/jd-profile.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const token = process.env.BROWSERLESS_API_TOKEN?.trim();
if (!token) throw new Error('请先在 .env 配置 BROWSERLESS_API_TOKEN');
const endpoint = new URL(process.env.BROWSERLESS_WS_ENDPOINT || 'wss://production-sfo.browserless.io/chromium');
const provider = new BrowserlessJdProfileProvider({ ...process.env, BROWSERLESS_JD_PROXY_NETWORK: 'none' });
const creation = await provider.create(120_000);
let first: Browser | undefined;
let restored: Browser | undefined;
try {
  first = await puppeteer.connect({ browserWSEndpoint: creation.connect, protocolTimeout: 30_000 });
  const page = (await first.pages())[0] ?? await first.newPage();
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await page.setCookie({ name: 'qoder_profile_smoke', value: 'ok', domain: 'example.com', path: '/', secure: true });
  const cdp = await page.createCDPSession();
  const saved = await (cdp as unknown as { send(method: string, params: Record<string, string>): Promise<unknown> })
    .send('Browserless.saveProfile', { name: creation.name }) as { ok?: boolean };
  if (saved.ok !== true) throw new Error('Browserless.saveProfile 未成功');
  await first.close();
  first = undefined;

  const url = new URL(endpoint);
  url.searchParams.set('token', token);
  url.searchParams.set('timeout', '120000');
  url.searchParams.set('profile', creation.name);
  restored = await puppeteer.connect({ browserWSEndpoint: url.toString(), protocolTimeout: 30_000 });
  const other = (await restored.pages())[0] ?? await restored.newPage();
  await other.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  const worked = (await other.browserContext().cookies())
    .some((cookie) => cookie.name === 'qoder_profile_smoke' && cookie.value === 'ok');
  if (!worked) throw new Error('新浏览器未恢复测试 Cookie');
  console.log('Browserless profile save → close → new browser restore: passed (test-only cookie).');
} finally {
  await restored?.close().catch(() => {});
  await first?.close().catch(() => {});
  if (creation.stop) await fetch(creation.stop, { method: 'DELETE' }).catch(() => {});
  const cleanup = new URL(`/profile/${encodeURIComponent(creation.name)}`, `https://${endpoint.host}`);
  cleanup.searchParams.set('token', token);
  const response = await fetch(cleanup, { method: 'DELETE' }).catch(() => undefined);
  if (!response?.ok) console.error('测试档案清理未确认；请在 Browserless Profiles 控制台检查 qoder-jd 测试档案。');
}
