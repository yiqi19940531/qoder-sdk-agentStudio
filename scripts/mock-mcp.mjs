import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

function server() {
  const instance = new McpServer({ name: 'workbench-mcp-fixture', version: '1.0.0' });
  if (process.env.EMPTY_TOOLS !== '1') instance.registerTool(process.env.TOOL_NAME ?? 'fixture_search', { description: 'Read-only fixture search', annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: 'fixture ok' }] }));
  return instance;
}
const transport = process.argv[2];
if (transport === 'stdio') await server().connect(new StdioServerTransport());
else {
  const sessions = new Map();
  const app = http.createServer(async (req, res) => {
    if (process.env.HANG_MCP === '1') { req.resume(); return; }
    const expectedToken = ['fixture', 'secret'].join('-');
    if (req.headers.authorization !== `Bearer ${expectedToken}` && process.env.REQUIRE_TOKEN === '1') { res.writeHead(401).end('Unauthorized'); return; }
    if (transport === 'http') {
      const wire = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const instance = server();
      await instance.connect(wire);
      await wire.handleRequest(req, res);
      res.on('close', () => { void instance.close(); });
      return;
    }
    if (transport === 'sse' && req.method === 'GET' && req.url === '/sse') {
      const wire = new SSEServerTransport('/messages', res);
      sessions.set(wire.sessionId, wire);
      res.on('close', () => sessions.delete(wire.sessionId));
      await server().connect(wire);
      return;
    }
    if (transport === 'sse' && req.method === 'POST' && req.url?.startsWith('/messages')) {
      const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
      const wire = sessions.get(id);
      if (!wire) { res.writeHead(404).end(); return; }
      await wire.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  const port = Number(process.argv[3] ?? 0);
  app.listen(port, '127.0.0.1', () => process.stdout.write(`${app.address().port}\n`));
}
