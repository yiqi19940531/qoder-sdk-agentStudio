import { createServer } from 'node:http';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.from('000000186674797069736F6D0000000069736F6D', 'hex');
let polls = 0;
const port = Number(process.env.MOCK_PORT ?? 8799);
createServer(async (request, response) => {
  const origin = `http://127.0.0.1:${port}`;
  const url = request.url ?? '';
  if (url === '/image.png') { response.setHeader('Content-Type', 'image/png'); response.end(png); return; }
  if (url === '/video.mp4') { response.setHeader('Content-Type', 'video/mp4'); response.end(mp4); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
  response.setHeader('Content-Type', 'application/json');
  if (url.endsWith('/services/aigc/multimodal-generation/generation')) {
    response.end(JSON.stringify({ request_id: 'mock-image-request', output: { choices: [{ message: { content: [{ image: `${origin}/image.png` }] } }] } }));
  } else if (url.endsWith('/services/aigc/video-generation/video-synthesis')) {
    polls = 0;
    response.end(JSON.stringify({ request_id: 'mock-video-request', output: { task_id: 'mock-video-task', task_status: 'PENDING' } }));
  } else if (url.endsWith('/tasks/mock-video-task')) {
    polls++;
    response.end(JSON.stringify({ output: { task_status: polls < 2 ? 'RUNNING' : 'SUCCEEDED', video_url: `${origin}/video.mp4` } }));
  } else { response.writeHead(404).end(JSON.stringify({ error: 'not found' })); }
  console.log(request.method, url, body?.model ?? '');
}).listen(port, '127.0.0.1', () => console.log(`AIGC mock listening on ${port}`));
