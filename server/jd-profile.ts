import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dataRoot } from './storage.js';

export type SavedJdProfile = { name: string; savedAt: string; mode?: 'login' | 'mall' | 'unverified' };
export type ProfileCreation = { name: string; connect: string; stop?: string };
export type JdProfileProvider = {
  load(): Promise<SavedJdProfile | null>;
  create(sessionMs: number): Promise<ProfileCreation>;
  reopen?(sessionMs: number, profileName: string): Promise<ProfileCreation>;
  remember(name: string, mode?: 'login' | 'mall' | 'unverified'): Promise<void>;
};

export function jdProxySettings(env: NodeJS.ProcessEnv): { type: 'residential' | 'datacenter'; country: string; sticky: true } | null {
  const type = env.BROWSERLESS_JD_PROXY_NETWORK?.trim() || 'residential';
  if (type === 'none') return null;
  if (type !== 'residential' && type !== 'datacenter') throw new Error('BROWSERLESS_JD_PROXY_NETWORK 只能是 residential、datacenter 或 none');
  const country = (env.BROWSERLESS_JD_PROXY_COUNTRY?.trim() || 'cn').toLowerCase();
  if (!/^[a-z]{2}$/.test(country)) throw new Error('BROWSERLESS_JD_PROXY_COUNTRY 必须是两位国家代码');
  return { type, country, sticky: true };
}

const file = path.join(dataRoot, 'jd-browser-profile.json');
const profileName = (name: string): boolean => /^qoder-jd-[a-f0-9-]{8,64}$/.test(name);

/** Only an opaque profile name is stored locally. Browserless holds the authentication state. */
export class BrowserlessJdProfileProvider implements JdProfileProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async load(): Promise<SavedJdProfile | null> {
    try {
      const record = JSON.parse(await readFile(file, 'utf8')) as SavedJdProfile;
      if (!profileName(record.name) || !Number.isFinite(Date.parse(record.savedAt)) || (record.mode && !['login', 'mall', 'unverified'].includes(record.mode))) throw new Error('本机京东登录档案元数据无效');
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async create(sessionMs: number): Promise<ProfileCreation> { return this.createSession(sessionMs); }

  async reopen(sessionMs: number, profileName: string): Promise<ProfileCreation> {
    if (!profileName.match(/^qoder-jd-[a-f0-9-]{8,64}$/)) throw new Error('无效的京东档案名称');
    return this.createSession(sessionMs, profileName);
  }

  private async createSession(sessionMs: number, savedName?: string): Promise<ProfileCreation> {
    const token = this.env.BROWSERLESS_API_TOKEN?.trim();
    if (!token) throw new Error('未配置 Browserless Token');
    const endpoint = new URL(this.env.BROWSERLESS_WS_ENDPOINT || 'wss://production-sfo.browserless.io/chromium');
    if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password || endpoint.search) throw new Error('Browserless Endpoint 格式无效');
    const url = new URL('/session', `https://${endpoint.host}`);
    url.searchParams.set('token', token);
    const name = savedName ?? `qoder-jd-${randomUUID()}`;
    const proxy = jdProxySettings(this.env);
    const requestedTtl = Number(this.env.BROWSERLESS_PERSIST_TTL_MS);
    const ttl = Number.isSafeInteger(requestedTtl) && requestedTtl >= 300_000 && requestedTtl <= 86_400_000 ? requestedTtl : 1_800_000;
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl, processKeepAlive: Math.min(180_000, ttl), ...(proxy ? { proxy } : {}), ...(savedName ? { profile: savedName } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      // Browserless uses 401 both for invalid tokens and exhausted free-plan units.
      // Do not echo the response body: it may contain account-specific details.
      const body = response.status === 401 ? await response.text().catch(() => '') : '';
      if (/units usage limit allowed under our free plan/i.test(body)) {
        throw new Error('Browserless 免费套餐用量已达上限，暂时无法启动或续接云浏览器。已保存的京东登录档案不会因此删除；请在 Browserless 控制台检查用量。');
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Browserless 认证或套餐权限不足（HTTP ${response.status}）；请检查 Token、服务地址和账户状态。`);
      }
      throw new Error(`Browserless 持久化会话创建失败（HTTP ${response.status}）`);
    }
    const result = await response.json() as { connect?: string; stop?: string };
    if (!result.connect || !result.stop) throw new Error('Browserless 未返回持久化会话连接或清理地址');
    const connect = new URL(result.connect);
    if (connect.protocol !== 'wss:' || connect.host !== endpoint.host || !/(?:^|\/)session\/connect\/[^/]+$/.test(connect.pathname)) {
      throw new Error('Browserless 返回了非预期的档案会话地址');
    }
    connect.searchParams.set('timeout', String(sessionMs));
    const stop = new URL(result.stop);
    if (stop.protocol !== 'https:' || stop.host !== endpoint.host || !/(?:^|\/)session\/[^/]+$/.test(stop.pathname)) {
      throw new Error('Browserless 返回了非预期的会话清理地址');
    }
    return { name, connect: connect.toString(), stop: stop.toString() };
  }

  async remember(name: string, mode: 'login' | 'mall' | 'unverified' = 'login'): Promise<void> {
    if (!profileName(name)) throw new Error('无效的京东登录档案名称');
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ name, savedAt: new Date().toISOString(), mode }), { mode: 0o600 });
    await rename(temporary, file);
  }
}
