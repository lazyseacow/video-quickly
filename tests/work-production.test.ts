import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { characterProfileSchema, chargeConfirmationSchema, modelSchema, productionQueueDetailSchema, productionQueueEnqueueResultSchema, productionQueueSchema, projectSchema, projectSummarySchema, runInspectionSchema, runSchema, workDefaultsSchema, workSchema, workflowNodeSchema, type ProjectDocument, type ProductionQueue, type StoryWork } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src/index';
import { openDatabase, DocumentStore } from '../packages/runtime/src/database';
import { importSkillFixture } from './fixtures/import-skill';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [], releases: Array<() => void> = [];
afterEach(async () => { releases.splice(0).forEach(release => release()); await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true }))); });
async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-work-production-')); directories.push(directory);
  const calls: string[] = [];
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, provider: async request => { calls.push(request.prompt); return '完成的分集正文'; }, ...extra };
  const runtime = createRuntime(options); runtimes.push(runtime);
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '分集文本', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', provider: 'openai-compatible', connectionType: 'text', capabilities: ['text'] } }));
  const work = workSchema.parse(await runtime.dispatch('work.save', { title: '花园作品', defaults: { ...workDefaultsSchema.parse({}), style: '作品水彩', production: { mode: 'native-video', textModelId: model.id, referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' } } }));
  const batch = { workId: work.id, revision: work.revision, requestId: randomUUID(), episodes: [1, 2, 3].map(number => ({ number, title: `第${number}集`, originalText: `第${number}集的原始文案` })) };
  const created = await runtime.dispatch('work.episodes.create', batch) as ProjectDocument[];
  const projects: ProjectDocument[] = [];
  for (const value of created) projects.push(projectSchema.parse(await runtime.dispatch('project.update', { projectId: value.id, revision: value.revision, patch: { workflow: {
    id: 'episode-fixture', version: 1, name: '分集夹具流程', production: value.workflow.production,
    nodes: ['brief', 'style'].map(kind => workflowNodeSchema.parse({ id: kind, kind, label: kind === 'brief' ? '简报' : '风格', modelId: model.id, config: { requiresModel: true } })), edges: [{ id: 'next', source: 'brief', target: 'style' }],
  } } })));
  return { runtime, directory, calls, options, work, projects, batch, model };
}
async function enqueue(source: Awaited<ReturnType<typeof fixture>>, selected = source.projects) {
  const input = { workId: source.work.id, workRevision: source.work.revision, requestId: randomUUID(), projects: selected.map(project => ({ projectId: project.id, revision: project.revision })) };
  return { input, result: productionQueueEnqueueResultSchema.parse(await source.runtime.dispatch('productionQueue.enqueue', input)) };
}
async function detail(runtime: ReturnType<typeof createRuntime>, queueId: string) { return productionQueueDetailSchema.parse(await runtime.dispatch('productionQueue.get', { queueId })); }
async function start(runtime: ReturnType<typeof createRuntime>, queue: ProductionQueue) { await runtime.dispatch('productionQueue.start', { queueId: queue.id, revision: queue.revision }); }

it('quotes the selected episodes by model and currency and invalidates the quote after a price change', async () => {
  const source = await fixture({ requireChargeConfirmation: true });
  const { runtime } = source;
  const image = modelSchema.parse(await runtime.dispatch('model.save', { model: {
    name: '队列图片模型', model: 'image-fixture', baseUrl: 'http://127.0.0.1:1/v1', provider: 'openai-compatible',
    connectionType: 'image', capabilities: ['image'], pricing: { currency: 'CNY', perImage: 0.25 },
  } }));
  const video = modelSchema.parse(await runtime.dispatch('model.save', { model: {
    name: '队列视频模型', model: 'video-fixture', baseUrl: 'http://127.0.0.1:1/v1', provider: 'openai-compatible',
    connectionType: 'video', capabilities: ['video'], parameters: { seconds: 5 }, pricing: { currency: 'USD', perVideoSecond: 0.1 },
  } }));
  const episodes = [];
  for (const project of source.projects.slice(0, 2)) {
    episodes.push(projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: {
      shots: [{ id: 'one', title: '一段视频', narration: '', visualPrompt: '一座桥', durationUs: 2_000_000 }],
      workflow: { ...project.workflow, nodes: [
        workflowNodeSchema.parse({ id: 'pictures', kind: 'assets', label: '出图', modelId: image.id }),
        workflowNodeSchema.parse({ id: 'clips', kind: 'animation', label: '出片', modelId: video.id }),
      ], edges: [{ id: 'next', source: 'pictures', target: 'clips' }] },
    } })));
  }
  const { result } = await enqueue(source, episodes);
  const method = 'productionQueue.start', params = { queueId: result.queue!.id, revision: result.queue!.revision };
  const prepare = async () => chargeConfirmationSchema.parse(await runtime.dispatch('billing.prepare', { method, params }));
  const priced = await prepare();
  expect(priced.estimate).toMatchObject({ batch: true, items: [
    { model: image.model, modelName: image.name, kind: 'image', count: 2, estimated: { currency: 'CNY', amount: 0.5 } },
    { model: video.model, modelName: video.name, kind: 'video', count: 2, videoSeconds: 10, estimated: { currency: 'USD', amount: 1 } },
  ], totals: [{ currency: 'CNY', amount: 0.5 }, { currency: 'USD', amount: 1 }] });

  await runtime.dispatch('model.save', { model: { ...image, pricing: null } });
  await expect(runtime.dispatch(method, { ...params, chargeConfirmationId: priced.confirmationId })).rejects.toThrow('预估费用已变化');
  const unknown = (await prepare()).estimate;
  expect(unknown?.items[0]).toMatchObject({ model: image.model, count: 2 });
  expect(unknown?.totals).toBeUndefined();
  expect((await detail(runtime, params.queueId)).queue.status).toBe('paused');
  expect(source.calls).toHaveLength(0);
});

it('pauses a previously running queue on desktop startup until its remaining episodes are approved', async () => {
  const source = await fixture();
  const { result } = await enqueue(source);
  const queue = result.queue!;
  await source.runtime.close();
  const database = openDatabase(source.directory);
  try { new DocumentStore(database).put('production-queue', queue.id, { ...queue, status: 'running' }); }
  finally { database.close(); }

  const recovered = createRuntime({ ...source.options, requireChargeConfirmation: true });
  runtimes.push(recovered);
  await recovered.waitForIdle();
  const paused = await detail(recovered, queue.id);
  expect(paused.queue.status).toBe('paused');
  expect(paused.items.every(item => item.status === 'queued' && !item.runId)).toBe(true);
  expect(source.calls).toHaveLength(0);

  const method = 'productionQueue.start', params = { queueId: queue.id, revision: paused.queue.revision };
  await expect(recovered.dispatch(method, params)).rejects.toThrow('请先确认此操作的费用影响');
  const { confirmationId, description } = chargeConfirmationSchema.parse(await recovered.dispatch('billing.prepare', { method, params }));
  expect(description).toContain('3 集');
  await recovered.dispatch(method, { ...params, chargeConfirmationId: confirmationId });
  await recovered.waitForIdle();
  expect((await detail(recovered, queue.id)).queue.status).toBe('succeeded');
  expect(source.calls).toHaveLength(6);
});

it('retries only the failed step of a queued episode and keeps later episodes waiting until explicit continuation', async () => {
  let mediaCalls = 0;
  const source = await fixture({ executeActivity: async () => { if (++mediaCalls === 1) throw new Error('controlled queue media failure'); return { assets: [] }; } });
  const first = source.projects[0];
  source.projects[0] = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: first.id, revision: first.revision, patch: { workflow: {
    ...first.workflow, nodes: [...first.workflow.nodes, workflowNodeSchema.parse({ id: 'images', kind: 'assets', label: '待重试素材' }), workflowNodeSchema.parse({ id: 'finish', kind: 'join', label: '后续收尾' })],
    edges: [...first.workflow.edges, { id: 'media', source: 'style', target: 'images' }, { id: 'finish', source: 'images', target: 'finish' }],
  } } }));
  const { result } = await enqueue(source); await start(source.runtime, result.queue!); await source.runtime.waitForIdle();
  const failed = await detail(source.runtime, result.queue!.id), runId = failed.items[0].runId!;
  expect(failed.items.map(item => item.status)).toEqual(['failed', 'queued', 'queued']); expect(source.calls).toHaveLength(2);
  await source.runtime.dispatch('run.step.retry', { runId, nodeId: 'images' }); await source.runtime.waitForIdle();
  const retried = await detail(source.runtime, result.queue!.id);
  expect(retried.items.map(item => item.status)).toEqual(['needs_attention', 'queued', 'queued']); expect(source.calls).toHaveLength(2); expect(mediaCalls).toBe(2);
  const inspection = runInspectionSchema.parse(await source.runtime.dispatch('run.inspect', { runId }));
  expect(inspection.steps.find(step => step.id === 'images')?.status).toBe('succeeded'); expect(inspection.steps.find(step => step.id === 'finish')?.status).toBe('pending');
  await source.runtime.dispatch('run.resume', { runId }); await source.runtime.waitForIdle();
  expect((await detail(source.runtime, result.queue!.id)).items.map(item => item.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  expect(source.calls).toHaveLength(6); expect(mediaCalls).toBe(2);
});

