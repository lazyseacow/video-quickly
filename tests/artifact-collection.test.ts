import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture(platform: 'win32' | 'darwin') {
  const directory = await mkdtemp(join(tmpdir(), 'vq-artifact-collection-')); directories.push(directory);
  async function file(path: string, content: string) {
    const target = join(directory, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
  }
  const report = (path: string, value: unknown) => file(`.generated/${path}`, JSON.stringify(value));
  const collector = platform === 'win32' ? 'collect-artifacts.mjs' : 'collect-macos-artifacts.mjs';
  await mkdir(join(directory, 'scripts'));
  for (const name of [collector, 'verified-download.mjs']) await copyFile(resolve('scripts', name), join(directory, 'scripts', name));
  await file('package.json', JSON.stringify({ version: '0.0.0-fixture', packageManager: 'pnpm@10.33.0' }));
  await file('apps/desktop/package.json', JSON.stringify({ devDependencies: { electron: 'fixture-electron' } }));
  await file('apps/desktop/dist/assets/app.js', 'fixture frontend');
  await file('.generated/sidecar/runtime.mjs', 'fixture runtime');
  await report('sidecar/media/provenance.json', { verified: true });
  await report('sidecar/third-party-licenses/manifest.json', []);

  // These inert bytes exercise collection and hash binding, never a package launch.
  const packageBytes = 'isolated collector package bytes';
  const packageSha256 = createHash('sha256').update(packageBytes).digest('hex');
  const packageName = platform === 'win32' ? 'fixture-setup.exe' : `Video-Quickly-0.0.0-fixture-macos-${process.arch}.zip`;
  await file(`.generated/electron-release/${packageName}`, packageBytes);
  const unit = { success: true, numPassedTests: 3, numPendingTests: platform === 'win32' ? 5 : 3, numFailedTests: 0, numFailedTestSuites: 0 };
  const browser = { stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 } };
  const checks: Record<string, boolean> = Object.fromEntries([
    'bundledTools', 'nativeBridge', 'sandbox', 'senderBoundary', 'nativeCredentialWriteRead', 'nativeCredentialRestart',
    'nativeCredentialReplacement', 'nativeCredentialDeletion', 'editHistory', 'platformShortcutHints', 'nativeTextEditing',
    'dialogBridge', 'directoryAndSaveDialogs', 'revealBridge', 'mediaRange', 'mediaBoundary', 'videoPreview', 'actualExport',
    'reconnect', 'cancelWindowClose', 'cancelQuit', 'macWindowReopen', 'macSecondInstance', 'confirmedQuit', 'restartRecovery', 'consoleHealth',
  ].map(name => [name, true]));
  const native = { status: 'passed', packaged: true, platform, architecture: process.arch, distributionScope: 'bundled-runtime-and-media', electron: 'fixture-electron', checks };
  const protectedFiles = Array.from({ length: 3 }, (_, index) => ({ path: `fixture-protected-${index}`, role: `role-${index}`, exists: true, bytes: 1, sha256: packageSha256 }));
  const installation = platform === 'win32' ? {
    installed: true, overwriteInstall: true, nativeLaunch: true, installedRuntime: true, actualExport: true, reviewResumed: true,
    uninstall: true, dataContentPreserved: true, explicitDataDeletion: true, installerSha256: packageSha256,
    deletionScope: { option: '--delete-electron-workspace', protectedDirectoriesPreserved: true, before: protectedFiles, afterDefault: protectedFiles, afterExplicit: protectedFiles },
  } : { status: 'passed', architecture: process.arch, dataContentPreserved: true, archiveSha256: packageSha256 };
  await report('test-results.json', unit); await report('browser-results.json', browser);
  await report('packaged-runtime-results.json', { success: true, numPassedTests: 2, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0 });
  await report('electron-results.json', native); await report('render-smoke/results.json', [{}, {}, {}, {}]);
  await report(platform === 'win32' ? 'install-smoke.json' : 'macos-install-smoke.json', installation);
  if (platform === 'darwin') await report('macos-portability.json', { status: 'passed', architecture: process.arch, sourceAndLicenseVerified: true, minimumSystemVersion: '13.5.0' });
  const run = () => spawnSync(process.execPath, [join(directory, 'scripts', collector)], { cwd: directory, env: { ...process.env, GITHUB_SHA: '1'.repeat(40) }, encoding: 'utf8', timeout: 10_000 });
  const manifest = join(directory, '.generated/release/manifest.json');
  return { directory, report, unit, browser, native, run, manifest, packageSha256 };
}

describe('Windows artifact collection gates', () => {
  it('collects passing browser and native evidence while retaining legitimate unit skips', async () => {
    const input = await fixture('win32'), result = input.run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(input.manifest, 'utf8'))).toMatchObject({ installer: { sha256: input.packageSha256 }, verification: { automatedTests: input.unit.numPassedTests, browserFlows: 2 } });
  });

  it.each([1, undefined])('rejects incomplete browser skip evidence (%s) before writing a release manifest', async skipped => {
    const input = await fixture('win32');
    await input.report('browser-results.json', { ...input.browser, stats: { ...input.browser.stats, skipped } });
    expect(input.run().status).toBe(1);
    expect(await stat(input.manifest).then(() => true, () => false)).toBe(false);
  });

  it('rejects missing native edit-history evidence despite a passed native summary', async () => {
    const input = await fixture('win32'); delete input.native.checks.editHistory;
    await input.report('electron-results.json', input.native);
    expect(input.run().status).toBe(1);
    expect(await stat(input.manifest).then(() => true, () => false)).toBe(false);
  });
});

describe.skipIf(process.platform !== 'darwin')('macOS artifact collection gates', () => {
  it('collects passing browser and native evidence while retaining legitimate unit skips', async () => {
    const input = await fixture('darwin'), result = input.run();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(await readFile(input.manifest, 'utf8'))).toMatchObject({ package: { sha256: input.packageSha256 }, verification: { automatedTests: input.unit.numPassedTests, browserFlows: 2 } });
  });

  it.each([1, undefined])('rejects incomplete browser skip evidence (%s) before writing a release manifest', async skipped => {
    const input = await fixture('darwin');
    await input.report('browser-results.json', { ...input.browser, stats: { ...input.browser.stats, skipped } });
    expect(input.run().status).toBe(1);
    expect(await stat(input.manifest).then(() => true, () => false)).toBe(false);
  });
});
