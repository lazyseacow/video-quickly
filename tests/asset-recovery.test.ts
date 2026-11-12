import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AssetRecord } from '@video-quickly/contracts';
import { assetRecoveryJobSchema, assetRecoveryPageSchema, type AssetRecoveryItem } from '../src/packages/contracts/src/asset-recovery';
import { createAssetRecovery, type AssetRecoveryOptions } from '../src/packages/runtime/src/asset-recovery';
import { DocumentStore, openDatabase } from '../src/packages/runtime/src/database';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const work of cleanup.splice(0).reverse()) await work(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-asset-recovery-')), workspace = join(directory, '工作区 with spaces'), source = join(directory, '扫描 source');
  await mkdir(workspace); await mkdir(source);
  const database = openDatabase(workspace), store = new DocumentStore(database);
  const options: AssetRecoveryOptions = { directory: workspace, store };
  let manager = createAssetRecovery(options);
  cleanup.push(async () => { await manager.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
  async function asset(id: string, bytes = `原始 bytes ${id}`, path = join(workspace, 'projects', 'project', 'assets', `${id}.png`)) {
    const value: AssetRecord = { id, name: `${id}.png`, path, kind: 'image', mimeType: 'image/png', projectId: 'project', size: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: '真实文件恢复夹具', active: true, retained: false };
    store.put('asset', id, value); return { value, bytes };
  }
  const page = async (jobId: string) => assetRecoveryPageSchema.parse(await manager.dispatch('asset.recovery.get', { jobId }));
  const check = async () => { const job = assetRecoveryJobSchema.parse(await manager.dispatch('asset.recovery.start')); await manager.waitForIdle(); return page(job.id); };
  const scan = async (jobId: string) => { await manager.dispatch('asset.recovery.scan', { jobId, directory: source }); await manager.waitForIdle(); return page(jobId); };
  const confirm = async (jobId: string, items: AssetRecoveryItem[]) => { await manager.dispatch('asset.recovery.confirm', { jobId, selections: items.map(item => ({ itemId: item.id, candidateId: item.candidates[0].id })) }); await manager.waitForIdle(); return page(jobId); };
  return { directory, workspace, source, database, store, options, asset, page, check, scan, confirm, manager: () => manager, async restart() { await manager.close(); manager = createAssetRecovery(options); await manager.waitForIdle(); } };
}

describe('managed asset recovery', () => {
  it('keeps inventory and scan persistence proportional to the complete list while reporting live progress', async () => {
    const f = await fixture();
    for (let index = 0; index < 100; index++) { await f.asset(`persistence-${index}`, 'missing'); await writeFile(join(f.source, `${index}.bin`), 'source!'); }
    let written = 0;
    const put = f.store.put.bind(f.store);
    f.store.put = (kind, id, value) => { put(kind, id, value); if (kind === 'asset-recovery-job') written += Buffer.byteLength(JSON.stringify(value)); };
    const checked = await f.check(), checkBytes = written;
    const scanned = await f.scan(checked.job.id), scanBytes = written - checkBytes;
    const completeBytes = Buffer.byteLength(JSON.stringify(f.store.get('asset-recovery-job', checked.job.id)));
    expect(scanned.job.progress).toMatchObject({ checked: 100, total: 100, scanned: 100, hashed: 100 });
    expect.soft(checkBytes, `inventory wrote ${checkBytes} bytes for a ${completeBytes}-byte list`).toBeLessThan(completeBytes * 2 + 4096);
    expect.soft(scanBytes, `scan wrote ${scanBytes} bytes for a ${completeBytes}-byte list`).toBeLessThan(completeBytes * 4 + 4096);
  });

  it('pages the complete inventory, explains a current dangling reference and rejects a page from an older scan generation', async () => {
    const f = await fixture(); for (let index = 0; index < 101; index++) await f.asset(`page-${index}`);
    const project = projectSchema.parse({ id: 'current', title: '当前项目', brief: '', revision: 1, createdAt: '', updatedAt: '', profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), shots: [{ id: 'shot', title: '镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, assetId: 'missing-record' }] });
    f.store.put('project', project.id, project);
    const first = await f.check(); expect(first.items).toHaveLength(100); expect(first.nextOffset).toBe(100); expect(first.job.progress.total).toBe(102);
    const last = assetRecoveryPageSchema.parse(await f.manager().dispatch('asset.recovery.get', { jobId: first.job.id, generation: first.job.generation, offset: first.nextOffset }));
    expect(last.nextOffset).toBeNull(); expect(last.items.find(item => item.assetId === 'missing-record')).toMatchObject({ status: 'invalid_metadata', expected: null, sources: [{ kind: 'project', id: 'current' }] });
    await f.scan(first.job.id); await expect(f.manager().dispatch('asset.recovery.get', { jobId: first.job.id, generation: first.job.generation, offset: 100 })).rejects.toThrow('第一页');
  });

  it('lists missing, altered, unsafe and conflicting identities without hiding current or frozen history references', async () => {
    const f = await fixture(), missing = await f.asset('missing'), altered = await f.asset('altered'), outside = await f.asset('outside', 'outside', join(f.directory, 'outside.png'));
    await mkdir(dirname(altered.value.path), { recursive: true }); await writeFile(altered.value.path, 'different bytes');
    f.store.put('run-snapshot', 'old-run', { project: { id: 'project' }, assets: [missing.value], characterAssets: [{ ...missing.value, id: 'shared-old', projectId: undefined, path: join(f.workspace, 'projects', 'old', 'assets', 'shared.png') }] });
    f.store.put('export-batch-snapshot', 'frozen-export', { project: { id: 'project' }, assets: [{ ...altered.value, sha256: 'f'.repeat(64) }], characterAssets: [] });
    const result = await f.check();
    expect(result.job.phase).toBe('awaiting_directory');
    expect(result.items.find(item => item.assetId === missing.value.id)).toMatchObject({ status: 'missing', sources: expect.arrayContaining([{ kind: 'asset', id: 'missing', active: true }, { kind: 'run-snapshot', id: 'old-run' }]) });
    expect(result.items.find(item => item.assetId === 'shared-old')).toMatchObject({ status: 'missing', sources: [{ kind: 'run-snapshot', id: 'old-run' }] });
    expect(result.items.filter(item => item.assetId === altered.value.id).every(item => item.status === 'conflict' && item.detail)).toBe(true);
    expect(result.items.find(item => item.assetId === outside.value.id)).toMatchObject({ status: 'unsafe_path', detail: expect.any(String) });
  });

  it('matches renamed files by complete hash and size, retains shared IDs and frozen metadata, and rejects a same-name substitute', async () => {
    const f = await fixture(), first = await f.asset('first', 'a'.repeat(70_000) + 'ORIGINAL' + 'z'.repeat(70_000)), shared = await f.asset('shared', first.bytes);
    const frozen = { project: { id: 'project' }, assets: [first.value, shared.value], characterAssets: [shared.value] }; f.store.put('run-snapshot', 'old', frozen);
    const wrong = Buffer.from(first.bytes); wrong[80_000] = 0x78;
    await writeFile(join(f.source, first.value.name), wrong); await mkdir(join(f.source, 'nested')); await writeFile(join(f.source, 'nested', '改名文件.bin'), first.bytes);
    const checked = await f.check(), scanned = await f.scan(checked.job.id);
    expect(scanned.job.phase).toBe('awaiting_confirmation'); expect(scanned.job.progress.hashed).toBeGreaterThan(0);
    const items = scanned.items.filter(item => item.status === 'missing'); expect(items).toHaveLength(2);
    expect(items.every(item => item.candidates.length === 1 && item.candidates[0].path.endsWith('改名文件.bin'))).toBe(true);
    const done = await f.confirm(checked.job.id, items); expect(done.job.phase).toBe('succeeded'); expect(done.job.progress.restored).toBe(2);
    for (const asset of [first, shared]) { expect(await readFile(asset.value.path, 'utf8')).toBe(first.bytes); expect(f.store.get('asset', asset.value.id)).toEqual(asset.value); }
    expect(f.store.get('run-snapshot', 'old')).toEqual(frozen);
    expect((await f.check()).items.every(item => item.status === 'available')).toBe(true);
  });

  it('rechecks candidates, source boundaries and current identities before publishing', async () => {
    const f = await fixture(), asset = await f.asset('race'); const source = join(f.source, 'candidate'); await writeFile(source, asset.bytes);
    const checked = await f.check(), scanned = await f.scan(checked.job.id), item = scanned.items[0];
    await expect(f.manager().dispatch('asset.recovery.confirm', { jobId: checked.job.id, selections: [{ itemId: item.id, candidateId: 'not-from-this-job' }] })).rejects.toThrow('候选');
    await writeFile(source, 'changed after scan'); expect((await f.confirm(checked.job.id, [item])).job).toMatchObject({ phase: 'failed', error: expect.any(String) });
    await expect(stat(asset.value.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(source, asset.bytes); const rescanned = await f.scan(checked.job.id);
    f.store.put('asset', asset.value.id, { ...asset.value, version: 2 });
    expect((await f.confirm(checked.job.id, rescanned.items)).job).toMatchObject({ phase: 'failed', error: expect.stringContaining('变化') });
    await expect(stat(asset.value.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites an existing wrong target and rolls back this batch after a later publication failure', async () => {
    const f = await fixture(), first = await f.asset('rollback-1'), second = await f.asset('rollback-2');
    for (const asset of [first, second]) await writeFile(join(f.source, asset.value.name), asset.bytes);
    const checked = await f.check(), scanned = await f.scan(checked.job.id);
    let published = 0; f.options.failpoint = point => { if (point === 'repair:published' && ++published === 1) throw new Error('隔离发布失败'); };
    const failed = await f.confirm(checked.job.id, scanned.items); expect(failed.job).toMatchObject({ phase: 'failed', error: expect.stringContaining('隔离发布失败') }); expect(failed.items.every(item => item.status === 'missing')).toBe(true);
    for (const asset of [first, second]) await expect(stat(asset.value.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(f.workspace, { recursive: true })).some(name => name.includes('.recovery-'))).toBe(false);
    f.options.failpoint = undefined; const retry = await f.scan(checked.job.id); await mkdir(dirname(first.value.path), { recursive: true }); await writeFile(first.value.path, 'foreign bytes');
    expect((await f.confirm(checked.job.id, retry.items)).job.phase).toBe('failed'); expect(await readFile(first.value.path, 'utf8')).toBe('foreign bytes');
    await expect(stat(second.value.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('revalidates staged bytes immediately before publication', async () => {
    const f = await fixture(), asset = await f.asset('staged-race'); await writeFile(join(f.source, 'candidate'), asset.bytes);
    const checked = await f.check(), scanned = await f.scan(checked.job.id);
    f.options.failpoint = async (point, context) => {
      if (point !== 'repair:before-publish') return;
      const file = (await readdir(dirname(context.path))).find(name => name.startsWith('.recovery-'))!;
      await writeFile(join(dirname(context.path), file), 'changed staged bytes');
    };
    expect((await f.confirm(checked.job.id, scanned.items)).job).toMatchObject({ phase: 'failed', error: expect.stringContaining('校验') });
    await expect(stat(asset.value.path)).rejects.toMatchObject({ code: 'ENOENT' }); expect(f.store.get('asset', asset.value.id)).toEqual(asset.value);
  });

  it('restores one physical file shared by current and frozen versions while retaining every identity', async () => {
    const f = await fixture(), asset = await f.asset('shared-version'), current = { ...asset.value, version: 2 };
    f.store.put('asset', asset.value.id, current); f.store.put('run-snapshot', 'version-one', { project: { id: 'project' }, assets: [asset.value] });
    await writeFile(join(f.source, 'candidate'), asset.bytes);
    const checked = await f.check(), scanned = await f.scan(checked.job.id); expect(scanned.items).toHaveLength(2);
    let published = 0; f.options.failpoint = point => { if (point === 'repair:published') published++; };
    const result = await f.confirm(checked.job.id, scanned.items);
    expect(result.job).toMatchObject({ phase: 'succeeded', progress: expect.objectContaining({ restored: 2 }) }); expect(published).toBe(1);
    expect(result.items.every(item => item.status === 'restored')).toBe(true); expect(await readFile(asset.value.path, 'utf8')).toBe(asset.bytes);
    expect(f.store.get('asset', asset.value.id)).toEqual(current); expect(f.store.get<{ assets: AssetRecord[] }>('run-snapshot', 'version-one')?.assets).toEqual([asset.value]);
  });

  it.each([false, true])('preserves an external in-place write and never reports it restored (later failure: %s)', async laterFailure => {
    const f = await fixture(), asset = await f.asset(`in-place-${laterFailure}`); await writeFile(join(f.source, 'candidate'), asset.bytes);
    const checked = await f.check(), scanned = await f.scan(checked.job.id);
    f.options.failpoint = async (point, context) => {
      if (point !== 'repair:published') return;
      const before = await stat(context.path); await writeFile(context.path, '外部原地写入的新内容'); const after = await stat(context.path);
      expect(after.ino).toBe(before.ino);
      if (laterFailure) throw new Error('原地写入后的隔离失败');
    };
    const result = await f.confirm(checked.job.id, scanned.items);
    expect(result.job.phase).toBe('failed'); expect(await readFile(asset.value.path, 'utf8')).toBe('外部原地写入的新内容');
    expect(result.items[0].status).toBe('conflict'); expect(result.job.warningCount).toBeGreaterThan(0);
  });

  it('rechecks every selected identity at the batch commit boundary and never removes an external replacement during rollback', async () => {
    const f = await fixture(), a = await f.asset('last-check-1'), b = await f.asset('last-check-2');
    for (const asset of [a, b]) await writeFile(join(f.source, asset.value.name), asset.bytes);
    const checked = await f.check(), scanned = await f.scan(checked.job.id); let published = 0;
    f.options.failpoint = point => { if (point === 'repair:published' && ++published === 2) f.store.put('asset', a.value.id, { ...a.value, version: 2 }); };
    expect((await f.confirm(checked.job.id, scanned.items)).job).toMatchObject({ phase: 'failed', error: expect.stringContaining('变化') });
    for (const asset of [a, b]) await expect(stat(asset.value.path)).rejects.toMatchObject({ code: 'ENOENT' });
    f.store.put('asset', a.value.id, a.value); const rescanned = await f.scan(checked.job.id);
    f.options.failpoint = async (point, context) => { if (point === 'repair:published') { await rm(context.path); await writeFile(context.path, '外部操作的新内容'); throw new Error('隔离外部替换'); } };
    const result = await f.confirm(checked.job.id, rescanned.items);
    expect(result.job.phase).toBe('failed'); expect(result.job.warningCount).toBeGreaterThan(0); expect(await readFile(a.value.path, 'utf8')).toBe('外部操作的新内容');
    expect(result.items.find(item => item.assetId === a.value.id)?.status).toBe('conflict');
  });

  it('cancels scanning and staged copying, closes its work, and leaves original records and files untouched', async () => {
    const f = await fixture(), asset = await f.asset('cancel'); await writeFile(join(f.source, 'candidate'), asset.bytes);
    let release!: () => void, entered!: () => void;
    let gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    f.options.failpoint = async point => { if (point === 'scan:file') { entered(); await gate; } };
    const checked = await f.check(); await f.manager().dispatch('asset.recovery.scan', { jobId: checked.job.id, directory: f.source }); await ready;
    await f.manager().dispatch('asset.recovery.cancel', { jobId: checked.job.id }); release(); await f.manager().waitForIdle();
    expect((await f.page(checked.job.id)).job.phase).toBe('canceled'); await expect(stat(asset.value.path)).rejects.toMatchObject({ code: 'ENOENT' });
    f.options.failpoint = undefined; const scanned = await f.scan(checked.job.id);
    gate = new Promise<void>(resolve => { release = resolve; }); ready = new Promise<void>(resolve => { entered = resolve; });
    f.options.failpoint = async point => { if (point === 'repair:staged') { entered(); await gate; } };
    await f.manager().dispatch('asset.recovery.confirm', { jobId: checked.job.id, selections: scanned.items.map(item => ({ itemId: item.id, candidateId: item.candidates[0].id })) }); await ready;
    await f.manager().dispatch('asset.recovery.cancel', { jobId: checked.job.id }); release(); await f.manager().waitForIdle();
    expect((await f.page(checked.job.id)).job.phase).toBe('canceled'); await expect(stat(asset.value.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.store.get('asset', asset.value.id)).toEqual(asset.value);
    expect((await readdir(f.workspace, { recursive: true })).some(name => name.includes('.recovery-'))).toBe(false);
  });

  it('refuses symlink targets and does not follow nested scan symlinks outside the selected root', async () => {
    const f = await fixture(), asset = await f.asset('link'); await mkdir(join(f.workspace, 'projects', 'project'), { recursive: true });
    await symlink(f.source, dirname(asset.value.path), process.platform === 'win32' ? 'junction' : 'dir');
    const checked = await f.check(); expect(checked.items[0]).toMatchObject({ status: 'unsafe_path', detail: expect.any(String) });
    await rm(dirname(asset.value.path));
    const outside = join(f.directory, 'private'); await mkdir(outside); await writeFile(join(outside, 'candidate'), asset.bytes);
    await symlink(outside, join(f.source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const scanned = await f.scan(checked.job.id); expect(scanned.items[0].candidates).toEqual([]); expect(scanned.job.warningCount).toBeGreaterThan(0);
  });

  it.skipIf(process.platform === 'win32')('reports genuine read and target write permission failures', async () => {
    const f = await fixture(), asset = await f.asset('permissions'); await mkdir(dirname(asset.value.path), { recursive: true }); await writeFile(asset.value.path, asset.bytes);
    await chmod(asset.value.path, 0);
    try { const checked = await f.check(); expect(checked.items[0]).toMatchObject({ status: 'unreadable', detail: expect.any(String) }); }
    finally { await chmod(asset.value.path, 0o600); }
    await rm(asset.value.path); await writeFile(join(f.source, 'candidate'), asset.bytes); const checked = await f.check(), scanned = await f.scan(checked.job.id);
    await chmod(dirname(asset.value.path), 0o500);
    try { expect((await f.confirm(checked.job.id, scanned.items)).job).toMatchObject({ phase: 'failed', error: expect.any(String) }); await expect(stat(asset.value.path)).rejects.toMatchObject({ code: 'ENOENT' }); }
    finally { await chmod(dirname(asset.value.path), 0o700); }
  });

  it.skipIf(process.platform === 'win32')('retains unfinished cleanup and continues the same task after its directory becomes writable', async () => {
    const f = await fixture(), asset = await f.asset('cleanup-retry'); await writeFile(join(f.source, 'candidate'), asset.bytes);
    const checked = await f.check(), scanned = await f.scan(checked.job.id);
    f.options.failpoint = async (point, context) => { if (point === 'repair:staged') { await chmod(dirname(context.path), 0o500); throw new Error('暂存后目录变为只读'); } };
    try {
      const failed = await f.confirm(checked.job.id, scanned.items);
      expect(failed.job).toMatchObject({ phase: 'failed', warningCount: expect.any(Number) }); expect(failed.job.warningCount).toBeGreaterThan(0);
      expect((await readdir(dirname(asset.value.path))).some(name => name.startsWith('.recovery-'))).toBe(true);
      await f.restart();
      expect((await f.page(checked.job.id)).job.warningCount).toBeGreaterThan(0);
    } finally { await chmod(dirname(asset.value.path), 0o700); }
    f.options.failpoint = undefined;
    const rescanned = await f.scan(checked.job.id), done = await f.confirm(checked.job.id, rescanned.items);
    expect(done.job.phase).toBe('succeeded'); expect(await readFile(asset.value.path, 'utf8')).toBe(asset.bytes);
    expect((await readdir(dirname(asset.value.path))).some(name => name.startsWith('.recovery-'))).toBe(false);
  });

  it.each(['repair:staged', 'repair:published'])('releases job resources and reports real journal write failure at %s', async point => {
    const f = await fixture(), asset = await f.asset(`journal-${point.replaceAll(':', '-')}`); await writeFile(join(f.source, 'candidate'), asset.bytes); await f.manager().close();
    const script = `import {createAssetRecovery} from ${JSON.stringify(pathToFileURL(resolve('src/packages/runtime/src/asset-recovery.ts')).href)}; import {openDatabase,DocumentStore} from ${JSON.stringify(pathToFileURL(resolve('src/packages/runtime/src/database.ts')).href)}; import {existsSync} from 'node:fs'; const db=openDatabase(${JSON.stringify(f.workspace)}); let unhandled=false; process.on('unhandledRejection',()=>{unhandled=true}); const manager=createAssetRecovery({directory:${JSON.stringify(f.workspace)},store:new DocumentStore(db),failpoint(point){if(point===${JSON.stringify(point)})db.pragma('query_only = ON')}}); const j=await manager.dispatch('asset.recovery.start'); await manager.waitForIdle(); await manager.dispatch('asset.recovery.scan',{jobId:j.id,directory:${JSON.stringify(f.source)}}); await manager.waitForIdle(); const p=await manager.dispatch('asset.recovery.get',{jobId:j.id}); await manager.dispatch('asset.recovery.confirm',{jobId:j.id,selections:p.items.map(item=>({itemId:item.id,candidateId:item.candidates[0].id}))}); await manager.waitForIdle(); const result=await manager.dispatch('asset.recovery.get',{jobId:j.id}); await manager.close(); await new Promise(resolve=>setImmediate(resolve)); process.stdout.write(JSON.stringify({phase:result.job.phase,error:result.job.error,exists:existsSync(${JSON.stringify(asset.value.path)}),unhandled})); db.pragma('query_only = OFF'); db.close();`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: resolve('.'), encoding: 'utf8', timeout: 3_000 });
    expect(child.error, child.stderr).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ phase: 'failed', error: expect.stringContaining('状态写入失败'), exists: false, unhandled: false });
  });

  it('continues the same job after a real process exits after exclusive creation and before ownership is journaled', async () => {
    const f = await fixture(), asset = await f.asset('opened-crash'); await writeFile(join(f.source, 'candidate'), asset.bytes); await f.manager().close();
    const script = `import {createAssetRecovery} from ${JSON.stringify(pathToFileURL(resolve('src/packages/runtime/src/asset-recovery.ts')).href)}; import {openDatabase,DocumentStore} from ${JSON.stringify(pathToFileURL(resolve('src/packages/runtime/src/database.ts')).href)}; const db=openDatabase(${JSON.stringify(f.workspace)}); const manager=createAssetRecovery({directory:${JSON.stringify(f.workspace)},store:new DocumentStore(db),failpoint(point){if(point==='repair:opened')process.exit(23)}}); const j=await manager.dispatch('asset.recovery.start'); process.stdout.write(j.id+'\\n'); await manager.waitForIdle(); await manager.dispatch('asset.recovery.scan',{jobId:j.id,directory:${JSON.stringify(f.source)}}); await manager.waitForIdle(); const p=await manager.dispatch('asset.recovery.get',{jobId:j.id}); await manager.dispatch('asset.recovery.confirm',{jobId:j.id,selections:p.items.map(item=>({itemId:item.id,candidateId:item.candidates[0].id}))}); await manager.waitForIdle(); process.exit(24);`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: resolve('.'), encoding: 'utf8', timeout: 3_000 });
    expect(child.status, child.stderr).toBe(23); const jobId = child.stdout.trim(); await f.restart();
    const recovered = await f.page(jobId); expect(recovered.job).toMatchObject({ phase: 'interrupted', warningCount: expect.any(Number) });
    const remaining = (await readdir(dirname(asset.value.path))).filter(name => name.startsWith('.recovery-')); expect(remaining).toHaveLength(1);
    const abandoned = join(dirname(asset.value.path), remaining[0]); await writeFile(abandoned, '无法证明归属的残留不得删除');
    const scanned = await f.scan(jobId), done = await f.confirm(jobId, scanned.items);
    expect(done.job.phase).toBe('succeeded'); expect(await readFile(asset.value.path, 'utf8')).toBe(asset.bytes);
    expect(await readFile(abandoned, 'utf8')).toBe('无法证明归属的残留不得删除'); expect(done.job.warningCount).toBeGreaterThan(0);
  });

  it('continues safely after a real child process exits during publication without changing old snapshots', async () => {
    const f = await fixture(), a = await f.asset('crash-1'), b = await f.asset('crash-2');
    for (const asset of [a, b]) await writeFile(join(f.source, asset.value.name), asset.bytes);
    const frozen = { project: { id: 'project' }, assets: [a.value, b.value] }; f.store.put('run-snapshot', 'frozen', frozen); await f.manager().close();
    const script = `import {createAssetRecovery} from ${JSON.stringify(pathToFileURL(resolve('src/packages/runtime/src/asset-recovery.ts')).href)}; import {openDatabase,DocumentStore} from ${JSON.stringify(pathToFileURL(resolve('src/packages/runtime/src/database.ts')).href)}; const db=openDatabase(${JSON.stringify(f.workspace)}); const manager=createAssetRecovery({directory:${JSON.stringify(f.workspace)},store:new DocumentStore(db),failpoint(point){if(point==='repair:published')process.exit(23)}}); const j=await manager.dispatch('asset.recovery.start'); await manager.waitForIdle(); await manager.dispatch('asset.recovery.scan',{jobId:j.id,directory:${JSON.stringify(f.source)}}); await manager.waitForIdle(); const p=await manager.dispatch('asset.recovery.get',{jobId:j.id}); await manager.dispatch('asset.recovery.confirm',{jobId:j.id,selections:p.items.map(item=>({itemId:item.id,candidateId:item.candidates[0].id}))}); await manager.waitForIdle(); process.exit(24);`;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: resolve('.'), encoding: 'utf8', timeout: 15_000 });
    expect(child.status, child.stderr).toBe(23); await f.restart();
    const checked = await f.check(); expect(checked.items.filter(item => item.status === 'available')).toHaveLength(1); expect(checked.items.filter(item => item.status === 'missing')).toHaveLength(1);
    const scanned = await f.scan(checked.job.id); expect((await f.confirm(checked.job.id, scanned.items.filter(item => item.status === 'missing'))).job.phase).toBe('succeeded');
    for (const asset of [a, b]) expect(await readFile(asset.value.path, 'utf8')).toBe(asset.bytes);
    expect(f.store.get('run-snapshot', 'frozen')).toEqual(frozen); expect((await readdir(f.workspace, { recursive: true })).some(name => name.includes('.recovery-'))).toBe(false);
  });
});