it('creates episodes atomically and idempotently, projects their membership and applies work defaults explicitly', async () => {
  const source = await fixture();
  const repeated = await source.runtime.dispatch('work.episodes.create', source.batch) as ProjectDocument[];
  expect(repeated.map(value => value.id)).toEqual(source.projects.map(value => value.id));
  await expect(source.runtime.dispatch('work.episodes.create', { ...source.batch, episodes: [{ number: 4, title: '第四集', originalText: '' }] })).rejects.toThrow('标识已用于');
  await expect(source.runtime.dispatch('work.episodes.create', { ...source.batch, requestId: randomUUID(), episodes: [{ number: 4, title: '第四集', originalText: '' }, { number: 2, title: '编号冲突', originalText: '' }] })).rejects.toThrow('第 2 集已存在');
  const summary = await source.runtime.dispatch('workspace.summary') as { projects: unknown[] };
  expect(summary.projects.map(value => projectSummarySchema.parse(value).episode?.number).sort()).toEqual([1, 2, 3]);
  const next = workSchema.parse(await source.runtime.dispatch('work.save', { ...source.work, defaults: { ...source.work.defaults, style: '新的作品风格' } }));
  const current = async (id: string) => (await source.runtime.dispatch('project.get', { projectId: id }) as { project: ProjectDocument }).project;
  expect((await current(source.projects[0].id)).style).toBe('作品水彩');
  await source.runtime.dispatch('work.defaults.apply', { workId: next.id, revision: next.revision, projects: [{ projectId: source.projects[0].id, revision: source.projects[0].revision }], fields: ['style'] });
  expect((await current(source.projects[0].id)).style).toBe('新的作品风格'); expect((await current(source.projects[1].id)).style).toBe('作品水彩');
  const invalid = [{ projectId: source.projects[1].id, revision: source.projects[1].revision }, { projectId: source.projects[2].id, revision: 999 }];
  await expect(source.runtime.dispatch('work.defaults.apply', { workId: next.id, revision: next.revision, projects: invalid })).rejects.toThrow('分集项目已修改');
  expect((await current(source.projects[1].id)).style).toBe('作品水彩');
});

