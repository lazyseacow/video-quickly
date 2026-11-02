import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRuntime } from '../packages/runtime/src/index';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';
import { seedLargeWorkspace } from '../tests/fixtures/large-workspace';
import { editContent, ProjectEditSession } from '../apps/desktop/src/lib/project-edits';
import { selectShot } from '../apps/desktop/src/lib/shot-selection';
import { projectSchema, type ProjectDetail } from '@video-quickly/contracts';

const sourceRoot = resolve(import.meta.dirname, '..');
const sourceFiles = ['scripts/benchmark-workspace.ts', 'tests/fixtures/large-workspace.ts', 'packages/runtime/src/index.ts', 'packages/runtime/src/read-models.ts', 'packages/runtime/src/characters.ts', 'apps/desktop/src/lib/project-edits.ts', 'apps/desktop/src/lib/shot-selection.ts'];
const source = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim(),
  dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: sourceRoot, encoding: 'utf8' }).trim()),
  sha256: Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash('sha256').update(await readFile(join(sourceRoot, file))).digest('hex')]))),
};
const results = [];
for (const shots of [10, 50, 200, 1000]) {
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
      return summarize(samples, bytes);
    }
    const detail = await instance.dispatch('project.get', { projectId: project.id }) as ProjectDetail;
    let saved = project;
    async function measureEditorSave() {
      const samples: number[] = []; let bytes = 0;
      // Exercise the full editor patch and current revision on every request.
      // Warm-up writes are excluded from timing and use only this temporary project.
      for (let index = 0; index < 25; index++) {
        const patch = { ...editContent(saved), shots: saved.shots.map((shot, position) => position ? shot : { ...shot, title: `保存输入 ${index}` }) };
        const start = performance.now();
        const result = await instance.dispatch('project.update', { projectId: saved.id, revision: saved.revision, patch });
        const serialized = JSON.stringify(result);
        const elapsed = performance.now() - start;
        saved = projectSchema.parse(result);
        if (index >= 5) { samples.push(elapsed); bytes = Buffer.byteLength(serialized); }
      }
      return summarize(samples, bytes);
    }
    function measureSelectionToggle() {
      const ids = project.shots.map(shot => shot.id), target = ids[Math.floor(ids.length / 2)];
      const selection = { ids, primary: target, anchor: target }, samples: number[] = [];
      let checksum = 0;
      for (let index = 0; index < 25; index++) {
        const start = performance.now();
        const changed = selectShot(selection, ids, target, { toggle: true });
        const elapsed = performance.now() - start;
        if (index >= 5) samples.push(elapsed);
        checksum += changed.ids.reduce((sum, id) => sum + id.length, 0) + (changed.primary?.length ?? 0) + (changed.anchor?.length ?? 0);
      }
      return { ...summarize(samples), checksum };
    }
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
      editorSave: await measureEditorSave(),
      selectionToggle: measureSelectionToggle(),
      editCommand: { p50Ms: round(editing[50]), p95Ms: round(editing[95]), draftBytes: Buffer.byteLength(JSON.stringify(editor.state)), undoSteps: editor.state.undo.length },
      heapBeforeMiB: round(heapBefore / 1024 / 1024), heapAfterMiB: round(process.memoryUsage().heapUsed / 1024 / 1024),
    };
    results.push(metrics);
  } finally { await runtime?.close(); await rm(directory, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ source, machine: { platform: platform(), architecture: process.arch, release: release(), cpu: cpus()[0]?.model, memoryGiB: round(totalmem() / 1024 ** 3), node: process.version }, measuredAt: new Date().toISOString(),
  sampling: { scope: 'Runtime dispatch plus JSON serialization; no IPC, UI or media decoding', reads: { warmup: 0, count: 20, legacySnapshotCount: 5 }, editorSave: { warmup: 5, count: 20, patchPreparationAndReplyValidationTimed: false }, selectionToggle: { warmup: 5, count: 20, scope: 'selectShot only; deselect the primary in a fully selected group, fixed input per sample' } }, results }, null, 2));
function round(value: number) { return Math.round(value * 100) / 100; }
function summarize(samples: number[], bytes?: number) {
  const sorted = [...samples].sort((left, right) => left - right);
  return { p50Ms: round(sorted[Math.floor(sorted.length * .5)]), p95Ms: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .95))]), bytes, samplesMs: [...samples] };
}
