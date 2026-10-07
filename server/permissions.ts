import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIGURABLE_PERMISSION_TOOLS, type PermissionSettings } from '../shared/types.js';
import { dataRoot } from './storage.js';
import { allDiscoveredToolNames } from './mcp-registry.js';

export const permissionSettingsPath = path.join(dataRoot, 'permission-settings.json');
const file = permissionSettingsPath;
const supportedTools = new Set<string>(CONFIGURABLE_PERMISSION_TOOLS);
let settings: PermissionSettings = { alwaysAllowTools: [] };
let writes: Promise<unknown> = Promise.resolve();

export function isConfigurableTool(toolName: string): boolean {
  return (supportedTools.has(toolName) || allDiscoveredToolNames().includes(toolName)) && !toolName.includes('browser_run_code_unsafe');
}

function validate(toolNames: string[]): string[] {
  if (toolNames.length > supportedTools.size + allDiscoveredToolNames().length || toolNames.some((name) => !isConfigurableTool(name))) throw new Error('包含不支持全局授权的工具');
  return [...new Set(toolNames)].sort();
}

export async function initializePermissions(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as PermissionSettings;
    settings = { alwaysAllowTools: validate((saved.alwaysAllowTools ?? []).filter(isConfigurableTool)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
export function revokeMcpGlobalPermissions(id: string): Promise<PermissionSettings> {
  return updateSettings((current) => current.filter((name) => !name.startsWith(`mcp__${id}__`)));
}

export function getPermissionSettings(): PermissionSettings {
  return { alwaysAllowTools: [...settings.alwaysAllowTools] };
}

export function isGloballyAllowed(toolName: string): boolean {
  return isConfigurableTool(toolName) && settings.alwaysAllowTools.includes(toolName);
}

function updateSettings(change: (current: string[]) => string[]): Promise<PermissionSettings> {
  const next = writes.then(async () => {
    const alwaysAllowTools = validate(change(settings.alwaysAllowTools));
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ alwaysAllowTools }, null, 2), 'utf8');
    await rename(temporary, file);
    settings = { alwaysAllowTools };
    return getPermissionSettings();
  });
  writes = next.catch(() => {});
  return next;
}

export function replacePermissionSettings(toolNames: string[]): Promise<PermissionSettings> {
  return updateSettings(() => toolNames);
}

export function allowToolGlobally(toolName: string): Promise<PermissionSettings> {
  if (!isConfigurableTool(toolName)) throw new Error('此工具不能全局授权');
  return updateSettings((current) => [...current, toolName]);
}

export function setToolGlobally(toolName: string, allowed: boolean): Promise<PermissionSettings> {
  if (!isConfigurableTool(toolName)) throw new Error('此工具不能全局授权');
  return updateSettings((current) => allowed ? [...current, toolName] : current.filter((name) => name !== toolName));
}

const browserGroups: Record<string, { category: string; label: string }> = {
  browser_navigate: { category: 'browser:navigation', label: '浏览器导航（包括新来源）' },
  new_page: { category: 'browser:navigation', label: '浏览器导航（包括新来源）' },
  navigate_page: { category: 'browser:navigation', label: '浏览器导航（包括新来源）' },
  evaluate_script: { category: 'browser:script', label: '页面脚本执行' },
  browser_evaluate: { category: 'browser:script', label: '页面脚本执行' },
  take_screenshot: { category: 'browser:screenshot', label: '网页截图' },
  browser_take_screenshot: { category: 'browser:screenshot', label: '网页截图' },
  resize_page: { category: 'browser:viewport', label: '调整浏览器尺寸' },
  browser_resize: { category: 'browser:viewport', label: '调整浏览器尺寸' },
  click: { category: 'browser:click', label: '网页点击' },
  browser_click: { category: 'browser:click', label: '网页点击' },
  fill: { category: 'browser:input', label: '网页表单输入' },
  fill_form: { category: 'browser:input', label: '网页表单输入' },
  browser_fill_form: { category: 'browser:input', label: '网页表单输入' },
  browser_type: { category: 'browser:input', label: '网页表单输入' },
  type_text: { category: 'browser:input', label: '网页表单输入' },
  browser_select_option: { category: 'browser:input', label: '网页表单输入' },
  press_key: { category: 'browser:keyboard', label: '网页按键' },
  browser_press_key: { category: 'browser:keyboard', label: '网页按键' },
};

export function approvalCategory(toolName: string): { category: string; label: string } | undefined {
  if (toolName === 'Write' || toolName === 'Edit') return { category: 'file:modify', label: '修改示例仓库文件' };
  const match = /^mcp__(playwright|chrome-devtools)__(.+)$/.exec(toolName);
  return match ? browserGroups[match[2]] : undefined;
}
