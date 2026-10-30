import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, expect, it } from 'vitest';
import { activitySchema, assetSchema, modelSchema, projectDetailSchema, projectSchema, recordPageSchema, runDiagnosticBundleSchema, runDiagnosticsSchema, runEventSchema, runInspectionSchema, runStepPayloadSchema, runSchema, stepOutputVersionSchema, workflowNodeSchema, type AssetRecord, type WorkflowNode } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';
import { ActivityJournal } from '../packages/runtime/src/activities';
import { DocumentStore, openDatabase } from '../packages/runtime/src/database';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(options: Partial<RuntimeOptions> = {}) {
  const directory = options.dataDirectory ?? await mkdtemp(join(tmpdir(), 'vq-run-inspection-'));
  if (!directories.includes(directory)) directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ...options }); runtimes.push(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '执行时的项目', brief: '冻结的创作要求' }));
  return { runtime, project, directory };
}
async function workflow(runtime: ReturnType<typeof createRuntime>, projectId: string, nodes: WorkflowNode[], edges: { id: string; source: string; target: string; condition?: string }[] = []) {
  return projectSchema.parse(await runtime.dispatch('workflow.save', { projectId, workflow: { id: 'inspector-flow', version: 1, name: '步骤详情验收', nodes, edges } }));
}
async function start(runtime: ReturnType<typeof createRuntime>, projectId: string) {
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId })); await runtime.waitForIdle(); return run;
}
async function inspect(runtime: ReturnType<typeof createRuntime>, runId: string, nodeId?: string) { return runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId, nodeId })); }
async function payload(runtime: ReturnType<typeof createRuntime>, runId: string, nodeId: string, kind: 'input' | 'output') { return runStepPayloadSchema.parse(await runtime.dispatch('run.step.payload', { runId, nodeId, kind })); }

it('inspects frozen labels, real effective inputs and native human review without executing or applying anything', async () => {
  const calls: { name: string; prompt: string }[] = [];
  const { runtime, project, directory } = await fixture({ provider: async request => { calls.push({ name: request.model.name, prompt: request.prompt }); return '运行生成的视觉风格'; } });
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '冻结模型', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['text'] } }));
  const first = workflowNodeSchema.parse({ id: 'style:one', kind: 'style', label: '原步骤名称', modelId: model.id, requiresReview: true });
  const second = workflowNodeSchema.parse({ id: 'brief:two', kind: 'brief', label: '读取上游风格', modelId: model.id });
  const frozen = await workflow(runtime, project.id, [first, second], [{ id: 'next', source: first.id, target: second.id }]);
  const run = await start(runtime, project.id);
  let detail = await inspect(runtime, run.id, first.id);
  expect(detail.steps.map(step => step.status)).toEqual(['waiting_review', 'pending']);
  expect(detail.recovery).toMatchObject({ review: true, resume: false });
  expect(detail.steps[0]).toMatchObject({ inputAvailable: true, outputAvailable: true, unknownSubmission: false, activityCount: 1 });
  expect(detail.steps[1]).toMatchObject({ inputAvailable: false, outputAvailable: false });
  await runtime.dispatch('project.update', { projectId: project.id, revision: frozen.revision, patch: { title: '现在的标题', style: '现在的人工风格', workflow: { ...frozen.workflow, nodes: [{ ...first, label: '现在的步骤名称' }, second] } } });
  await runtime.dispatch('model.save', { model: { ...model, name: '现在的模型名称' } });
  const beforeDb = openDatabase(directory);
  const before = beforeDb.prepare('SELECT count(*) AS count FROM execution_events').get(); beforeDb.close();
  detail = await inspect(runtime, run.id, first.id);
  expect(detail.projectTitle).toBe('执行时的项目'); expect(detail.selected?.node.label).toBe('原步骤名称'); expect(detail.selected?.model?.name).toBe('冻结模型');
  const input = await payload(runtime, run.id, first.id, 'input');
  expect(input.resolvedPromptRecorded).toBe(true); expect(input.value).toMatchObject({ project: { title: '执行时的项目', style: frozen.style }, node: { label: '原步骤名称' }, model: { name: '冻结模型' } });
  expect(await payload(runtime, run.id, second.id, 'input')).toMatchObject({ available: false, value: null });
  expect((await payload(runtime, run.id, first.id, 'output')).value).toMatchObject({ text: '运行生成的视觉风格' });
  const afterDb = openDatabase(directory); expect(afterDb.prepare('SELECT count(*) AS count FROM execution_events').get()).toEqual(before); afterDb.close();
  expect(calls).toHaveLength(1);
  await runtime.dispatch('run.review', { runId: run.id, approved: true }); await runtime.waitForIdle();
  expect((await payload(runtime, run.id, second.id, 'input')).value).toMatchObject({ project: { title: '执行时的项目', style: '运行生成的视觉风格' }, model: { name: '冻结模型' } });
  expect((await inspect(runtime, run.id)).steps.every(step => step.status === 'succeeded')).toBe(true); expect(calls).toHaveLength(2);
  const current = projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: project.id })).project!;
  expect(current.title).toBe('现在的标题'); expect(current.style).toBe('现在的人工风格');
});

