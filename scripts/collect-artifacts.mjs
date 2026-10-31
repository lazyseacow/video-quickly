import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.generated/release');
const installers = join(root, '.generated/electron-release');
const files = (await readdir(installers)).filter(name => name.endsWith('-setup.exe'));
if (files.length !== 1) throw new Error('安装包目录应恰好包含一个 setup.exe');
const unit = JSON.parse(await readFile(join(root, '.generated/test-results.json'), 'utf8'));
const packaged = JSON.parse(await readFile(join(root, '.generated/packaged-runtime-results.json'), 'utf8'));
const electron = JSON.parse(await readFile(join(root, '.generated/electron-results.json'), 'utf8'));
const browser = JSON.parse(await readFile(join(root, '.generated/browser-results.json'), 'utf8'));
const media = JSON.parse(await readFile(join(root, '.generated/render-smoke/results.json'), 'utf8'));
const installation = process.env.GITHUB_ACTIONS === 'true' ? JSON.parse(await readFile(join(root, '.generated/install-smoke.json'), 'utf8')) : undefined;
if (unit.success !== true || unit.numFailedTestSuites || unit.numFailedTests || !unit.numPassedTests || browser.stats.unexpected || browser.stats.flaky || !browser.stats.expected || media.length < 4) throw new Error('验证结果不完整或存在失败，未生成发布清单');
if (packaged.success !== true || packaged.numFailedTestSuites || packaged.numFailedTests || packaged.numPassedTests !== 2 || packaged.numPendingTests) throw new Error('仓库外打包组件的中英文 PDF 验证未全部通过，未生成发布清单');
if (electron.status !== 'passed' || electron.packaged !== true || electron.platform !== 'win32' || electron.distributionScope !== 'bundled-runtime-and-media' || !electron.checks?.nativeBridge || !electron.checks?.restartRecovery || !electron.checks?.mediaRange || !electron.checks?.sandbox || !electron.checks?.senderBoundary || !electron.checks?.actualExport || !electron.checks?.videoPreview || !electron.checks?.nativeCredentialRestart || !electron.checks?.reconnect || !electron.checks?.consoleHealth || !electron.checks?.cancelWindowClose || !electron.checks?.cancelQuit || !electron.checks?.confirmedQuit) throw new Error('Electron 原生验收未通过，未生成发布清单');
await mkdir(output, { recursive: true });
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const installer = join(output, `Video-Quickly-${version}-windows-x64-setup.exe`);
await copyFile(join(installers, files[0]), installer);
async function fileInfo(path) {
  const content = await readFile(path);
  return { name: basename(path), bytes: (await stat(path)).size, sha256: createHash('sha256').update(content).digest('hex') };
}
const frontend = await readdir(join(root, 'apps/desktop/dist/assets'));
const manifest = {
  version, platform: 'windows-x64',
  commit: process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  builtAtUtc: new Date().toISOString(),
  installer: await fileInfo(installer),
  runtime: await fileInfo(join(root, '.generated/sidecar/runtime.mjs')),
  frontend: await Promise.all(frontend.map(name => fileInfo(join(root, 'apps/desktop/dist/assets', name)))),
  media: JSON.parse(await readFile(join(root, '.generated/sidecar/media/provenance.json'), 'utf8')),
  desktop: { framework: 'electron', version: JSON.parse(await readFile(join(root, 'apps/desktop/package.json'), 'utf8')).devDependencies.electron },
  tools: { node: process.version, pnpm: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).packageManager },
  verification: { automatedTests: unit.numPassedTests, packagedPdfTests: packaged.numPassedTests, browserFlows: browser.stats.expected, electronDesktop: electron, mediaScenarios: media.length, installation: installation ?? 'not-run', signature: 'not-signed' },
};
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
await copyFile(join(root, '.generated/sidecar/third-party-licenses/manifest.json'), join(output, 'third-party-licenses.json'));
console.log(`已生成交付清单：${join(output, 'manifest.json')}`);
