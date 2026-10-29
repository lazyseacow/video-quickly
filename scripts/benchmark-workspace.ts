import { mkdtemp, rm } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRuntime } from '../packages/runtime/src/index';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';
import { seedLargeWorkspace } from '../tests/fixtures/large-workspace';
import { ProjectEditSession } from '../apps/desktop/src/lib/project-edits';
import type { ProjectDetail } from '@video-quickly/contracts';

const results = [];
for (const shots of [10, 50, 200]) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-workspace-benchmark-'));
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    const database = openDatabase(directory);
    const project = seedLargeWorkspace(new DocumentStore(database), shots);
    database.close();
    const start = performance.now();
    runtime = createRuntime({ dataDirectory: directory, seed: false });
    const openMs = performance.now() - start;
    const instance = runtime;
    async function measure(method: string, params = {}, count = 20) {
      const samples = [];
      let bytes = 0;
      for (let index = 0; index < count; index++) {
        const start = performance.now();
        const value = await instance.dispatch(method, params);
        const serialized = JSON.stringify(value);
        samples.push(performance.now() - start); bytes = Buffer.byteLength(serialized);
      }
      samples.sort((left, right) => left - right);
      return { p50Ms: round(samples[Math.floor(samples.length * .5)]), p95Ms: round(samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))]), bytes };
    }
    const detail = await instance.dispatch('project.get', { projectId: project.id }) as ProjectDetail;
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const editor = new ProjectEditSession(project);
    const editing = [];
    for (let index = 0; index < 100; index++) {
      const start = performance.now();
      editor.edit({ ...editor.state.present, shots: editor.state.present.shots.map((shot, position) => position ? shot : { ...shot, title: `连续输入 ${index}` }) }, '编辑镜头', 'title');
      editing.push(performance.now() - start);
    }
    editing.sort((left, right) => left - right);
    const metrics = {
      shots, assets: 1000, runs: 200, events: 20000, preview: project.profile, runtimeOpenMs: round(openMs),
      summary: await measure('workspace.summary'), project: await measure('project.get', { projectId: project.id }),
      refresh: await measure('project.get', { projectId: project.id, revision: detail.revision, assetsVersion: detail.assetsVersion }),
      historyPage: await measure('run.events', { runId: `${project.id}-run-0` }),
      assetPage: await measure('asset.list'), legacySnapshot: await measure('workspace.snapshot', {}, 5),
      editCommand: { p50Ms: round(editing[50]), p95Ms: round(editing[95]), draftBytes: Buffer.byteLength(JSON.stringify(editor.state)), undoSteps: editor.state.undo.length },
      heapBeforeMiB: round(heapBefore / 1024 / 1024), heapAfterMiB: round(process.memoryUsage().heapUsed / 1024 / 1024),
    };
    results.push(metrics);
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, memoryGiB: round(totalmem() / 1024 ** 3), node: process.version }, measuredAt: new Date().toISOString(), results }, null, 2));
function round(value: number) { return Math.round(value * 100) / 100; }