it('increments the episode workflow version only when applied production defaults change', async () => {
  const { runtime, work, projects: [project] } = await fixture();
  const applyProduction = async (source: StoryWork, target: ProjectDocument) => {
    const [saved] = projectSchema.array().parse(await runtime.dispatch('work.defaults.apply', {
      workId: source.id, revision: source.revision, projects: [{ projectId: target.id, revision: target.revision }], fields: ['production'],
    }));
    return saved;
  };
  const unchanged = await applyProduction(work, project);
  expect(unchanged.workflow.version).toBe(project.workflow.version);
  const nextWork = workSchema.parse(await runtime.dispatch('work.save', {
    ...work, defaults: { ...work.defaults, production: { ...work.defaults.production, subtitleMode: 'script' } },
  }));
  const changed = await applyProduction(nextWork, unchanged);
  expect(changed.workflow.version).toBe(unchanged.workflow.version + 1);
  expect(changed.workflow.production.subtitleMode).toBe('script');
  expect((await applyProduction(nextWork, changed)).workflow.version).toBe(changed.workflow.version);
});

it('reserves episode numbers including archived projects and keeps an imported episode independent with its provenance', async () => {
  const source = await fixture(), project = source.projects[0];
  const backup = await source.runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const manifest = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')); expect(manifest.schemaVersion).toBe(7);
  const imported = projectSchema.parse(await source.runtime.dispatch('project.importBackup', { path: backup.path }));
  expect(imported.episode).toBeUndefined(); expect(imported.episodeSource).toMatchObject({ workTitle: source.work.title, number: 1, originalText: source.batch.episodes[0].originalText });
  await expect(source.runtime.dispatch('work.episode.attach', { workId: source.work.id, workRevision: source.work.revision, projectId: imported.id, revision: imported.revision, number: 1 })).rejects.toThrow('已存在');
  await source.runtime.dispatch('project.archive', { projectId: project.id });
  await expect(source.runtime.dispatch('work.episode.attach', { workId: source.work.id, workRevision: source.work.revision, projectId: imported.id, revision: imported.revision, number: 1 })).rejects.toThrow('已存在');
  const attached = projectSchema.parse(await source.runtime.dispatch('work.episode.attach', { workId: source.work.id, workRevision: source.work.revision, projectId: imported.id, revision: imported.revision, number: 4 }));
  expect(attached.episode?.number).toBe(4);
  await writeFile(join(backup.path, 'project.json'), JSON.stringify({ ...manifest, schemaVersion: 6 }));
  await expect(source.runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('格式 7');
});

it('deduplicates active projects across requests and runs episodes in the recorded order using ordinary snapshots', async () => {
  const source = await fixture(), { input, result } = await enqueue(source, [...source.projects].reverse());
  const queue = result.queue!;
  expect(source.calls).toHaveLength(0);
  const repeated = productionQueueEnqueueResultSchema.parse(await source.runtime.dispatch('productionQueue.enqueue', input)); expect(repeated.items.map(value => value.id)).toEqual(result.items.map(value => value.id));
  const duplicate = productionQueueEnqueueResultSchema.parse(await source.runtime.dispatch('productionQueue.enqueue', { ...input, requestId: randomUUID() })); expect(duplicate.queue).toBeNull(); expect(duplicate.reused).toHaveLength(3);
  await expect(source.runtime.dispatch('run.start', { projectId: source.projects[0].id })).rejects.toThrow('排队项');
  await expect(source.runtime.dispatch('project.archive', { projectId: source.projects[0].id })).rejects.toThrow('生产队列');
  const independent = projectSchema.parse(await source.runtime.dispatch('project.create', { title: '批量回收中的独立项目' }));
  await expect(source.runtime.dispatch('project.archiveMany', { projectIds: [independent.id, source.projects[0].id] })).rejects.toThrow('生产队列');
  expect(await source.runtime.dispatch('project.get', { projectId: independent.id })).toMatchObject({ project: { id: independent.id, revision: independent.revision, archived: false } });
  await start(source.runtime, queue); await source.runtime.waitForIdle();
  const finished = await detail(source.runtime, queue.id); expect(finished.queue.status).toBe('succeeded'); expect(finished.items.map(value => value.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
  expect(source.calls.filter(prompt => prompt.includes('步骤：简报')).map(prompt => prompt.match(/项目标题：([^\n]+)/)?.[1])).toEqual(['第3集', '第2集', '第1集']);
  expect(source.calls).toHaveLength(6);
  const run = runSchema.parse(await source.runtime.dispatch('run.get', { runId: finished.items[0].runId })); expect(run.productionQueueId).toBe(queue.id); expect(run.productionQueueItemId).toBe(finished.items[0].id);
  expect(await source.runtime.dispatch('run.replay', { runId: run.id })).toMatchObject({ matchesSnapshot: true, externalCalls: 0 });
  const database = openDatabase(source.directory);
  try { expect(new DocumentStore(database).get('run-snapshot', run.id)).toMatchObject({ project: { id: source.projects[2].id, revision: source.projects[2].revision } }); } finally { database.close(); }
});

it('pauses only future dispatch and requires an explicit input refresh after a pending project changes', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  let calls = 0;
  const source = await fixture({ provider: async () => { calls++; if (calls === 1) await gate; return '完成'; } });
  const { result } = await enqueue(source); await start(source.runtime, result.queue!);
  await expect.poll(() => calls).toBe(1);
  const active = await detail(source.runtime, result.queue!.id);
  await source.runtime.dispatch('productionQueue.pause', { queueId: active.queue.id, revision: active.queue.revision });
  release(); await source.runtime.waitForIdle();
  const paused = await detail(source.runtime, active.queue.id); expect(paused.queue.status).toBe('paused'); expect(paused.items.map(value => value.status)).toEqual(['succeeded', 'queued', 'queued']); expect(calls).toBe(2);
  const changed = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.projects[1].id, revision: source.projects[1].revision, patch: { title: '人工修改的第二集' } }));
  await start(source.runtime, paused.queue); await source.runtime.waitForIdle();
  const blocked = await detail(source.runtime, active.queue.id); expect(blocked.queue.status).toBe('needs_attention'); expect(blocked.items[1].status).toBe('needs_attention'); expect(blocked.items[1].runId).toBeUndefined(); expect(calls).toBe(2);
  await source.runtime.dispatch('productionQueue.refreshItem', { itemId: blocked.items[1].id, revision: blocked.items[1].revision, projectRevision: changed.revision });
  await start(source.runtime, (await detail(source.runtime, active.queue.id)).queue); await source.runtime.waitForIdle();
  expect((await detail(source.runtime, active.queue.id)).queue.status).toBe('succeeded'); expect(calls).toBe(6);
});

