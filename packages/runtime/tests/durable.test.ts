import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntime, SimulatedProcessExit } from '../src/index.js';
import { ActivityJournal, AmbiguousActivityError } from '../src/activities.js';
import { openDatabase, DocumentStore } from '../src/database.js';
import { workflowNodeSchema, type ProjectDocument, type RunRecord, type WorkspaceSnapshot } from '@video-quickly/contracts';

const directories: string[] = [];
const runtimes: ReturnType<typeof createRuntime>[] = [];
async function location() { const directory = await mkdtemp(join(tmpdir(), 'video-quickly-runtime-')); directories.push(directory); return directory; }
async function runtime(options: Partial<Parameters<typeof createRuntime>[0]> = {}) {
  const value = createRuntime({ dataDirectory: await location(), ...options }); runtimes.push(value); return value;
}
afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(value => value.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('persistent external activity results', () => {
  it('reuses committed results after a crash before the graph checkpoint and never repeats the effect', async () => {
    const directory = await location();
    let calls = 0;
    const firstDb = openDatabase(directory);
    const first = new ActivityJournal(firstDb, { failpoint(point) { if (point === 'after-commit') throw new SimulatedProcessExit(); } });
    await expect(first.execute('run-1', 'request-1', { prompt: 'x' }, 'external', async () => { calls++; return { text: 'persisted' }; }, result => new DocumentStore(firstDb).put('output', 'saved', result))).rejects.toBeInstanceOf(SimulatedProcessExit);
    firstDb.close();
    const secondDb = openDatabase(directory);
    try {
      const second = new ActivityJournal(secondDb);
      const output = await second.execute('run-1', 'request-1', { prompt: 'x' }, 'external', async () => { calls++; return { text: 'duplicate' }; });
      expect(output).toEqual({ text: 'persisted' });
      expect(new DocumentStore(secondDb).get('output', 'saved')).toEqual(output);
      expect(calls).toBe(1);
    } finally { secondDb.close(); }
  });

  it('stops unknown external submissions and permits only known remote task recovery', async () => {
    const db = openDatabase(await location());
    let submissions = 0;
    const first = new ActivityJournal(db, { failpoint(point) { if (point === 'after-result') throw new SimulatedProcessExit(); } });
    await expect(first.execute('run', 'unknown', { prompt: 'x' }, 'external', async () => { submissions++; return 'reply'; })).rejects.toBeInstanceOf(SimulatedProcessExit);
    const recovered = new ActivityJournal(db);
    await expect(recovered.execute('run', 'unknown', { prompt: 'x' }, 'external', async () => { submissions++; return 'reply'; })).rejects.toBeInstanceOf(AmbiguousActivityError);
    expect(submissions).toBe(1);
    await expect(first.execute('run', 'known', {}, 'external', async context => { context.recordRemoteId('remote-42'); return 'pending'; })).rejects.toBeInstanceOf(SimulatedProcessExit);
    const output = await recovered.execute('run', 'known', {}, 'external', async context => ({ resumedTask: context.remoteId }));
    expect(output).toEqual({ resumedTask: 'remote-42' });
    db.close();
  });
});

describe('native LangGraph persistence and project behavior', () => {
  it('resumes a node whose result committed before checkpoint and keeps replay read-only', async () => {
    const directory = await location();
    let crashed = false;
    const first = await runtime({ dataDirectory: directory, failpoint(point, id) { if (point === 'after-commit' && id === 'brief' && !crashed) { crashed = true; throw new SimulatedProcessExit(); } } });
    const snapshot = await first.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const run = await first.dispatch('run.start', { projectId: snapshot.projects[0].id, nodeId: 'brief' }) as RunRecord;
    await first.waitForIdle(); await first.close();
    const second = await runtime({ dataDirectory: directory });
    await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
    const after = await second.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(after.runs[0].status).toBe('succeeded');
    expect(after.runs[0].activities).toHaveLength(1);
    const beforeReplay = JSON.stringify(after);
    const replay = await second.dispatch('run.replay', { runId: run.id }) as { externalCalls: number; matchesSnapshot: boolean };
    expect(replay).toMatchObject({ externalCalls: 0, matchesSnapshot: true });
    expect(JSON.stringify(await second.dispatch('workspace.snapshot'))).toBe(beforeReplay);
  });

  it('executes conditional DAG dependencies and skips the inactive branch', async () => {
    const instance = await runtime();
    const snapshot = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const project = snapshot.projects[0];
    const nodes = [
      workflowNodeSchema.parse({ id: 'choice', kind: 'condition', label: '选择', config: { value: false } }),
      workflowNodeSchema.parse({ id: 'yes', kind: 'brief', label: '是' }),
      workflowNodeSchema.parse({ id: 'no', kind: 'style', label: '否' }),
      workflowNodeSchema.parse({ id: 'merge', kind: 'join', label: '汇合' }),
    ];
    await instance.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'branch', version: 1, name: '分支', nodes, edges: [{ id: 'a', source: 'choice', target: 'yes', condition: 'true' }, { id: 'b', source: 'choice', target: 'no', condition: 'false' }, { id: 'c', source: 'yes', target: 'merge' }, { id: 'd', source: 'no', target: 'merge' }] } });
    const run = await instance.dispatch('run.start', { projectId: project.id }) as RunRecord;
    await instance.waitForIdle();
    const after = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(after.runs.find(item => item.id === run.id)?.status).toBe('succeeded');
    expect(after.runs[0].activities.map(item => item.id)).toEqual(['choice', 'no', 'merge']);
  });

  it('propagates generated shots downstream and protects manual edits when applying output', async () => {
    let renderedTitle = '';
    const instance = await runtime({ provider: async () => JSON.stringify({ shots: [{ title: '新镜头', narration: '新旁白', visualPrompt: '图画', durationUs: 2_000_000 }] }), executeActivity: async context => { renderedTitle = context.project.shots[0].title; return { ready: true }; } });
    const initial = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const project = initial.projects[0];
    const model = await instance.dispatch('model.save', { model: { name: '测试服务', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['text'] } }) as { id: string };
    const script = workflowNodeSchema.parse({ id: 'script', kind: 'script', label: '分镜', modelId: model.id });
    const animation = workflowNodeSchema.parse({ id: 'animation', kind: 'animation', label: '动画' });
    await instance.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'test', version: 1, name: '测试', nodes: [script, animation], edges: [{ id: 'edge', source: 'script', target: 'animation' }] } });
    const run = await instance.dispatch('run.start', { projectId: project.id }) as RunRecord;
    await instance.waitForIdle();
    expect(renderedTitle).toBe('新镜头');
    const before = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(before.projects[0].shots[0].title).toBe(project.shots[0].title);
    await instance.dispatch('project.update', { projectId: project.id, revision: before.projects[0].revision, patch: { title: '人工编辑' } });
    await expect(instance.dispatch('node.apply', { runId: run.id, nodeId: 'script' })).rejects.toThrow('项目已在生成后修改');
  });

  it('stores credentials only through SecretStore and saves backup assets with portable paths', async () => {
    const secrets = new Map<string, string>();
    const instance = await runtime({ secretStore: { persistent: false, async get(key) { return secrets.get(key); }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } } });
    await instance.dispatch('model.save', { model: { name: '自定义', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['text'] }, secret: 'test-only-value' });
    const snapshot = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(snapshot.system.secureStorageAvailable).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('test-only-value');
    const backup = await instance.dispatch('project.backup', { projectId: snapshot.projects[0].id }) as { path: string };
    const payload = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')) as { project: ProjectDocument; assets: Array<{ path: string }> };
    expect(payload.assets).toHaveLength(4);
    expect(payload.assets.every(asset => asset.path.startsWith('assets/'))).toBe(true);
    const bytes = await readFile(join(snapshot.system.dataDirectory, 'workspace.sqlite'));
    expect(bytes.includes('test-only-value')).toBe(false);
  });

  it('restores a portable backup with new identities and rejects corruption or traversal', async () => {
    const instance = await runtime();
    const before = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const original = before.projects[0];
    const backup = await instance.dispatch('project.backup', { projectId: original.id }) as { path: string };
    const restored = await instance.dispatch('project.importBackup', { path: backup.path }) as ProjectDocument;
    expect(restored.id).not.toBe(original.id);
    expect(restored.shots[0].assetId).not.toBe(original.shots[0].assetId);
    const after = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(after.projects).toHaveLength(2);
    const copied = after.assets.find(asset => asset.id === restored.shots[0].assetId)!;
    const source = before.assets.find(asset => asset.id === original.shots[0].assetId)!;
    expect(await readFile(copied.path)).toEqual(await readFile(source.path));
    const manifestPath = join(backup.path, 'project.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { assets: Array<{ path: string; sha256: string }> };
    const first = manifest.assets[0];
    const originalPath = first.path;
    first.path = '../outside.svg';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(instance.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('越界');
    first.path = originalPath; first.sha256 = '0'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(instance.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('校验失败');
    expect((await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot).projects).toHaveLength(2);
  });

  it('never persists raw credentials from an external provider error', async () => {
    const secrets = new Map<string, string>();
    const sensitive = 'fixture-sensitive-token-42';
    const instance = await runtime({ provider: async () => { throw new Error(`服务拒绝访问：${sensitive}`); }, secretStore: { async get(key) { return secrets.get(key); }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } } });
    const before = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const model = await instance.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['text'] }, secret: sensitive }) as { id: string };
    await instance.dispatch('workflow.save', { projectId: before.projects[0].id, workflow: { id: 'error', version: 1, name: '错误处理', nodes: [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '简报', modelId: model.id })], edges: [] } });
    await instance.dispatch('run.start', { projectId: before.projects[0].id }); await instance.waitForIdle();
    const snapshot = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(JSON.stringify(snapshot)).not.toContain(sensitive);
    expect(snapshot.runs[0].activities[0].error).toBe('外部调用未完成，结果需要核对。');
    const bytes = await readFile(join(snapshot.system.dataDirectory, 'workspace.sqlite'));
    const wal = await readFile(join(snapshot.system.dataDirectory, 'workspace.sqlite-wal'));
    expect(bytes.includes(sensitive) || wal.includes(sensitive)).toBe(false);
  });

  it('rebuilds missing local render files when a completed result precedes the graph checkpoint', async () => {
    const dataDirectory = await location(); let crashed = false; let renders = 0;
    const renderPath = join(dataDirectory, 'fixture-output.mp4');
    const executor: NonNullable<Parameters<typeof createRuntime>[0]['executeActivity']> = async context => {
      renders++; const content = Buffer.from('render-fixture'); await writeFile(renderPath, content);
      return { assets: [{ id: 'fixture-output', projectId: context.project.id, name: 'output.mp4', kind: 'video', path: renderPath, mimeType: 'video/mp4', size: content.length, sha256: createHash('sha256').update(content).digest('hex'), version: 1, createdAt: new Date().toISOString(), provenance: 'fixture', retained: false, active: true }] };
    };
    const first = await runtime({ dataDirectory, executeActivity: executor, failpoint(point, id) { if (!crashed && point === 'after-commit' && id === 'export') { crashed = true; throw new SimulatedProcessExit(); } } });
    const initial = await first.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const run = await first.dispatch('run.start', { projectId: initial.projects[0].id, nodeId: 'export' }) as RunRecord;
    await first.waitForIdle(); await first.close(); await rm(renderPath);
    const second = await runtime({ dataDirectory, executeActivity: executor });
    await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
    const after = await second.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(after.runs[0].status).toBe('succeeded'); expect(renders).toBe(2); expect(await readFile(renderPath, 'utf8')).toBe('render-fixture');
  });

  it('rejects incompatible media models before creating an external receipt', async () => {
    const instance = await runtime(); const before = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const model = await instance.dispatch('model.save', { model: { name: '文本模型', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['text'] } }) as { id: string };
    await instance.dispatch('workflow.save', { projectId: before.projects[0].id, workflow: { id: 'wrong-model', version: 1, name: '能力检查', nodes: [workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: '图片', modelId: model.id })], edges: [] } });
    await instance.dispatch('run.start', { projectId: before.projects[0].id }); await instance.waitForIdle();
    const after = await instance.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(after.runs[0].status).toBe('needs_attention'); expect(after.runs[0].activities).toHaveLength(0);
  });

  it('requires attention instead of regenerating a missing external result after checkpoint lag', async () => {
    const dataDirectory = await location(); let crashed = false; let submits = 0;
    const outputPath = join(dataDirectory, 'generated.png');
    const executor: NonNullable<Parameters<typeof createRuntime>[0]['executeActivity']> = async context => {
      submits++; const bytes = Buffer.from('external-fixture'); await writeFile(outputPath, bytes);
      return { assets: [{ id: 'external-output', projectId: context.project.id, shotId: context.project.shots[0].id, name: 'generated.png', kind: 'image', path: outputPath, mimeType: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: new Date().toISOString(), provenance: 'fixture', retained: false, active: true }] };
    };
    const first = await runtime({ dataDirectory, executeActivity: executor, failpoint(point, id) { if (!crashed && point === 'after-commit' && id === 'assets') { crashed = true; throw new SimulatedProcessExit(); } } });
    const initial = await first.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    const model = await first.dispatch('model.save', { model: { name: '图片', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['image'] } }) as { id: string };
    await first.dispatch('workflow.save', { projectId: initial.projects[0].id, workflow: { id: 'generation', version: 1, name: '图片', nodes: [workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: '图片', modelId: model.id })], edges: [] } });
    const run = await first.dispatch('run.start', { projectId: initial.projects[0].id }) as RunRecord;
    await first.waitForIdle(); await first.close(); await rm(outputPath);
    const second = await runtime({ dataDirectory, executeActivity: executor });
    await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
    const after = await second.dispatch('workspace.snapshot') as WorkspaceSnapshot;
    expect(after.runs[0].status).toBe('needs_attention'); expect(submits).toBe(1);
  });
});
