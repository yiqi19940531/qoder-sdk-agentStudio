import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import type { JdProduct, JdTask } from '../shared/types.js';
import { dataRoot } from './storage.js';
export type { JdProduct, JdTask } from '../shared/types.js';
export type JdSearchObservation = {
  status: 'results' | 'needs-human' | 'unavailable';
  pageHost: string; sortApplied: boolean; products: Omit<JdProduct, 'rank' | 'reviews'>[];
  note?: string;
};
export type JdReviewObservation = {
  status: 'results' | 'needs-human' | 'unavailable';
  pageHost: string; reviews: Array<{ text: string; helpful?: number }>;
  note?: string;
};

const taskDirectory = path.join(dataRoot, 'jd-tasks');
const jdHost = (host: string) => host === 'jd.com' || host.endsWith('.jd.com');
const challengeHost = (host: string) => host === 'passport.jd.com' || host === 'aq.jd.com' || host === 'cfe.m.jd.com';
function currentHost(page: Page): string {
  try { return new URL(page.url()).host; } catch { return ''; }
}
function searchHandoff(page: Page): JdSearchObservation | null {
  const pageHost = currentHost(page);
  return challengeHost(pageHost)
    ? { status: 'needs-human', pageHost, sortApplied: false, products: [], note: '京东搜索已转到登录或人工风险验证页面。' }
    : null;
}
const safeText = (value: string, length: number) => value.replace(/\s+/g, ' ').trim().slice(0, length);
const reviewText = (value: string) => safeText(value, 500)
  .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[PHONE]')
  .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');

function taskFile(conversationId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(conversationId)) throw new Error('无效的会话 ID');
  return path.join(taskDirectory, `${conversationId}.json`);
}

