import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps', 'desktop');
const requireDesktop = createRequire(join(desktop, 'package.json'));
const cli = join(dirname(requireDesktop.resolve('@tauri-apps/cli/package.json')), 'tauri.js');
const environment = { ...process.env };
const localCargo = join(root, '.tools', 'rust', 'cargo');
if (existsSync(join(localCargo, 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'))) {
  environment.CARGO_HOME ??= localCargo;
  environment.RUSTUP_HOME ??= join(root, '.tools', 'rust', 'rustup');
  const inheritedPath = process.env.PATH ?? '';
  // Windows accepts Path/PATH as the same key, but a spread object does not.
  if (process.platform === 'win32') for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
  environment.PATH = `${join(localCargo, 'bin')}${process.platform === 'win32' ? ';' : ':'}${inheritedPath}`;
}
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { cwd: desktop, env: environment, stdio: 'inherit', windowsHide: true });
child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
