import { open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { customMcpConfig, getMcpServer, initializeMcpRegistry } from '../server/mcp-registry.js';
import { dataRoot } from '../server/storage.js';

const marker = path.join(dataRoot, 'apify-verification.json');
await initializeMcpRegistry();
const record = getMcpServer('apify');
const config = customMcpConfig('apify');
if (!record || record.source !== 'custom' || record.auth !== 'bearer' || config?.type !== 'http' || !config.headers?.Authorization) {
  throw new Error('请先在配置页创建 Apify HTTP 服务并输入 Bearer Token');
}
const endpoint = new URL(config.url);
if (endpoint.hostname !== 'mcp.apify.com' || !endpoint.searchParams.get('tools')?.includes('actors')) throw new Error('Apify 地址不符合受控验证配置');
const client = new Client({ name: 'qoder-agent-workbench-verify', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: config.headers } }));
  const tools = (await client.listTools()).tools;
  const actorTool = tools.find((item) => item.name === 'call-actor');
  if (!actorTool || !tools.some((item) => item.name === 'search-actors')) throw new Error('Apify 未发现预期工具');
  const callOptions = (actorTool.inputSchema.properties?.callOptions as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!callOptions?.maxTotalChargeUsd) throw new Error('Apify call-actor 没有暴露 maxTotalChargeUsd；停止付费验证');
  const file = await open(marker, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') throw new Error('受控验证已尝试过一次；请先检查 data/apify-verification.json，避免重复计费');
    throw error;
  });
  await file.writeFile(JSON.stringify({ attemptedAt: new Date().toISOString(), actor: 'apify/web-fetch', url: 'https://example.com', maxTotalChargeUsd: 0.05, status: 'submitted' }, null, 2));
  await file.close();
  const response = await client.callTool({ name: 'call-actor', arguments: {
    actor: 'apify/web-fetch', input: { url: 'https://example.com', formats: ['markdown'] },
    waitSecs: 45, callOptions: { maxTotalChargeUsd: 0.05, maxItems: 1, timeout: 60 },
  } }, undefined, { timeout: 75_000 });
  let raw = JSON.stringify(response.structuredContent ?? response.content);
  const id = /"(?:runId|id)"\s*:\s*"([a-zA-Z0-9_-]+)"/.exec(raw)?.[1];
  let status = /"status"\s*:\s*"([A-Z_]+)"/.exec(raw)?.[1] ?? (response.isError ? 'FAILED' : 'UNKNOWN');
  let datasetId = /"(?:defaultDatasetId|datasetId)"\s*:\s*"([a-zA-Z0-9_-]+)"/.exec(raw)?.[1]
    ?? /"datasets"\s*:\s*\{\s*"default"\s*:\s*\{\s*"id"\s*:\s*"([a-zA-Z0-9_-]+)"/.exec(raw)?.[1];
  if (id && ['RUNNING', 'READY'].includes(status) && tools.some((item) => item.name === 'get-actor-run')) {
    for (let attempt = 0; attempt < 6 && ['RUNNING', 'READY'].includes(status); attempt++) {
      const result = await client.callTool({ name: 'get-actor-run', arguments: { runId: id, waitSecs: 10 } }, undefined, { timeout: 20_000 });
      raw = JSON.stringify(result.structuredContent ?? result.content);
      status = /"status"\s*:\s*"([A-Z_]+)"/.exec(raw)?.[1] ?? status;
      datasetId = /"(?:defaultDatasetId|datasetId)"\s*:\s*"([a-zA-Z0-9_-]+)"/.exec(raw)?.[1] ?? datasetId;
    }
  }
  let contentVerified = false;
  if (datasetId && status === 'SUCCEEDED' && tools.some((item) => item.name === 'get-dataset-items')) {
    const dataset = await client.callTool({ name: 'get-dataset-items', arguments: { datasetId, limit: 1 } }, undefined, { timeout: 20_000 });
    contentVerified = JSON.stringify(dataset.structuredContent ?? dataset.content).includes('Example Domain');
  }
  const summary = { attemptedAt: new Date().toISOString(), actor: 'apify/web-fetch', url: 'https://example.com', maxTotalChargeUsd: 0.05,
    runId: id, status, datasetId, contentVerified, responsePreview: raw.slice(0, 1200) };
  await writeFile(marker, JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ runId: id, status, datasetId, contentVerified, responsePreview: raw.slice(0, 280) }));
  if (response.isError || !id) process.exitCode = 1;
} finally { await client.close().catch(() => {}); }
