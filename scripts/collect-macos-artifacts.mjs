import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './verified-download.mjs';

if (process.platform !== 'darwin') throw new Error('macOS 交付清单需要对应原生平台');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function report(name) { return JSON.parse(await readFile(join(root, '.generated', name), 'utf8')); }
const [unit, browser, packaged, electron, media, portability, installation] = await Promise.all(['test-results.json','browser-results.json','packaged-runtime-results.json','electron-results.json','render-smoke/results.json','macos-portability.json','macos-install-smoke.json'].map(report));
assert.equal(unit.success, true); assert.equal(unit.numFailedTests, 0); assert.equal(unit.numFailedTestSuites, 0); assert.ok(unit.numPassedTests > 0);
assert.equal(browser.stats.unexpected, 0); assert.equal(browser.stats.flaky, 0); assert.ok(browser.stats.expected > 0);
assert.equal(packaged.success, true); assert.equal(packaged.numPassedTests, 2); assert.equal(packaged.numFailedTests, 0); assert.equal(packaged.numFailedTestSuites, 0); assert.equal(packaged.numPendingTests, 0);
assert.equal(electron.status, 'passed'); assert.equal(electron.packaged, true); assert.equal(electron.platform, 'darwin'); assert.equal(electron.architecture, process.arch); assert.equal(electron.distributionScope, 'bundled-runtime-and-media');
for (const name of ['nativeBridge','sandbox','senderBoundary','nativeCredentialWriteRead','nativeCredentialRestart','nativeCredentialReplacement','nativeCredentialDeletion','editHistory','platformShortcutHints','nativeTextEditing','dialogBridge','directoryAndSaveDialogs','revealBridge','mediaRange','mediaBoundary','videoPreview','actualExport','reconnect','cancelWindowClose','cancelQuit','macWindowReopen','macSecondInstance','confirmedQuit','restartRecovery','consoleHealth']) assert.equal(electron.checks[name], true, `Missing native evidence: ${name}`);
assert.ok(media.length >= 4); assert.equal(portability.status, 'passed'); assert.equal(portability.architecture, process.arch); assert.equal(portability.sourceAndLicenseVerified, true);
assert.equal(installation.status, 'passed'); assert.equal(installation.architecture, process.arch); assert.equal(installation.dataContentPreserved, true);
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const archive = join(root, `.generated/electron-release/Video-Quickly-${version}-macos-${process.arch}.zip`);
assert.equal(await sha256File(archive), installation.archiveSha256);
const output = join(root, '.generated/release'); await mkdir(output, { recursive: true });
const target = join(output, basename(archive)); await copyFile(archive, target);
const manifest = { version, platform: `macos-${process.arch}`, commit: process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), builtAtUtc: new Date().toISOString(), package: { name: basename(target), sha256: await sha256File(target) }, desktop: { framework: 'electron', version: electron.electron, minimumSystemVersion: portability.minimumSystemVersion }, verification: { automatedTests: unit.numPassedTests, browserFlows: browser.stats.expected, packagedPdfTests: packaged.numPassedTests, mediaScenarios: media.length, electronDesktop: electron, portability, installation, signature: 'not-signed' } };
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
await copyFile(join(root, '.generated/sidecar/third-party-licenses/manifest.json'), join(output, 'third-party-licenses.json'));
console.log(`Verified macOS ${process.arch} ZIP and manifest collected.`);
