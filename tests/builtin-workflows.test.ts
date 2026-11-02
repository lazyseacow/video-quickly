import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createHistoryWorkflow, createVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, validateWorkflowComposition, type ProjectDocument } from '@video-quickly/contracts';
import { upgradeBuiltinProject, upgradeBuiltinWorkflow } from '../packages/runtime/src/builtin-workflows';
import { DocumentStore, openDatabase, thumbnailShot, WORKSPACE_MIGRATIONS } from '../packages/runtime/src/database';
import { migrateDatabase } from '../packages/runtime/src/migrations';
import { createRuntime } from '../packages/runtime/src';
import { legacyHistoryWorkflow } from './fixtures/legacy-workflow';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const kinds = ['brief', 'style', 'script', 'assets', 'voice', 'animation', 'export'];
function legacyProject() {
  return projectSchema.parse({ id: 'old-project', title: '旧项目', brief: '保留的创意', revision: 8, profile: DEFAULT_VIDEO_PROFILE, workflow: legacyHistoryWorkflow(), shots: [], claims: [], createdAt: '2026-10-01', updatedAt: '2026-10-02' });
}

it('creates both built-in workflows with four stages and no research, review node or automatic review wait', () => {
  for (const workflow of [createHistoryWorkflow(), createVideoWorkflow()]) {
    expect(workflow.nodes.map(node => node.kind)).toEqual(kinds);
    expect(workflow.nodes.every(node => !node.requiresReview)).toBe(true);
    expect(workflow.stages?.map(stage => stage.label)).toEqual(['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出']);
    expect(() => validateWorkflowComposition(workflow)).not.toThrow();
    expect(upgradeBuiltinWorkflow(workflow)).toBe(workflow);
  }
});

it('reconnects removed tasks, retains authored task settings and leaves explicit custom workflows untouched', () => {
  const project = legacyProject(), before = structuredClone(project), upgraded = upgradeBuiltinProject(project);
  expect(upgraded.workflow.nodes.map(node => node.kind)).toEqual(kinds);
  expect(upgraded.workflow.nodes.find(node => node.id === 'style')).toEqual({ ...project.workflow.nodes.find(node => node.id === 'style'), requiresReview: false });
  expect(upgraded.workflow.edges.map(edge => [edge.source, edge.target]).toSorted()).toEqual(kinds.slice(1).map((kind, index) => [kinds[index], kind]).toSorted());
  expect(upgraded).toMatchObject({ revision: 9, updatedAt: project.updatedAt, workflow: { version: 5 } });
  expect(() => validateWorkflowComposition(upgraded.workflow)).not.toThrow();
  expect(upgradeBuiltinProject(upgraded)).toBe(upgraded); expect(project).toEqual(before);
  const custom = { ...project.workflow, id: 'custom-research-review' };
  expect(upgradeBuiltinWorkflow(custom)).toBe(custom);
});

it('upgrades v8 projects with a backup while preserving custom projects and frozen runs, and is stable after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-builtin-upgrade-')); directories.push(directory);
  const Database = createRequire(new URL('../packages/runtime/package.json', import.meta.url))('better-sqlite3');
  const database = new Database(join(directory, 'workspace.sqlite'));
  database.function('vq_thumbnail', { deterministic: true }, (body: string) => JSON.stringify(thumbnailShot(JSON.parse(body))));
  migrateDatabase(database, directory, WORKSPACE_MIGRATIONS.filter(migration => migration.version <= 8));
  const store = new DocumentStore(database), project = legacyProject();
  const custom = { ...project, id: 'custom-project', workflow: { ...project.workflow, id: 'custom' } };
  const snapshot = { project: structuredClone(project), workflow: structuredClone(project.workflow), digest: 'retained-frozen-snapshot' };
  const run = { id: 'old-run', projectId: project.id, status: 'waiting_review', currentNodeId: 'script', snapshotDigest: 'retained-frozen-snapshot' };
  store.put('project', project.id, project); store.put('project', custom.id, custom); store.put('run', run.id, run); store.put('run-snapshot', run.id, snapshot); database.close();
  const upgraded = openDatabase(directory), documents = new DocumentStore(upgraded);
  expect(documents.get('project', project.id)).toEqual(upgradeBuiltinProject(project)); expect(documents.get('project', custom.id)).toEqual(custom);
  expect(documents.get('run', run.id)).toEqual(run); expect(documents.get('run-snapshot', run.id)).toEqual(snapshot);
  expect(documents.get<{ workflowNodeCount: number }>('project-summary', project.id)?.workflowNodeCount).toBe(7);
  expect(upgraded.pragma('user_version', { simple: true })).toBe(9); upgraded.close();
  const backups = await readdir(join(directory, 'database-backups')); expect(backups).toHaveLength(1);
  const backup = new Database(join(directory, 'database-backups', backups[0]!), { readonly: true });
  expect(new DocumentStore(backup).get('project', project.id)).toEqual(project); backup.close();
  const reopened = openDatabase(directory); expect(new DocumentStore(reopened).get('project', project.id)).toEqual(upgradeBuiltinProject(project)); reopened.close();
  expect(await readdir(join(directory, 'database-backups'))).toEqual(backups);
});

it('runs a built-in task without pausing and cleans obsolete tasks submitted from an older editor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-builtin-execution-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false, provider: async () => { throw new Error('This local task must not call a provider'); } });
  try {
    const project = await runtime.dispatch('project.create', { title: '无需人工审核' }) as ProjectDocument;
    const run = await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'style' }) as { id: string }; await runtime.waitForIdle();
    expect(await runtime.dispatch('run.get', { runId: run.id })).toMatchObject({ status: 'succeeded' });
    const saved = await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: legacyHistoryWorkflow() }) as ProjectDocument;
    expect(saved.workflow.nodes.map(node => node.kind)).toEqual(kinds); expect(saved.workflow.nodes.every(node => !node.requiresReview)).toBe(true);
  } finally { await runtime.close(); }
});

it('cleans an imported old backup while retaining the surviving task configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-builtin-import-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false });
  try {
    const project = await runtime.dispatch('project.create', { title: '旧版备份' }) as ProjectDocument;
    const backup = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
    const path = join(backup.path, 'project.json'), manifest = JSON.parse(await readFile(path, 'utf8')) as { project: ProjectDocument };
    manifest.project.workflow = legacyHistoryWorkflow(); await writeFile(path, JSON.stringify(manifest));
    const restored = await runtime.dispatch('project.importBackup', { path: backup.path }) as ProjectDocument;
    expect(restored.revision).toBe(1); expect(restored.workflow.nodes.map(node => node.kind)).toEqual(kinds);
    expect(restored.workflow.nodes.every(node => !node.requiresReview)).toBe(true);
    expect(restored.workflow.nodes.find(node => node.id === 'style')).toMatchObject({ prompt: 'style原有提示词', modelId: 'saved-style-model', config: { retained: 'style' } });
  } finally { await runtime.close(); }
});
