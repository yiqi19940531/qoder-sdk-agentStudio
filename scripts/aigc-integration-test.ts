import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { artifactFile, artifactsForConversation, generate, generatedRoot, getAigcSettings, initializeAigc, saveAigcSettings } from '../server/aigc.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
const keyFile = 'api-key.md';
let createdTestKey = false;
try { await access(keyFile); }
catch {
  await writeFile(keyFile, `Key: sk-${'x'.repeat(24)}\nEndpoint: https://demo.cn-beijing.maas.aliyuncs.com/compatible-mode/v1\n`, { mode: 0o600 });
  createdTestKey = true;
}
const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex');
const requests: Array<{ path: string; body: any }> = [];
let origin = '';
let pollCount = 0;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  requests.push({ path: request.url ?? '', body });
  if (request.url?.startsWith('/services/') || request.url?.startsWith('/tasks/')) assert.match(String(request.headers.authorization), /^Bearer sk-/);
  if (request.url === '/services/aigc/multimodal-generation/generation') {
    if (body.input.messages[0].content[0].text === 'force-error') { response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'MockFailure', message: 'provider unavailable' })); return; }
    if (body.input.messages[0].content[0].text === 'force-timeout') { setTimeout(() => response.writeHead(200).end('{}'), 500); return; }
    assert.equal(body.model, 'qwen-image-3.0');
    assert.equal(body.parameters.size, '1024*1024');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ request_id: 'mock-image-request', output: { choices: [{ message: { content: [{ image: `${origin}/image.png` }] } }] } }));
  } else if (request.url === '/services/aigc/video-generation/video-synthesis') {
    assert.equal(body.model, 'wan3.0-video');
    assert.equal(body.parameters.duration, 5);
    assert.equal(body.parameters.resolution, '480P');
    assert.equal(request.headers['x-dashscope-async'], 'enable');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ request_id: 'mock-video-request', output: { task_id: 'mock-task', task_status: 'PENDING' } }));
  } else if (request.url === '/tasks/mock-task') {
    pollCount++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ output: { task_status: pollCount === 1 ? 'RUNNING' : 'SUCCEEDED', video_url: `${origin}/video.mp4` } }));
  } else if (request.url === '/image.png' || request.url === '/video.mp4') {
    response.end(request.url === '/image.png' ? png : mp4);
  } else { response.writeHead(404).end(); }
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
process.env.AIGC_TEST_BASE_URL = origin;
const conversationId = randomUUID();
const ids: string[] = [];
try {
  const resumeId = randomUUID();
  const resumeTurn = randomUUID();
  ids.push(resumeId);
  await mkdir(generatedRoot, { recursive: true });
  await writeFile(`${generatedRoot}/${resumeId}.json`, JSON.stringify({ id: resumeId, conversationId, turnId: resumeTurn, kind: 'video', status: 'running', prompt: 'resume test', model: 'wan3.0-video', taskId: 'mock-task', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  await initializeAigc();
  const resumed = await generate('video', conversationId, resumeTurn, 'resume test');
  assert.equal(resumed.status, 'succeeded');
  assert.equal(requests.filter((item) => item.path.endsWith('/video-synthesis')).length, 0);
  pollCount = 0;
  const initial = getAigcSettings();
  assert.equal(initial.imageSize, '1024*1024');
  const imageTurn = randomUUID();
  const image = await generate('image', conversationId, imageTurn, '一朵白色花，纯色背景');
  ids.push(image.id);
  assert.equal(image.status, 'succeeded');
  assert.equal(image.requestId, 'mock-image-request');
  assert.deepEqual(await readFile(artifactFile(image)!), png);
  const repeated = await generate('image', conversationId, imageTurn, '其他提示词');
  assert.equal(repeated.id, image.id);
  assert.equal(requests.filter((item) => item.path.endsWith('/generation')).length, 1);
  const video = await generate('video', conversationId, randomUUID(), '花朵在微风中摆动');
  ids.push(video.id);
  assert.equal(video.status, 'succeeded');
  assert.equal(video.taskId, 'mock-task');
  assert.equal(video.requestId, 'mock-video-request');
  assert.deepEqual(await readFile(artifactFile(video)!), mp4);
  assert.equal(pollCount, 2);
  assert.equal(artifactsForConversation(conversationId).length, 3);
  const failed = await generate('image', conversationId, randomUUID(), 'force-error');
  ids.push(failed.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /MockFailure/);
  process.env.AIGC_TEST_TIMEOUT_MS = '100';
  const timedOut = await generate('image', conversationId, randomUUID(), 'force-timeout');
  ids.push(timedOut.id);
  delete process.env.AIGC_TEST_TIMEOUT_MS;
  assert.equal(timedOut.status, 'failed');
  assert.ok(!JSON.stringify(artifactsForConversation(conversationId)).includes('DASHSCOPE_API_KEY'));
  const current = getAigcSettings();
  await saveAigcSettings(current);
  assert.deepEqual(getAigcSettings(), current);
  console.log('AIGC mock: image, video submit/poll, restart resume, duplicate guard, failure, timeout, local media, settings PASS');
} finally {
  for (const id of ids) {
    await rm(`data/generated/${id}.json`, { force: true });
    await rm(`data/generated/${id}.png`, { force: true });
    await rm(`data/generated/${id}.mp4`, { force: true });
  }
  if (createdTestKey) await rm(keyFile, { force: true });
  server.close();
}
