import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetRecoveryJobSchema, assetRecoveryPageSchema, type AssetRecord, type ProjectDocument, type RuntimeEvent } from '@video-quickly/contracts';
import { createRuntime } from '../src/packages/runtime/src/index';

describe('asset recovery runtime integration', () => {
  it('restores through public RPCs, publishes one availability event and preserves saved content identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vq-recovery-runtime-')), runtime = createRuntime({ dataDirectory: join(directory, 'workspace'), seed: false });
    try {
      const path = join(directory, 'image.svg'), bytes = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'; await writeFile(path, bytes);
      const project = await runtime.dispatch('project.create', { title: 'RPC恢复验收' }) as ProjectDocument;
      const asset = await runtime.dispatch('asset.import', { projectId: project.id, path, kind: 'image' }) as AssetRecord;
      await rm(asset.path);
      const events: RuntimeEvent[] = []; runtime.subscribe(event => events.push(event));
      const job = assetRecoveryJobSchema.parse(await runtime.dispatch('asset.recovery.start', { projectId: project.id })); await runtime.waitForIdle();
      await runtime.dispatch('asset.recovery.scan', { jobId: job.id, directory }); await runtime.waitForIdle();
      const page = assetRecoveryPageSchema.parse(await runtime.dispatch('asset.recovery.get', { jobId: job.id }));
      expect(page.items).toHaveLength(1); expect(page.items[0].candidates).toHaveLength(1);
      const input = { jobId: job.id, selections: [{ itemId: page.items[0].id, candidateId: page.items[0].candidates[0].id }] };
      await runtime.dispatch('asset.recovery.confirm', input); await runtime.waitForIdle();
      expect(assetRecoveryPageSchema.parse(await runtime.dispatch('asset.recovery.get', { jobId: job.id })).job.phase).toBe('succeeded');
      await runtime.dispatch('asset.recovery.confirm', input); await runtime.waitForIdle();
      expect(events.filter(event => event.type === 'workspace.changed')).toEqual([{ type: 'workspace.changed', data: { repairedAssetIds: [asset.id] } }]);
      const current = await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument; assets: AssetRecord[] };
      expect(current.project).toEqual(project); expect(current.assets).toEqual([asset]); expect(await readFile(asset.path, 'utf8')).toBe(bytes);
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });

  it('cancels an in-flight inventory before SQLite closes and can reopen its persisted task', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vq-recovery-close-')), workspace = join(directory, 'workspace');
    let runtime = createRuntime({ dataDirectory: workspace, seed: false });
    try {
      const path = join(directory, 'image.svg'); await writeFile(path, '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
      const project = await runtime.dispatch('project.create', { title: '关闭恢复任务' }) as ProjectDocument;
      await runtime.dispatch('asset.import', { projectId: project.id, path, kind: 'image' });
      const job = assetRecoveryJobSchema.parse(await runtime.dispatch('asset.recovery.start', { projectId: project.id }));
      await runtime.close(); runtime = createRuntime({ dataDirectory: workspace, seed: false });
      const saved = assetRecoveryPageSchema.parse(await runtime.dispatch('asset.recovery.get', { jobId: job.id }));
      expect(saved.job.phase).toBe('canceled'); await runtime.waitForIdle();
      await runtime.dispatch('asset.recovery.cancel', { jobId: job.id });
    } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