it('uses the persisted branch state to distinguish skipped steps from completed and pending ones', async () => {
  const { runtime, project } = await fixture();
  const nodes = [workflowNodeSchema.parse({ id: 'choice', kind: 'condition', label: '条件', config: { value: false } }), workflowNodeSchema.parse({ id: 'yes', kind: 'brief', label: '真分支' }), workflowNodeSchema.parse({ id: 'no', kind: 'style', label: '假分支' }), workflowNodeSchema.parse({ id: 'merge', kind: 'join', label: '汇合' })];
  await workflow(runtime, project.id, nodes, [{ id: 'a', source: 'choice', target: 'yes', condition: 'true' }, { id: 'b', source: 'choice', target: 'no', condition: 'false' }, { id: 'c', source: 'yes', target: 'merge' }, { id: 'd', source: 'no', target: 'merge' }]);
  const run = await start(runtime, project.id), detail = await inspect(runtime, run.id);
  expect(detail.steps.map(step => [step.id, step.status, step.outputAvailable])).toEqual([['choice', 'succeeded', true], ['yes', 'skipped', false], ['no', 'succeeded', true], ['merge', 'succeeded', true]]);
});

it('keeps an unknown external submission blocked across restart and never repeats it while inspecting', async () => {
  let calls = 0;
  const first = await fixture({ provider: async () => { calls++; return 'result'; }, failpoint(point) { if (point === 'after-dispatch') throw new SimulatedProcessExit(); } });
  const model = modelSchema.parse(await first.runtime.dispatch('model.save', { model: { name: '原模型', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['text'] } }));
  await workflow(first.runtime, first.project.id, [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '提交生成', modelId: model.id })]);
  const run = await start(first.runtime, first.project.id); await first.runtime.close();
  const second = createRuntime({ dataDirectory: first.directory, seed: false, provider: async () => { calls++; return 'duplicate'; } }); runtimes.push(second);
  for (let time = 0; time < 3; time++) {
    const detail = await inspect(second, run.id, 'brief');
    expect(detail.recovery.resume).toBe(false); expect(detail.steps[0].unknownSubmission).toBe(true); expect(detail.steps[0].reason).toContain('尚未确认');
    await payload(second, run.id, 'brief', 'input');
  }
  expect(calls).toBe(0);
  expect((await inspect(second, run.id)).run.status).toBe('queued');
});

it('does not label a saved result as an advanced checkpoint and resumes it without another external call', async () => {
  let calls = 0;
  const first = await fixture({ provider: async () => { calls++; return 'saved response'; }, failpoint(point) { if (point === 'after-commit') throw new SimulatedProcessExit(); } });
  const model = modelSchema.parse(await first.runtime.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['text'] } }));
  await workflow(first.runtime, first.project.id, [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '已保存结果', modelId: model.id })]);
  const run = await start(first.runtime, first.project.id);
  // Simulate a pre-inspector run: its committed response exists, but it never
  // recorded the resolved prompt. Recovery must not invent the original text.
  const legacy = openDatabase(first.directory); new DocumentStore(legacy).delete('node-inspection-input', `${run.id}:brief`); legacy.close();
  await first.runtime.close();
  const second = createRuntime({ dataDirectory: first.directory, seed: false, provider: async () => { calls++; return 'duplicate'; } }); runtimes.push(second);
  const detail = await inspect(second, run.id, 'brief');
  expect(detail.steps[0]).toMatchObject({ status: 'pending', outputAvailable: true, unknownSubmission: false }); expect(detail.recovery.resume).toBe(true);
  expect(detail.steps[0].reason).toContain('产物已保存');
  expect((await payload(second, run.id, 'brief', 'output')).value).toMatchObject({ text: 'saved response' }); expect(calls).toBe(1);
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  expect((await inspect(second, run.id)).steps[0].status).toBe('succeeded'); expect(calls).toBe(1);
  expect((await payload(second, run.id, 'brief', 'input')).resolvedPromptRecorded).toBe(false);
});