it('stops after an ambiguous submission and keeps the original run on resume without charging twice', async () => {
  let failed = false;
  const source = await fixture({ failpoint(point) { if (point === 'after-result' && !failed) { failed = true; throw new SimulatedProcessExit(); } } });
  const { result } = await enqueue(source); await start(source.runtime, result.queue!); await source.runtime.waitForIdle();
  expect(source.calls).toHaveLength(1);
  // Reopen to exercise persisted ownership and the existing activity journal.
  await source.runtime.close(); runtimes.splice(runtimes.indexOf(source.runtime), 1);
  const recovered = createRuntime({ ...source.options, failpoint: undefined }); runtimes.push(recovered); await recovered.waitForIdle();
  const blocked = await detail(recovered, result.queue!.id); expect(blocked.queue.status).toBe('needs_attention'); expect(blocked.items[0].runId).toBeDefined(); expect(blocked.items[1].status).toBe('queued');
  await recovered.dispatch('run.resume', { runId: blocked.items[0].runId }); await recovered.waitForIdle();
  const again = await detail(recovered, result.queue!.id); expect(again.queue.status).toBe('needs_attention'); expect(again.items[0].runId).toBe(blocked.items[0].runId); expect(source.calls).toHaveLength(1);
});

it('recovers the committed run and advances once after explicit continuation', async () => {
  let failed = false;
  const source = await fixture({ failpoint(point) { if (point === 'after-commit' && !failed) { failed = true; throw new SimulatedProcessExit(); } } });
  const { result } = await enqueue(source); await start(source.runtime, result.queue!); await source.runtime.waitForIdle();
  await source.runtime.close(); runtimes.splice(runtimes.indexOf(source.runtime), 1);
  const recovered = createRuntime({ ...source.options, failpoint: undefined }); runtimes.push(recovered); await recovered.waitForIdle();
  const blocked = await detail(recovered, result.queue!.id), originalRun = blocked.items[0].runId;
  await recovered.dispatch('productionQueue.resumeItem', { itemId: blocked.items[0].id, revision: blocked.items[0].revision }); await recovered.waitForIdle();
  const finished = await detail(recovered, result.queue!.id); expect(finished.queue.status).toBe('succeeded'); expect(finished.items[0].runId).toBe(originalRun); expect(source.calls).toHaveLength(6);
});

