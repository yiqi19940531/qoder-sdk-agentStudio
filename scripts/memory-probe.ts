import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { qodercliAuth, query, type SDKUserMessage } from '@qoder-ai/qoder-agent-sdk';
import { dataRoot, fixtureRoot } from '../server/storage.js';

const root = path.join(dataRoot, 'memory-probe');
await mkdir(root, { recursive: true });
const index = path.join(root, 'INDEX.md');
await writeFile(index, '# Memory probe\n', 'utf8');

const turns = [
  '请先调用 Read 工具读取 calculator.ts，再指出一个值得后续会话反复使用的项目事实：average([]) 返回 NaN。只读，不修改文件。',
];

const gates = turns.map(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
});

async function* messages(): AsyncGenerator<SDKUserMessage> {
  for (let i = 0; i < turns.length; i++) {
    if (i) await gates[i - 1].promise;
    yield {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: turns[i] }] },
      parent_tool_use_id: null,
      client_composed: true,
    };
  }
}

const abortController = new AbortController();
const timer = setTimeout(() => abortController.abort(), 150_000);
const results: unknown[] = [];
const q = query({
  prompt: messages(),
  options: {
    auth: qodercliAuth(), cwd: fixtureRoot, settingSources: ['project'],
    model: 'auto', tools: ['Read'], allowedTools: ['Read'], maxTurns: 3, abortController,
    memory: {
      mode: 'custom', userScope: false, projectScope: false,
      generation: {
        roots: [{ id: 'probe', path: root, indexFile: 'INDEX.md' }],
        prompt: 'This is a memory integration test. Save the concrete reusable repository fact learned in the completed turn into the configured probe memory root. Update INDEX.md so a future session can find it. Do not save conversation fluff.',
        turnComplete: { shouldGenerate: async () => ({ run: true }) },
        onResult: (result) => { results.push(result); console.log('memory generation:', result.status, 'reason' in result ? result.reason : ''); },
      },
      consumption: { files: [{ id: 'probe', path: index }] },
    },
  },
});

try {
  const init = await q.initializationResult();
  console.log('memory config:', JSON.stringify(init.memory));
  let completed = 0;
  for await (const message of q) {
    if (message.type !== 'result') continue;
    completed++;
    console.log('turn', completed, message.subtype, 'credits', message.total_credits, 'errors' in message ? message.errors : '');
    gates[completed - 1]?.release();
    if (completed === turns.length) {
      await Promise.race([q.flushMemory(), new Promise<void>((resolve) => setTimeout(resolve, 10_000))]);
      break;
    }
  }
  console.log('completed turns:', completed);
  console.log('memory outcomes:', JSON.stringify(results));
  console.log('index content:', await readFile(index, 'utf8'));
} finally {
  clearTimeout(timer);
  await q.close();
}
