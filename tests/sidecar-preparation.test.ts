import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-sidecar-')); directories.push(directory);
  await mkdir(join(directory, 'scripts'));
  for (const name of ['prepare-sidecar.mjs', 'media-manifest.json']) await copyFile(resolve('scripts', name), join(directory, 'scripts', name));
  for (const name of ['apps', 'packages', 'node_modules']) await symlink(resolve(name), join(directory, name), 'dir');
  const env = { ...process.env }; delete env.VIDEO_QUICKLY_MEDIA_DIR;
  return { directory, env, command: join(directory, 'scripts', 'prepare-sidecar.mjs') };
}

describe.skipIf(process.platform === 'win32')('native development sidecar on Unix', () => {
  beforeAll(() => {
    const built = spawnSync(process.execPath, [resolve('scripts/build-runtime.mjs')], { encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
  });

  it('prepares a runnable local runtime without requiring Windows media executables', async () => {
    const { directory, env, command } = await fixture();
    const prepared = spawnSync(process.execPath, [command, '--development'], { env, encoding: 'utf8', timeout: 20_000 });
    expect(prepared.stderr).toBe('');
    expect(prepared.status).toBe(0);
    const sidecar = join(directory, '.generated', 'sidecar');
    expect(JSON.parse(await readFile(join(sidecar, 'runtime-info.json'), 'utf8'))).toMatchObject({ platform: process.platform, architecture: process.arch });
    const runtime = spawnSync(join(sidecar, 'node'), ['runtime.mjs', '--data-dir', join(directory, 'workspace')], { cwd: sidecar, env, encoding: 'utf8', input: '', timeout: 10_000 });
    expect(runtime.stderr).toBe(''); expect(runtime.status).toBe(0);
    expect(runtime.stdout).toContain('"method":"runtime.ready"');
  });

  it('still rejects a production bundle without its licensed media components', async () => {
    const { directory, env, command } = await fixture();
    const prepared = spawnSync(process.execPath, [command], { env, encoding: 'utf8', timeout: 20_000 });
    expect(prepared.status).not.toBe(0);
    expect(prepared.stderr).toContain('FFmpeg');
    expect(await readdir(join(directory, '.generated'))).not.toContain('sidecar');
  });
});