it('cancels future items separately from the active run and prevents restarting a canceled queue-owned run', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  let calls = 0;
  const source = await fixture({ provider: async () => { calls++; if (calls === 1) await gate; return '完成'; } });
  const { result } = await enqueue(source); await start(source.runtime, result.queue!); await expect.poll(() => calls).toBe(1);
  const active = await detail(source.runtime, result.queue!.id);
  await source.runtime.dispatch('productionQueue.cancel', { queueId: active.queue.id, revision: active.queue.revision });
  const canceled = await detail(source.runtime, active.queue.id); expect(canceled.items.map(value => value.status)).toEqual(['running', 'canceled', 'canceled']);
  await source.runtime.dispatch('productionQueue.stopCurrent', { itemId: canceled.items[0].id, revision: canceled.items[0].revision }); release(); await source.runtime.waitForIdle();
  const finished = await detail(source.runtime, active.queue.id); expect(finished.items[0].status).toBe('canceled'); expect(calls).toBe(1);
  await expect(source.runtime.dispatch('run.resume', { runId: finished.items[0].runId })).rejects.toThrow();
});

it.each(['pause', 'cancel'] as const)('honors %s while the next episode is still preparing its snapshot', async action => {
  const source = await fixture(), { runtime } = source;
  const folder = join(source.directory, 'source-skill'); await mkdir(folder);
  await writeFile(join(folder, 'SKILL.md'), '---\nname: queue-reference\ndescription: 夹具\n---\n参阅 notes.md。');
  await writeFile(join(folder, 'notes.md'), '制作要求');
  const skill = (await importSkillFixture(runtime.dispatch, { path: folder })).skills[0];
  const project = source.projects[0];
  const updated = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision,
    patch: { workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => ({ ...node, skillIds: [skill.id] })) } } }));
  const { result } = await enqueue(source, [updated]);
  const started = productionQueueSchema.parse(await runtime.dispatch('productionQueue.start', { queueId: result.queue!.id, revision: result.queue!.revision }));
  await runtime.dispatch('productionQueue.' + action, { queueId: started.id, revision: started.revision }); await runtime.waitForIdle();
  const final = await detail(runtime, started.id);
  expect(final.queue.status).toBe(action === 'pause' ? 'paused' : 'canceled');
  expect(final.items[0]).toMatchObject({ status: action === 'pause' ? 'queued' : 'canceled' });
  expect(final.items[0].runId).toBeUndefined(); expect(source.calls).toEqual([]);
  if (action === 'cancel') expect((await enqueue(source, [updated])).result.queue?.status).toBe('paused');
  else {
    await start(runtime, final.queue); await runtime.waitForIdle();
    expect((await detail(runtime, started.id)).queue.status).toBe('succeeded');
  }
});

