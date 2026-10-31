import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const fromDesktop = createRequire(join(desktop, 'package.json'));
const [command, ...options] = process.argv.slice(2);
if (!['dev', 'build'].includes(command)) throw new Error('桌面命令须为 dev 或 build');
const children = new Set();
let stopping = false;
function launch(executable, args, cwd = root, environment = {}, stdio = 'inherit') {
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...environment }, stdio, windowsHide: true });
  children.add(child); child.on('exit', () => children.delete(child));
  return child;
}
function exited(child) {
  return new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}
function stop() { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  if (command === 'build') {
    const cli = join(dirname(fromDesktop.resolve('electron-builder/package.json')), 'cli.js');
    const target = process.platform === 'win32' ? ['--win', 'nsis', '--x64'] : process.platform === 'darwin' ? ['--mac', '--dir'] : ['--linux', '--dir'];
    process.exitCode = await exited(launch(process.execPath, [cli, '--config', join(root, 'electron-builder.yml'), '--publish', 'never', ...target, ...options]));
  } else {
    const vite = join(dirname(fromDesktop.resolve('vite/package.json')), 'bin', 'vite.js');
    const server = launch(process.execPath, ['--import', 'tsx', vite, '--host', '127.0.0.1', '--port', '1420', '--strictPort'], desktop, { VIDEO_QUICKLY_NATIVE_DESKTOP: '1' }, ['inherit', 'pipe', 'inherit']);
    // A dedicated strict-port server prevents connecting a desktop window to
    // another checkout or an existing user's development session.
    let serverReady = false; let serverOutput = '';
    server.stdout.on('data', chunk => { process.stdout.write(chunk); serverOutput = (serverOutput + chunk.toString()).slice(-4096); serverReady ||= serverOutput.includes('http://127.0.0.1:1420/'); });
    let serverExit; server.once('error', error => { serverExit = error; }); server.once('exit', code => { serverExit = new Error(`开发服务器退出：${code}`); });
    const url = 'http://127.0.0.1:1420';
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (serverExit) throw serverExit;
      if (Date.now() >= deadline) throw new Error('桌面开发服务器启动超时');
      try { if (serverReady && (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* server is not listening yet */ }
      await delay(100);
    }
    // Require Electron only in the Node launcher, never in the renderer.
    const electron = fromDesktop('electron');
    const environment = { VIDEO_QUICKLY_DEV_URL: url };
    // GUI launchers may inherit this from a parent Node tool. The application
    // must start as Electron rather than silently becoming another Node CLI.
    const inheritedRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    delete process.env.ELECTRON_RUN_AS_NODE;
    const app = launch(electron, [desktop, ...options], desktop, environment);
    if (inheritedRunAsNode !== undefined) process.env.ELECTRON_RUN_AS_NODE = inheritedRunAsNode;
    process.exitCode = await exited(app);
  }
} finally { stop(); }