it('filters and paginates actual nested receipts and logs without confusing step namespaces', async () => {
  const { runtime, project, directory } = await fixture();
  const ids = ['step', 'step:child', 'wild%_'];
  await workflow(runtime, project.id, ids.map(id => workflowNodeSchema.parse({ id, kind: 'brief', label: id })));
  const run = await start(runtime, project.id), db = openDatabase(directory), journal = new ActivityJournal(db);
  for (const id of ['step:tool:1', 'step:child:tool:1', 'wild%_:tool:1']) await journal.execute(run.id, id, { id }, 'local', async () => ({ text: 'nested output' }));
  db.close();
  const parent = recordPageSchema(activitySchema).parse(await runtime.dispatch('run.activities', { runId: run.id, nodeId: 'step', limit: 1 }));
  expect(parent.items[0]).toMatchObject({ id: 'step:tool:1', nodeId: 'step' }); expect(parent.items[0].result).toBeUndefined(); expect(parent.nextCursor).not.toBeNull();
  const tail = recordPageSchema(activitySchema).parse(await runtime.dispatch('run.activities', { runId: run.id, nodeId: 'step', before: parent.nextCursor, limit: 1 })); expect(tail.items.map(item => item.id)).toEqual(['step']);
  const child = recordPageSchema(activitySchema).parse(await runtime.dispatch('run.activities', { runId: run.id, nodeId: 'step:child' })); expect(child.items.map(item => item.id)).toEqual(['step:child:tool:1', 'step:child']); expect(child.items.every(item => item.nodeId === 'step:child')).toBe(true);
  const logs = recordPageSchema(runEventSchema).parse(await runtime.dispatch('run.events', { runId: run.id, nodeId: 'step' })); expect(logs.items.length).toBeGreaterThan(0); expect(logs.items.every(event => event.nodeId === 'step')).toBe(true);
  expect(recordPageSchema(activitySchema).parse(await runtime.dispatch('run.activities', { runId: run.id, nodeId: 'wild%_' })).items).toHaveLength(2);
});

it('pages historical output versions by frozen project, node and kind without applying them', async () => {
  let calls = 0;
  const { runtime, project } = await fixture({ provider: async () => `版本 ${++calls}` });
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['text'] } }));
  const node = workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '版本对比', modelId: model.id });
  await workflow(runtime, project.id, [node]); const first = await start(runtime, project.id), second = await start(runtime, project.id);
  const page = recordPageSchema(stepOutputVersionSchema).parse(await runtime.dispatch('run.step.versions', { runId: first.id, nodeId: node.id, limit: 1 }));
  expect(page.items.map(item => item.id)).toEqual([second.id]); expect(page.nextCursor).not.toBeNull();
  const next = recordPageSchema(stepOutputVersionSchema).parse(await runtime.dispatch('run.step.versions', { runId: first.id, nodeId: node.id, before: page.nextCursor, limit: 1 })); expect(next.items.map(item => item.id)).toEqual([first.id]); expect(next.nextCursor).toBeNull();
  expect((await payload(runtime, first.id, node.id, 'output')).value).toMatchObject({ text: '版本 1' }); expect((await payload(runtime, second.id, node.id, 'output')).value).toMatchObject({ text: '版本 2' }); expect(calls).toBe(2);
});