it('releases a stranded reservation left by an older canceled queue when the workspace reopens', async () => {
  const source = await fixture(), { result } = await enqueue(source, [source.projects[0]]);
  const queue = result.queue!, item = result.items[0];
  await source.runtime.close(); runtimes.splice(runtimes.indexOf(source.runtime), 1);
  const database = openDatabase(source.directory), store = new DocumentStore(database);
  try {
    store.put('production-queue', queue.id, { ...queue, status: 'canceled' });
    store.put('production-queue-item', item.id, { ...item, status: 'needs_attention', error: '生产队列已变化' });
  } finally { database.close(); }
  const runtime = createRuntime(source.options); runtimes.push(runtime); await runtime.waitForIdle();
  expect((await detail(runtime, queue.id)).items[0].status).toBe('canceled');
  expect((await enqueue({ ...source, runtime }, [source.projects[0]])).result.queue?.status).toBe('paused');
});

it('captures a fresh snapshot if a paused queue is restarted before preparation ends', async () => {
  const used: string[] = [];
  const source = await fixture({ provider: async ({ model }) => { used.push(model.model); return '完成'; } }), { runtime } = source;
  const folder = join(source.directory, 'restart-skill'); await mkdir(folder);
  await writeFile(join(folder, 'SKILL.md'), '---\nname: restart-reference\ndescription: 夹具\n---\n参阅 notes.md。');
  await writeFile(join(folder, 'notes.md'), '制作要求');
  const skill = (await importSkillFixture(runtime.dispatch, { path: folder })).skills[0];
  const project = source.projects[0];
  const updated = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision,
    patch: { workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => ({ ...node, skillIds: [skill.id] })) } } }));
  const { result } = await enqueue(source, [updated]);
  const started = productionQueueSchema.parse(await runtime.dispatch('productionQueue.start', { queueId: result.queue!.id, revision: result.queue!.revision }));
  const paused = productionQueueSchema.parse(await runtime.dispatch('productionQueue.pause', { queueId: started.id, revision: started.revision }));
  await runtime.dispatch('model.save', { model: { ...source.model, model: 'updated-model' } });
  await start(runtime, paused); await runtime.waitForIdle();
  expect((await detail(runtime, started.id)).queue.status).toBe('succeeded');
  expect(used).toEqual(['updated-model', 'updated-model']);
});

it('protects characters used by work defaults and retains ordinary independent projects', async () => {
  const source = await fixture();
  const character = characterProfileSchema.parse(await source.runtime.dispatch('character.save', { character: { name: '作品角色', description: '蓝外衣', referenceAssetIds: [] } }));
  const work = workSchema.parse(await source.runtime.dispatch('work.save', { ...source.work, defaults: { ...source.work.defaults, creativeContext: { characterIds: [character.id], entities: [], continuity: '' } } }));
  await expect(source.runtime.dispatch('character.archive', { characterId: character.id, revision: character.revision })).rejects.toThrow('作品默认设置');
  const independent = projectSchema.parse(await source.runtime.dispatch('project.create', { title: '独立项目' })); expect(independent.episode).toBeUndefined();
  expect(work.defaults.creativeContext?.characterIds).toEqual([character.id]);
});

