import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDarwinBinarySelfContained } from './node-portability.mjs';
import { sha256File } from './verified-download.mjs';

if (process.platform !== 'darwin') throw new Error('Mach-O bundle 验收需要 macOS');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const application = process.argv[2] ? resolve(process.argv[2]) : join(root, `.generated/electron-release/mac${process.arch === 'arm64' ? '-arm64' : ''}/Video Quickly.app`);
const resources = join(application, 'Contents/Resources'), sidecar = join(resources, 'sidecar');
const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const info = JSON.parse(await readFile(join(sidecar, 'runtime-info.json'), 'utf8'));
assert.equal(info.architecture, process.arch); assert.equal(info.platform, 'darwin'); assert.equal(info.portability, 'bundled');
const nodeManifest = JSON.parse(await readFile(join(root, 'scripts/node-manifest.json'), 'utf8'));
assert.equal(info.nodeVersion, nodeManifest.version); assert.equal(info.nodeProvenance.sha256, nodeManifest.darwin[process.arch].sha256); assert.equal(info.nodeProvenance.verified, true);
const mediaManifest = JSON.parse(await readFile(join(root, 'scripts/macos-media-manifest.json'), 'utf8'));
const media = JSON.parse(await readFile(join(sidecar, 'media/provenance.json'), 'utf8'));
assert.equal(media.version, mediaManifest.version); assert.deepEqual(media.sourceFiles, mediaManifest.supportFiles);
assert.equal(media.architecture, process.arch); assert.equal(media.verified, true); assert.equal(media.license, 'GPL-3.0-or-later');
const minimum = execFileSync('/usr/bin/plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', join(application, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
function versionNumber(value) { const [major = 0, minor = 0, patch = 0] = value.split('.').map(Number); return major * 1_000_000 + minor * 1_000 + patch; }
const measurements = [];
async function inspect(path, strict) {
  const metadata = await lstat(path); assert.equal(metadata.isSymbolicLink(), false, 'Distributed executable must not reference a developer path');
  const architectures = execFileSync('/usr/bin/lipo', ['-archs', path], { encoding: 'utf8' }).trim().split(/\s+/);
  assert.ok(architectures.includes(architecture), `Missing native architecture in ${path}`);
  const target = execFileSync('/usr/bin/vtool', ['-show-build', path], { encoding: 'utf8' });
  const versions = [...target.matchAll(/\bminos\s+(\d+(?:\.\d+){0,2})/g)].map(match => match[1]);
  if (!versions.length) versions.push(...[...target.matchAll(/\bversion\s+(\d+(?:\.\d+){0,2})/g)].map(match => match[1]));
  assert.ok(versions.length, 'Mach-O deployment target must be observable');
  for (const version of versions) assert.ok(versionNumber(version) <= versionNumber(minimum), `Bundle promises macOS ${minimum}, but ${path} requires ${version}`);
  // Electron's own helpers legitimately link its bundled Framework. Enforce
  // system-only linkage on our independent runtime and native modules.
  if (strict) {
    const identity = execFileSync('/usr/bin/otool', ['-D', path], { encoding: 'utf8' }).split('\n').slice(1).map(line => line.trim()).find(Boolean);
    assertDarwinBinarySelfContained(execFileSync('/usr/bin/otool', ['-L', path], { encoding: 'utf8' }), path.slice(application.length + 1), identity);
  }
  measurements.push({ path: path.slice(application.length + 1), architectures, minimumVersions: versions, systemLibrariesOnly: strict, sha256: await sha256File(path) });
}
for (const name of ['node', 'media/ffmpeg', 'media/ffprobe']) {
  const path = join(sidecar, name); await inspect(path, true);
  if (name === 'node') assert.equal(await sha256File(path), nodeManifest.darwin[process.arch].binarySha256, 'Node bytes must match the fixed official binary');
  if (name.startsWith('media/')) {
    assert.equal(await sha256File(path), media.binaries[name.split('/')[1]].binarySha256, 'Media bytes must match the verified distribution');
    assert.equal(await sha256File(path), mediaManifest[process.arch][name.split('/')[1]].binarySha256);
    const version = execFileSync(path, ['-version'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    const license = execFileSync(path, ['-L'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
    assert.ok(version.includes(` version ${mediaManifest.version}-`) && !version.includes('--enable-nonfree'));
    assert.ok(license.includes('GNU General Public License') && license.includes('version 3'));
  }
}
async function nativeFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { await nativeFiles(path); continue; }
    if (!entry.isFile() || ['node', 'ffmpeg', 'ffprobe'].includes(entry.name) && path.startsWith(sidecar)) continue;
    const file = await open(path, 'r'); let magic;
    try { const buffer = Buffer.alloc(4); const read = await file.read(buffer, 0, 4, 0); if (read.bytesRead === 4) magic = buffer.readUInt32BE(); } finally { await file.close(); }
    if ([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface, 0xcafebabe, 0xcafebabf, 0xbebafeca].includes(magic)) await inspect(path, entry.name.endsWith('.node'));
  }
}
await nativeFiles(join(application, 'Contents'));
const portableEnvironment = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
delete portableEnvironment.NODE_PATH; delete portableEnvironment.NODE_OPTIONS;
const dependencies = JSON.parse(execFileSync(join(sidecar, 'node'), ['--input-type=commonjs', '-e', "const Database=require('better-sqlite3');const db=new Database(':memory:');const row=db.prepare('select 1 as value').get();db.close();const canvas=require('@napi-rs/canvas').createCanvas(2,2);console.log(JSON.stringify({node:process.version,arch:process.arch,sqlite:row.value===1,canvas:canvas.width===2}))"], { cwd: sidecar, env: portableEnvironment, encoding: 'utf8' }));
assert.equal(dependencies.sqlite, true); assert.equal(dependencies.canvas, true); assert.equal(dependencies.node, nodeManifest.version); assert.equal(dependencies.arch, process.arch);
for (const resource of media.sourceFiles) assert.equal(await sha256File(join(sidecar, 'media/source', resource.name)), resource.sha256, 'Corresponding source / license bytes must match the locked source');
const report = { status: 'passed', platform: 'darwin', architecture: process.arch, minimumSystemVersion: minimum, portableNode: true, staticMedia: true, nativeDependencies: dependencies, sourceAndLicenseVerified: true, measurements, signature: 'not-signed' };
await writeFile(join(root, '.generated/macos-portability.json'), JSON.stringify(report, null, 2));
console.log(`macOS ${process.arch} portability passed: ${measurements.length} Mach-O files; minimum ${minimum}; standalone Node / FFmpeg / ffprobe and native dependencies.`);
