import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { upgradeBaseline, verifyBaselineMetadata, verifyInstallerManifest } from '../scripts/verify-upgrade-artifact.mjs';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const metadata = () => ({ artifact: { id: upgradeBaseline.artifactId, name: upgradeBaseline.artifactName, digest: upgradeBaseline.artifactDigest, expired: false, workflow_run: { id: upgradeBaseline.runId, head_sha: upgradeBaseline.commit } }, run: { id: upgradeBaseline.runId, head_sha: upgradeBaseline.commit, head_repository: { full_name: upgradeBaseline.repository }, conclusion: 'success' } });

it('pins the successful old build, artifact identity and full archive digest without substituting another version', () => {
  const original = metadata(); expect(verifyBaselineMetadata(original.artifact, original.run)).toEqual(original);
  for (const mutate of [
    (value: ReturnType<typeof metadata>) => { value.artifact.expired = true; },
    (value: ReturnType<typeof metadata>) => { value.artifact.digest = 'sha256:' + '0'.repeat(64); },
    (value: ReturnType<typeof metadata>) => { value.run.head_sha = '0'.repeat(40); },
    (value: ReturnType<typeof metadata>) => { value.artifact.workflow_run.id++; },
    (value: ReturnType<typeof metadata>) => { value.run.conclusion = 'failure'; },
  ]) { const value = metadata(); mutate(value); expect(() => verifyBaselineMetadata(value.artifact, value.run)).toThrow(); }
});

it('checks the extracted installer bytes against its pinned commit and version manifest before any execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-upgrade-artifact-')); directories.push(directory); await mkdir(join(directory, 'release'));
  const bytes = Buffer.from('Fixture installer bytes; this file is never executed.');
  const manifest = { version: upgradeBaseline.version, commit: upgradeBaseline.commit, platform: 'windows-x64', installer: { name: `Video-Quickly-${upgradeBaseline.version}-windows-x64-setup.exe`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
  const manifestPath = join(directory, 'release', 'manifest.json'), path = join(directory, 'release', manifest.installer.name);
  await writeFile(manifestPath, JSON.stringify(manifest)); await writeFile(path, bytes);
  expect(await verifyInstallerManifest(directory, upgradeBaseline)).toMatchObject({ path: await realpath(path), version: '0.1.0', sha256: manifest.installer.sha256 });
  await expect(verifyInstallerManifest(directory, { ...upgradeBaseline, version: '0.1.1' })).rejects.toThrow('版本');
  await writeFile(path, Buffer.alloc(bytes.length)); await expect(verifyInstallerManifest(directory, upgradeBaseline)).rejects.toThrow('SHA-256');
  await writeFile(manifestPath, JSON.stringify({ ...manifest, installer: { ...manifest.installer, name: '../outside.exe' } })); await expect(verifyInstallerManifest(directory, upgradeBaseline)).rejects.toThrow('文件名');
});

it('keeps the root package, desktop package, Tauri product and Rust package versions consistent', async () => {
  const files = await Promise.all(['package.json', 'apps/desktop/package.json', 'apps/desktop/src-tauri/tauri.conf.json'].map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const version = files[0].version; expect(files.map(file => file.version)).toEqual([version, version, version]); expect(version).not.toBe(upgradeBaseline.version);
  expect(await readFile('apps/desktop/src-tauri/Cargo.toml', 'utf8')).toContain(`version = "${version}"`);
  expect(await readFile('apps/desktop/src-tauri/Cargo.lock', 'utf8')).toContain(`name = "video-quickly"\nversion = "${version}"`);
});