it('rolls back all episode writes and the request receipt when a database write fails mid-batch', async () => {
  const source = await fixture(), database = openDatabase(source.directory);
  const input = { workId: source.work.id, revision: source.work.revision, requestId: randomUUID(), episodes: [{ number: 4, title: '第四集', originalText: '' }, { number: 5, title: '拒绝写入', originalText: '' }] };
  try {
    database.exec("CREATE TRIGGER fixture_reject_project BEFORE INSERT ON documents WHEN new.kind = 'project' AND json_extract(new.body, '$.title') = '拒绝写入' BEGIN SELECT RAISE(ABORT, 'fixture project failure'); END");
    await expect(source.runtime.dispatch('work.episodes.create', input)).rejects.toThrow('fixture project failure');
    expect(database.prepare("SELECT count(*) AS count FROM documents WHERE kind = 'project' AND json_extract(body, '$.episode.number') IN (4, 5)").get()).toEqual({ count: 0 });
    expect(new DocumentStore(database).get('episode-create-request', input.requestId)).toBeUndefined();
    database.exec('DROP TRIGGER fixture_reject_project');
    expect(await source.runtime.dispatch('work.episodes.create', input)).toHaveLength(2);
  } finally { database.close(); }
});

it('commits the queue claim and run snapshot atomically and retains database uniqueness under competing writes', async () => {
  const source = await fixture(), { result } = await enqueue(source, [source.projects[0]]), database = openDatabase(source.directory);
  try {
    database.exec("CREATE TRIGGER fixture_reject_run BEFORE INSERT ON documents WHEN new.kind = 'run' BEGIN SELECT RAISE(ABORT, 'fixture run failure'); END");
    await start(source.runtime, result.queue!); await source.runtime.waitForIdle();
    const blocked = await detail(source.runtime, result.queue!.id); expect(blocked.items[0].runId).toBeUndefined(); expect(blocked.items[0].status).toBe('needs_attention');
    expect(database.prepare("SELECT count(*) AS count FROM documents WHERE kind IN ('run','run-snapshot')").get()).toEqual({ count: 0 });
    expect(() => new DocumentStore(database).put('production-queue-item', 'competing', { ...blocked.items[0], id: 'competing' })).toThrow('UNIQUE');
    database.exec('DROP TRIGGER fixture_reject_run');
    await source.runtime.dispatch('productionQueue.refreshItem', { itemId: blocked.items[0].id, revision: blocked.items[0].revision, projectRevision: source.projects[0].revision });
    await start(source.runtime, (await detail(source.runtime, result.queue!.id)).queue); await source.runtime.waitForIdle();
    expect((await detail(source.runtime, result.queue!.id)).queue.status).toBe('succeeded'); expect(source.calls).toHaveLength(2);
  } finally { database.close(); }
});

it('deduplicates concurrent enqueue requests and serializes separate queues', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  let calls = 0;
  const source = await fixture({ provider: async () => { calls++; if (calls === 1) await gate; return '完成'; } });
  const [first, duplicate] = await Promise.all([enqueue(source, [source.projects[0]]), enqueue(source, [source.projects[0]])]);
  expect([first.result.queue, duplicate.result.queue].filter(Boolean)).toHaveLength(1);
  const primary = first.result.queue ?? duplicate.result.queue!;
  const second = await enqueue(source, source.projects.slice(1));
  await start(source.runtime, primary); await start(source.runtime, second.result.queue!); await expect.poll(() => calls).toBe(1);
  expect((await detail(source.runtime, second.result.queue!.id)).items.every(item => item.status === 'queued')).toBe(true);
  release(); await source.runtime.waitForIdle();
  expect((await detail(source.runtime, second.result.queue!.id)).queue.status).toBe('succeeded'); expect(calls).toBe(6);
});