export async function loadJdTask(conversationId: string): Promise<JdTask | null> {
  try { return JSON.parse(await readFile(taskFile(conversationId), 'utf8')) as JdTask; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function saveJdTask(task: JdTask): Promise<void> {
  await mkdir(taskDirectory, { recursive: true });
  task.updatedAt = new Date().toISOString();
  const file = taskFile(task.conversationId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(task, null, 2), 'utf8');
  await rename(temporary, file);
}

export function newJdTask(conversationId: string, keyword: string): JdTask {
  const now = new Date().toISOString();
  return { id: randomUUID(), conversationId, keyword: safeText(keyword, 80), createdAt: now, updatedAt: now,
    sortRequested: 'sales', sortApplied: false, products: [], nextReviewIndex: 0, status: 'collecting' };
}

export async function searchJdProducts(page: Page, keyword: string, limit = 20): Promise<JdSearchObservation> {
  const term = safeText(keyword, 80);
  if (!term) throw new Error('请输入搜索词');
  const url = new URL('https://search.jd.com/Search');
  url.searchParams.set('keyword', term);
  url.searchParams.set('enc', 'utf-8');
  const current = (() => { try { return new URL(page.url()); } catch { return null; } })();
  const initialHandoff = searchHandoff(page);
  if (initialHandoff) return initialHandoff;
  if (!current || current.host !== 'search.jd.com' || current.searchParams.get('keyword') !== term) {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 18_000 }).catch(() => {});
  }
  let host = currentHost(page);
  const navigatedHandoff = searchHandoff(page);
  if (navigatedHandoff) return navigatedHandoff;
  if (!jdHost(host) || host === 'corporate.jd.com' || host === 'global.jd.com') {
    return { status: 'unavailable', pageHost: host, sortApplied: false, products: [], note: '未进入中国区京东商城搜索结果。' };
  }
  await page.waitForSelector('#J_goodsList .gl-item, .gl-item', { timeout: 7_000 }).catch(() => {});
  // JD may redirect from search.jd.com to cfe.m.jd.com after DOMContentLoaded.
  // Check again after waiting; otherwise an empty risk page is misreported as no products.
  const delayedHandoff = searchHandoff(page);
  if (delayedHandoff) return delayedHandoff;
  const emptyGate = await page.evaluate(() => {
    const cards = document.querySelectorAll('#J_goodsList .gl-item, .gl-item').length;
    const text = document.body?.innerText ?? '';
    return cards === 0 && /请先登录|登录并领取|安全验证|滑块验证|请完成验证|访问过于频繁/.test(text);
  }).catch(() => false);
  if (emptyGate) return { status: 'needs-human', pageHost: currentHost(page), sortApplied: false, products: [], note: '京东搜索页显示人工登录或风险验证提示。' };
  const sortHref = await page.evaluate(() => {
    const links = [...document.querySelectorAll('.f-sort a, #J_filter a, a')];
    const sales = links.find((node) => node.textContent?.trim() === '销量');
    return sales?.getAttribute('href') ?? null;
  }).catch(() => null);
  let sortApplied = false;
  if (sortHref) {
    try {
      const sorted = new URL(sortHref, page.url());
      if (sorted.protocol === 'https:' && jdHost(sorted.hostname) && sorted.toString() !== page.url()) {
        await page.goto(sorted.toString(), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
        sortApplied = new URL(page.url()).hostname === 'search.jd.com';
      }
    } catch { /* Site layout can change; report unsorted data rather than inventing a ranking. */ }
  }
  const sortedHandoff = searchHandoff(page);
  if (sortedHandoff) return sortedHandoff;
  const products: Omit<JdProduct, 'rank' | 'reviews'>[] = [];
  const seen = new Set<string>();
  for (let pageNumber = 0; pageNumber < 3 && products.length < limit; pageNumber++) {
    const pageHandoff = searchHandoff(page);
    if (pageHandoff) return pageHandoff;
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 850));
    const cards = await page.evaluate(() => [...document.querySelectorAll('#J_goodsList .gl-item, .gl-item')].map((card) => {
      const pick = (selector: string) => card.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const anchor = card.querySelector<HTMLAnchorElement>('.p-name a[href], a[href*="item.jd.com"]');
      return {
        sku: card.getAttribute('data-sku') ?? '', name: pick('.p-name em') || pick('.p-name'),
        brand: pick('.p-shop'), price: pick('.p-price i') || pick('.p-price'),
        promotion: pick('.p-icons') || pick('.p-promo') || pick('[class*="promotion"]'),
        commentCount: pick('.p-commit'), url: anchor?.href ?? '',
      };
    })).catch(() => []);
    for (const item of cards) {
      let itemUrl: URL;
      try { itemUrl = new URL(item.url); } catch { continue; }
      if (itemUrl.protocol !== 'https:' || !jdHost(itemUrl.hostname) || !item.name) continue;
      const sku = item.sku || itemUrl.pathname.match(/\/(\d+)\.html/)?.[1] || '';
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      products.push({ sku, name: safeText(item.name, 240), brand: safeText(item.brand, 100) || undefined,
        price: safeText(item.price, 50) || undefined, promotion: safeText(item.promotion, 200) || undefined,
        commentCount: safeText(item.commentCount, 80) || undefined, url: `${itemUrl.origin}${itemUrl.pathname}` });
      if (products.length >= limit) break;
    }
    if (products.length >= limit) break;
    const nextHref = await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a.pn-next, .pn-next')?.href ?? null).catch(() => null);
    if (!nextHref) break;
    const next = new URL(nextHref, page.url());
    if (next.protocol !== 'https:' || next.hostname !== 'search.jd.com') break;
    await page.goto(next.toString(), { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    const nextHandoff = searchHandoff(page);
    if (nextHandoff) return nextHandoff;
    if (currentHost(page) !== 'search.jd.com') break;
  }
  const finalHandoff = searchHandoff(page);
  if (finalHandoff) return finalHandoff;
  if (!products.length) return { status: 'unavailable', pageHost: host, sortApplied, products, note: '商城未返回可核实的商品卡片；可能需要人工验证或页面结构已变。' };
  return { status: 'results', pageHost: host, sortApplied, products,
    note: sortApplied ? undefined : '未能确认京东页面的销量排序；这些商品不能称为销量前 20。' };
}

export async function collectJdReviews(page: Page, product: JdProduct): Promise<JdReviewObservation> {
  const url = new URL(product.url);
  if (url.protocol !== 'https:' || !jdHost(url.hostname)) throw new Error('商品链接不是京东官方页面');
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 18_000 }).catch(() => {});
  let host: string;
  try { host = new URL(page.url()).host; } catch { host = ''; }
  if (challengeHost(host)) return { status: 'needs-human', pageHost: host, reviews: [], note: '商品评价页面要求人工验证。' };
  if (!jdHost(host) || host === 'corporate.jd.com' || host === 'global.jd.com') {
    return { status: 'unavailable', pageHost: host, reviews: [], note: '没有进入中国区京东商品页。' };
  }
  const reviews = await page.evaluate(() => [...document.querySelectorAll('.comment-item, .J-comment-item')].slice(0, 30).map((item) => {
    const text = item.querySelector('.comment-con, .J-comment-content, .comment-content')?.textContent ?? '';
    const score = Number(item.getAttribute('data-score') ?? item.querySelector('[data-score]')?.getAttribute('data-score'));
    const helpful = Number((item.querySelector('.useful, .praise')?.textContent ?? '').replace(/[^\d]/g, ''));
    return { text, score: Number.isFinite(score) ? score : null, helpful: Number.isFinite(helpful) ? helpful : 0 };
  })).catch(() => []);
  const positive = reviews.filter((item) => item.text.trim() && (item.score === null || item.score >= 4))
    .sort((a, b) => b.helpful - a.helpful).slice(0, 3)
    .map((item) => ({ text: reviewText(item.text), helpful: item.helpful || undefined }));
  return { status: positive.length ? 'results' : 'unavailable', pageHost: host, reviews: positive,
    note: positive.length ? '从当前页面可见的高评分评论中，优先选取互动数较高的内容；不代表全站最热。' : '当前商品页没有可核实的评论文本。' };
}