it('exports all selected-run records with credential, URL, argument and text redaction while retaining zero counters', async () => {
  const secret = 'fixture-private-credential', secrets = new Map<string, string>(); let calls = 0;
  const { runtime, project, directory } = await fixture({ secretStore: { async get(key) { return secrets.get(key); }, async set(key, value) { secrets.set(key, value); }, async delete(key) { secrets.delete(key); } }, provider: async () => { calls++; return `result ${secret}`; } });
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: 'fixture', capabilities: ['text'], parameters: { vendor_extension: { apiKey: secret, inputTokens: 0 } } }, secret }));
  await workflow(runtime, project.id, [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '诊断', modelId: model.id, prompt: `api_key="${secret}"` })]);
  const run = await start(runtime, project.id), db = openDatabase(directory), store = new DocumentStore(db), journal = new ActivityJournal(db);
  for (let index = 0; index < 130; index++) await journal.execute(run.id, `brief:tool:${index}`, { index }, 'local', async () => ({ apiKey: secret, args: ['--token', secret], url: `https://user:${secret}@example.test/result?token=${secret}`, inputTokens: 0 }));
  const captured = store.get<{ prompt: string }>('node-inspection-input', `${run.id}:brief`); expect(captured?.prompt).not.toContain(secret); db.close();
  const exported = runDiagnosticsSchema.parse(await runtime.dispatch('run.diagnostics', { runId: run.id }));
  const bytes = await readFile(exported.path), text = gunzipSync(bytes).toString('utf8'); expect(text).not.toContain(secret); expect(text).not.toContain('https://user:');
  const bundle = runDiagnosticBundleSchema.parse(JSON.parse(text));
  expect(bundle.activities).toHaveLength(131); expect(bundle.events.length).toBeGreaterThan(130); expect(bundle.activities.at(-1)).toMatchObject({ result: { apiKey: '[已隐藏]', args: ['--token', '[已隐藏]'], inputTokens: 0 } }); expect(bytes.length).toBe(exported.bytes); expect(calls).toBe(1);
});

it('removes only its incomplete diagnostic file when a stored result cannot be decoded', async () => {
  const { runtime, project, directory } = await fixture(); await workflow(runtime, project.id, [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '诊断失败' })]); const run = await start(runtime, project.id);
  const db = openDatabase(directory); db.prepare('UPDATE activities SET result = ? WHERE run_id = ?').run('{invalid-json', run.id); db.close();
  await expect(runtime.dispatch('run.diagnostics', { runId: run.id })).rejects.toThrow();
  expect(await readdir(join(directory, 'diagnostics'))).toEqual([]);
});

async function mediaVersions() {
  const assets: AssetRecord[] = [];
  const { runtime, project } = await fixture({ executeActivity: async ({ project, node, dataDirectory }) => {
    const bytes = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text x="0" y="32">${node.id}</text></svg>`);
    const path = join(dataDirectory, `${node.id}.svg`); await writeFile(path, bytes);
    const asset = assetSchema.parse({ id: node.id, projectId: project.id, shotId: project.shots[0].id, name: node.label, kind: 'image', path, mimeType: 'image/svg+xml', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: new Date().toISOString(), provenance: 'test provider' }); assets.push(asset);
    return { assets: [asset] };
  } });
  const saved = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'target', title: '保留的人工标题', narration: '', visualPrompt: '', durationUs: 1_000_000 }] } }));
  const baseline = await workflow(runtime, saved.id, ['image-a', 'image-b'].map(id => workflowNodeSchema.parse({ id, kind: 'assets', label: id })), [{ id: 'a-b', source: 'image-a', target: 'image-b' }]);
  const run = await start(runtime, saved.id); return { runtime, baseline, run, assets };
}

it('applies the selected media step instead of the final downstream project and preserves the selected output through inspection', async () => {
  const { runtime, baseline, run, assets } = await mediaVersions();
  expect(assets.map(asset => asset.id)).toEqual(['image-a', 'image-b']);
  expect((await payload(runtime, run.id, 'image-a', 'output')).value).toMatchObject({ assets: [{ id: 'image-a' }] });
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: run.id, nodeId: 'image-a', revision: baseline.revision }));
  expect(applied.shots[0]).toMatchObject({ assetId: 'image-a', title: '保留的人工标题' });
});

it('keeps the project unchanged when a selected step media file has changed after generation', async () => {
  const { runtime, baseline, run, assets } = await mediaVersions();
  const corrupted = await readFile(assets[0].path); corrupted[0] ^= 1; await writeFile(assets[0].path, corrupted);
  await expect(runtime.dispatch('node.apply', { runId: run.id, nodeId: 'image-a', revision: baseline.revision })).rejects.toThrow(/素材.*(损坏|更改|校验|缺失)/);
  expect(projectDetailSchema.parse(await runtime.dispatch('project.get', { projectId: baseline.id })).project).toEqual(baseline);
});
