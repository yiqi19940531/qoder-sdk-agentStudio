import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 19)) {
  console.error('Node.js 20.19+ is required. Node.js 22.12+ is recommended. / 需要 Node.js 20.19+，推荐 22.12+。');
  process.exit(1);
}
if (process.platform === 'win32' && process.arch === 'arm64') {
  console.error('Qoder CLI does not currently support Windows arm64. / Qoder CLI 目前不支持 Windows arm64。');
  process.exit(1);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cli = ['qoder', 'qodercli'].find((name) => spawnSync(name, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0);
if (!cli) {
  console.error('Install Qoder CLI and sign in first; see QUICKSTART.zh-CN.md or QUICKSTART.en.md.');
  process.exit(1);
}
console.log(`Qoder CLI detected: ${cli}. The SDK uses its own bundled runtime.`);
const models = spawnSync(cli, ['--list-models'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 30_000 });
if (models.status !== 0) {
  console.error('Qoder model check failed. Run Qoder CLI, sign in, then retry. / 无法读取 Qoder 模型，请先运行 CLI 登录。');
  process.exit(1);
}
const python = process.platform === 'win32' ? spawnSync('py', ['-3', '--version'], { encoding: 'utf8', shell: true }) : spawnSync('python3', ['--version'], { encoding: 'utf8' });
if (python.status !== 0) console.log('Optional: install Python 3 to enable Bailian image/video generation. / 可选：安装 Python 3 后可使用百炼生成。');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(npm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} exited with ${code}`)));
  });
}
try {
  if (!existsSync(path.join(root, 'node_modules', '@qoder-ai', 'qoder-agent-sdk'))) await run(['ci']);
  await run(['run', 'build']);
  const server = spawn(npm, ['start'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  server.once('error', (error) => { console.error(error); process.exitCode = 1; });
  const url = `http://127.0.0.1:${process.env.PORT || '8787'}`;
  console.log(`Open ${url} / 请打开 ${url}`);
  process.on('SIGINT', () => server.kill('SIGINT'));
  process.on('SIGTERM', () => server.kill('SIGTERM'));
  server.once('exit', (code) => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