it('stops subsequent dispatch when the active project changes and retains the human edit and generated output', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  let calls = 0;
  const source = await fixture({ provider: async () => { calls++; if (calls === 1) await gate; return '生成结果'; } });
  const { result } = await enqueue(source); await start(source.runtime, result.queue!); await expect.poll(() => calls).toBe(1);
  const modified = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.projects[0].id, revision: source.projects[0].revision, patch: { brief: '制作期间的人工编辑' } }));
  release(); await source.runtime.waitForIdle();
  const blocked = await detail(source.runtime, result.queue!.id); expect(blocked.queue.status).toBe('needs_attention'); expect(blocked.items[0].error).toContain('制作期间已修改'); expect(calls).toBe(2);
  expect((await source.runtime.dispatch('project.get', { projectId: modified.id }) as { project: ProjectDocument }).project.brief).toBe(modified.brief);
  expect(await source.runtime.dispatch('node.result', { runId: blocked.items[0].runId, nodeId: 'brief' })).toMatchObject({ text: '生成结果' });
  await source.runtime.dispatch('productionQueue.skipItem', { itemId: blocked.items[0].id, revision: blocked.items[0].revision });
  await start(source.runtime, (await detail(source.runtime, result.queue!.id)).queue); await source.runtime.waitForIdle(); expect(calls).toBe(6);
});

it('preserves a failed run, skips it explicitly and continues only after the operator starts the queue', async () => {
  let calls = 0;
  const source = await fixture({ provider: async () => { calls++; if (calls === 1) throw new Error('fixture provider failed'); return '后续分集完成'; } });
  const { result } = await enqueue(source); await start(source.runtime, result.queue!); await source.runtime.waitForIdle();
  const blocked = await detail(source.runtime, result.queue!.id); expect(blocked.queue.status).toBe('needs_attention'); expect(blocked.items[0].status).toBe('failed'); expect(blocked.items[0].runId).toBeDefined(); expect(calls).toBe(1);
  await source.runtime.dispatch('productionQueue.skipItem', { itemId: blocked.items[0].id, revision: blocked.items[0].revision }); await source.runtime.waitForIdle(); expect(calls).toBe(1);
  const paused = await detail(source.runtime, result.queue!.id); expect(paused.queue.status).toBe('paused'); expect(paused.items[0].runId).toBe(blocked.items[0].runId);
  await start(source.runtime, paused.queue); await source.runtime.waitForIdle(); expect((await detail(source.runtime, result.queue!.id)).queue.status).toBe('succeeded'); expect(calls).toBe(5);
});

it('finishes a paused queue when its last active episode completes', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  let calls = 0;
  const source = await fixture({ provider: async () => { calls++; if (calls === 1) await gate; return '完成'; } });
  const { result } = await enqueue(source, [source.projects[0]]); await start(source.runtime, result.queue!); await expect.poll(() => calls).toBe(1);
  const active = await detail(source.runtime, result.queue!.id); await source.runtime.dispatch('productionQueue.pause', { queueId: active.queue.id, revision: active.queue.revision }); release(); await source.runtime.waitForIdle();
  expect((await detail(source.runtime, result.queue!.id)).queue.status).toBe('succeeded'); expect(calls).toBe(2);
});

it('reconciles a completed run after interruption between run completion and queue projection without generating again', async () => {
  const source = await fixture(), { result } = await enqueue(source); await start(source.runtime, result.queue!); await source.runtime.waitForIdle();
  const finished = await detail(source.runtime, result.queue!.id);
  await source.runtime.close(); runtimes.splice(runtimes.indexOf(source.runtime), 1);
  const database = openDatabase(source.directory), store = new DocumentStore(database);
  store.put('production-queue', finished.queue.id, { ...finished.queue, status: 'running' });
  store.put('production-queue-item', finished.items[0].id, { ...finished.items[0], status: 'running' }); database.close();
  const recovered = createRuntime(source.options); runtimes.push(recovered); await recovered.waitForIdle();
  expect((await detail(recovered, result.queue!.id)).queue.status).toBe('succeeded'); expect(source.calls).toHaveLength(6);
});

it('prevents an older ordinary run from resuming around a current queue reservation', async () => {
  let calls = 0;
  const source = await fixture({ provider: async () => { calls++; throw new Error('fixture provider failure'); } });
  const ordinary = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.projects[0].id })); await source.runtime.waitForIdle();
  const queued = await enqueue(source, [source.projects[0]]);
  await expect(source.runtime.dispatch('run.resume', { runId: ordinary.id })).rejects.toThrow('生产队列');
  expect(calls).toBe(1); expect((await detail(source.runtime, queued.result.queue!.id)).items[0].runId).toBeUndefined();
});
