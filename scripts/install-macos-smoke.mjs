import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256File } from './verified-download.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'macOS' || process.platform !== 'darwin') throw new Error('此安装验收只允许全新隔离 macOS CI 账号');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const archive = join(root, `.generated/electron-release/Video-Quickly-${version}-macos-${process.arch}.zip`);
await stat(archive);
const data = join(homedir(), 'Library/Application Support/VideoQuickly-Electron');
if (await stat(data).then(() => true, () => false)) throw new Error('账号已有 Electron 项目数据，停止安装验收');
const temporary = await mkdtemp(join(await realpath(process.env.RUNNER_TEMP), 'vq-macos-install-'));
const extraction = join(temporary, '归档解压');
const installation = join(temporary, '中文 安装目录', 'Video Quickly.app');
const evidence = join(temporary, 'installed-fixture.json');
const environment = { ...process.env };
for (const key of ['VIDEO_QUICKLY_DATA_DIR','VIDEO_QUICKLY_ELECTRON_USER_DATA','VIDEO_QUICKLY_DEV_URL','ELECTRON_RUN_AS_NODE']) delete environment[key];
function run(script, args) { execFileSync(process.execPath, [join(root, 'scripts', script), ...args], { cwd: root, env: environment, stdio: 'inherit', timeout: 120_000 }); }
async function replaceApplication() {
  const difference = relative(temporary, installation);
  assert.ok(difference && !difference.startsWith('..'), 'Only replace this test installation');
  await rm(installation, { recursive: true, force: true });
  await cp(join(extraction, 'Video Quickly.app'), installation, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
}
async function snapshot(files) {
  return Promise.all(files.map(async ({ role, path, optional }) => {
    const information = await lstat(path).catch(() => undefined);
    if (!information && !optional) throw new Error(`保留数据缺失：${role}`);
    if (information) assert.ok(information.isFile() && !information.isSymbolicLink(), 'Fixture data must be regular files');
    return { role, exists: Boolean(information), bytes: information?.size ?? null, sha256: information ? await sha256File(path) : null };
  }));
}
let createdData = false;
try {
  execFileSync('/usr/bin/ditto', ['-x', '-k', archive, extraction]);
  await replaceApplication();
  createdData = true;
  run('installed-runtime-smoke.mjs', ['prepare', installation, data, evidence]);
  await replaceApplication();
  run('check-installed-electron.mjs', [installation, data]);
  run('installed-runtime-smoke.mjs', ['verify', installation, data, evidence]);
  await replaceApplication();
  run('check-installed-electron.mjs', [installation, data]);
  const fixture = JSON.parse(await readFile(evidence, 'utf8'));
  const image = await realpath(fixture.asset.path), assets = await realpath(join(data, 'projects', fixture.projectId, 'assets'));
  assert.ok(!relative(assets, image).startsWith('..'));
  const files = [{ role: 'database', path: join(data, 'workspace.sqlite') }, { role: 'database-wal', path: join(data, 'workspace.sqlite-wal'), optional: true }, { role: 'fixture-image', path: image }];
  const before = await snapshot(files);
  assert.equal(before[2].sha256, fixture.asset.sha256); assert.equal(before[2].bytes, fixture.asset.size);
  await rm(installation, { recursive: true });
  const after = await snapshot(files);
  assert.deepEqual(after, before, 'Removing a macOS app must retain workspace data byte-for-byte');
  await writeFile(join(root, '.generated/macos-install-smoke.json'), JSON.stringify({ status: 'passed', platform: 'darwin', architecture: process.arch, version, archiveSha256: await sha256File(archive), installed: true, overwriteInstall: true, nativeLaunch: true, runtimeExited: true, actualExport: true, reviewResumed: true, uninstall: true, dataContentPreserved: true, dataRetention: { before, after }, finderInteraction: 'filesystem ZIP extraction / app replacement; Finder UI not automated' }, null, 2));
  console.log('macOS ZIP 安装、覆盖、原待审任务继续、实际导出及移除应用保留数据通过。');
} finally {
  if (createdData) await rm(data, { recursive: true, force: true });
  await rm(temporary, { recursive: true, force: true });
}
