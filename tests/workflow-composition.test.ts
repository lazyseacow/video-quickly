import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { projectDetailSchema, projectSchema, workflowNodeSchema, workflowSchema, validateWorkflowComposition, type ProjectDocument, type RunRecord, type WorkflowTemplate, type RunInspection } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit } from '../packages/runtime/src/index';
import { ProjectEditSession, savedEditsSchema } from '../apps/desktop/src/lib/project-edits';
import { openDatabase, DocumentStore } from '../packages/runtime/src/database';

const runtimes: ReturnType<typeof createRuntime>[] = [], directories: string[] = [];
afterEach(async () => { await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function runtime(options: Partial<Parameters<typeof createRuntime>[0]> = {}) { const directory = options.dataDirectory ?? await mkdtemp(join(tmpdir(), 'vq-composition-')); if (!directories.includes(directory)) directories.push(directory); const value = createRuntime({ dataDirectory: directory, ...options }); runtimes.push(value); return { value, directory }; }
const node = (id: string, more: Partial<ReturnType<typeof workflowNodeSchema.parse>> = {}) => workflowNodeSchema.parse({ id, kind: 'brief', label: id, ...more });
async function fixture(options: Partial<Parameters<typeof createRuntime>[0]> = {}, review = false) {
  const { value, directory } = await runtime(options), project = await value.dispatch('project.create', { title: '子流程', brief: '冻结简报' }) as ProjectDocument;
  const template = await value.dispatch('workflowTemplate.save', { name: '可复用版本', workflow: workflowSchema.parse({ id: 'body', version: 1, name: 'body', nodes: [node('first', { requiresReview: review }), node('last', { requiresReview: review })], edges: [{ id: 'e', source: 'first', target: 'last' }] }), outputs: [{ name: 'brief', nodeId: 'last', path: ['brief'] }] }) as WorkflowTemplate;
  const updated = await value.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: workflowSchema.parse({ id: 'parent', version: 1, name: 'parent', nodes: [node('call', { kind: 'subflow', subflow: { id: template.id, version: 1, inputs: {} } }), node('after')], edges: [{ id: 'e', source: 'call', target: 'after' }], subflows: [template.definition] }) }) as ProjectDocument;
  return { value, directory, project: updated, template };
}
it('runs a copied fixed version, records a separate native checkpoint and exposes namespaced steps', async () => {
  const { value, directory, project, template } = await fixture();
  await value.dispatch('workflowTemplate.save', { templateId: template.id, revision: template.revision, name: 'new version', workflow: workflowSchema.parse({ id: 'v2', version: 1, name: 'v2', nodes: [node('different')], edges: [] }) });
  const run = await value.dispatch('run.start', { projectId: project.id }) as RunRecord; await value.waitForIdle();
  const inspection = await value.dispatch('run.inspect', { runId: run.id }) as RunInspection;
  expect(inspection.run.status).toBe('succeeded'); expect(inspection.steps.map(step => step.id)).toEqual(['call', 'call/subflow/first', 'call/subflow/last', 'after']); expect(inspection.steps.every(step => step.status === 'succeeded')).toBe(true);
  expect(await value.dispatch('node.result', { runId: run.id, nodeId: 'call' })).toMatchObject({ outputs: { brief: '冻结简报' }, version: 1 });
  const db = openDatabase(directory); try { expect((db.prepare("SELECT count(*) AS n FROM checkpoints WHERE thread_id = ?").get(`${run.id}:subflow:call`) as { n: number }).n).toBeGreaterThan(0); expect(new DocumentStore(db).get('run-snapshot', run.id)).toMatchObject({ handlerVersion: 3 }); } finally { db.close(); }
  const firstVersion = await value.dispatch('workflowTemplate.get', { templateId: template.id, version: 1 }) as WorkflowTemplate; expect(firstVersion.definition.nodes[0].id).toBe('first');
});
it('bridges two child review interrupts without approving the next one implicitly, and resumes after restart', async () => {
  const { value, directory, project } = await fixture({}, true);
  const run = await value.dispatch('run.start', { projectId: project.id }) as RunRecord; await value.waitForIdle();
  expect((await value.dispatch('run.inspect', { runId: run.id }) as RunInspection).run).toMatchObject({ status: 'waiting_review', currentNodeId: 'call/subflow/first' });
  await value.dispatch('run.review', { runId: run.id, approved: true }); await value.waitForIdle();
  const secondReview = (await value.dispatch('run.inspect', { runId: run.id }) as RunInspection).run; expect(secondReview.status, secondReview.error).toBe('waiting_review'); expect(secondReview.currentNodeId).toBe('call/subflow/last');
  await value.close(); const second = await runtime({ dataDirectory: directory });
  await second.value.dispatch('run.review', { runId: run.id, approved: true }); await second.value.waitForIdle();
  const resumed = (await second.value.dispatch('run.inspect', { runId: run.id }) as RunInspection).run; expect(resumed.status, resumed.error).toBe('succeeded');
});
it('reuses child activities committed before checkpoint and does not mutate the authoring project', async () => {
  let crashed = false;
  const { value, directory, project } = await fixture({ failpoint(point, id) { if (!crashed && point === 'after-commit' && id === 'call/subflow/first') { crashed = true; throw new SimulatedProcessExit(); } } });
  const run = await value.dispatch('run.start', { projectId: project.id }) as RunRecord; await value.waitForIdle(); await value.close();
  const second = await runtime({ dataDirectory: directory }); await second.value.dispatch('run.resume', { runId: run.id }); await second.value.waitForIdle();
  const resumed = (await second.value.dispatch('run.inspect', { runId: run.id }) as RunInspection).run; expect(resumed.status, resumed.error).toBe('succeeded');
  expect(projectDetailSchema.parse(await second.value.dispatch('project.get', { projectId: project.id })).project).toEqual(project);
});
it('validates input contracts and resolves upstream values into actual child prompts', async () => {
  const prompts: string[] = [];
  const { value } = await runtime({ provider: async context => { prompts.push(context.prompt); return { text: 'done' }; } });
  const project = await value.dispatch('project.create', { title: '参数', brief: '输入简报' }) as ProjectDocument;
  const model = await value.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1', capabilities: ['text'] } }) as { id: string };
  const template = await value.dispatch('workflowTemplate.save', { name: '参数流程', inputs: [{ name: 'subject', type: 'string', required: true }], workflow: workflowSchema.parse({ id: 'body', version: 1, name: 'body', nodes: [node('write', { modelId: model.id, prompt: '主题={{input.subject}}' })], edges: [] }) }) as WorkflowTemplate;
  await value.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: workflowSchema.parse({ id: 'parent', version: 1, name: 'parent', nodes: [node('source'), node('call', { kind: 'subflow', subflow: { id: template.id, version: 1, inputs: { subject: { nodeId: 'source', path: ['brief'] } } } })], edges: [{ id: 'edge', source: 'source', target: 'call' }], subflows: [template.definition] }) });
  const run = await value.dispatch('run.start', { projectId: project.id }) as RunRecord; await value.waitForIdle(); expect((await value.dispatch('run.inspect', { runId: run.id }) as RunInspection).run.status).toBe('succeeded'); expect(prompts[0]).toContain('主题=输入简报');
});

it('rejects changes to an already inserted version through both workflow and project save', async () => {
  const { value, project } = await fixture();
  const workflow = structuredClone(project.workflow); workflow.subflows![0].nodes[0].prompt = 'unversioned replacement';
  await expect(value.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow })).rejects.toThrow('不能原地修改');
  await expect(value.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow } })).rejects.toThrow('不能原地修改');
  expect(projectDetailSchema.parse(await value.dispatch('project.get', { projectId: project.id })).project).toEqual(project);
});
it('bounds nested reuse before expanding an exponential snapshot and rejects recursive definitions', () => {
  const definitions = Array.from({ length: 4 }, (_, depth) => ({ id: `depth-${depth}`, version: 1, name: `depth-${depth}`, description: '', inputs: [], outputs: [], nodes: depth === 3 ? Array.from({ length: 10 }, (_, index) => node(`leaf-${index}`)) : Array.from({ length: 10 }, (_, index) => node(`call-${index}`, { kind: 'subflow', subflow: { id: `depth-${depth + 1}`, version: 1, inputs: {} } })), edges: [] }));
  const workflow = workflowSchema.parse({ id: 'limit', version: 1, name: 'limit', nodes: [node('top', { kind: 'subflow', subflow: { id: 'depth-0', version: 1, inputs: {} } })], edges: [], subflows: definitions });
  expect(() => validateWorkflowComposition(workflow)).toThrow('1000');
  workflow.subflows![3].nodes = [node('loop', { kind: 'subflow', subflow: { id: 'depth-0', version: 1, inputs: {} } })];
  expect(() => validateWorkflowComposition(workflow)).toThrow('递归');
});
it('preserves composition and parallel settings through incremental undo and recovered drafts', async () => {
  const { project } = await fixture(), session = new ProjectEditSession(project);
  const execution = { maxConcurrentShots: 3, modelLimits: { fixture: 2 } };
  session.edit({ ...session.state.present, workflow: { ...project.workflow, execution } }, '设置并行');
  const restored = new ProjectEditSession(project, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
  expect(restored.state.present.workflow.execution).toEqual(execution); restored.undo(); expect(restored.state.present.workflow.execution).toBeUndefined(); restored.redo(); expect(restored.state.present.workflow.execution).toEqual(execution);
  restored.edit({ ...restored.state.present, workflow: { ...restored.state.present.workflow, nodes: [], edges: [], subflows: undefined } }, '移除子流程'); restored.undo(); expect(restored.state.present.workflow.subflows).toEqual(project.workflow.subflows);
});
function animatedBackupShot() {
  return { id: 'backup-shot', title: '关键帧备份', narration: '', visualPrompt: '', durationUs: 2_000_000, animation: { transition: 'cut', panX: .03, panY: -.04, zoom: 1.2, keyframes: [
    { id: 'motion-first', timeUs: 100_000, panX: -.15, panY: .08, zoom: 1.05, easing: 'cubic-bezier', curve: [.16, .4, .83, .67] },
    { id: 'motion-last', timeUs: 1_700_000, panX: .25, panY: -.12, zoom: 1.6, easing: 'linear' },
  ] } };
}
it('backs up fixed composition and complete keyframes in format three independently of the template library', async () => {
  const { value, project, template } = await fixture();
  const configured = projectSchema.parse(await value.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [animatedBackupShot()] } }));
  await value.dispatch('workflowTemplate.save', { templateId: template.id, revision: template.revision, name: '后续模板版本', workflow: workflowSchema.parse({ id: 'latest', name: 'latest', version: 1, nodes: [node('latest-only')], edges: [] }) });
  const { path } = await value.dispatch('project.backup', { projectId: configured.id }) as { path: string };
  const manifestPath = join(path, 'project.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8')); expect(manifest.schemaVersion).toBe(3);
  const isolated = await runtime({ seed: false }); const restored = projectSchema.parse(await isolated.value.dispatch('project.importBackup', { path }));
  expect(restored.id).not.toBe(configured.id); expect(restored.workflow).toEqual(configured.workflow);
  expect(restored.shots[0].animation).toEqual(configured.shots[0].animation);
  expect(projectDetailSchema.parse(await isolated.value.dispatch('project.get', { projectId: restored.id })).project?.shots[0].animation).toEqual(configured.shots[0].animation);
  const run = await isolated.value.dispatch('run.start', { projectId: restored.id }) as RunRecord; await isolated.value.waitForIdle();
  const inspection = await isolated.value.dispatch('run.inspect', { runId: run.id }) as RunInspection; expect(inspection.run.status).toBe('succeeded'); expect(inspection.steps.map(step => step.id)).toEqual(['call', 'call/subflow/first', 'call/subflow/last', 'after']);
  expect(await isolated.value.dispatch('node.result', { runId: run.id, nodeId: 'call' })).toMatchObject({ version: 1, outputs: { brief: configured.brief } });
  for (const schemaVersion of [1, 2]) { await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion })); await expect(isolated.value.dispatch('project.importBackup', { path })).rejects.toThrow('格式 3'); }
});
it('requires format three for keyframes alone and rejects downgraded manifests without subflows or parallel settings', async () => {
  const { value } = await runtime({ seed: false }), created = projectSchema.parse(await value.dispatch('project.create', { title: '旧流程的关键帧备份' }));
  const configured = projectSchema.parse(await value.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { shots: [animatedBackupShot()], workflow: { id: 'legacy', version: 1, name: 'legacy', nodes: [node('brief')], edges: [] } } }));
  expect(configured.workflow.subflows).toBeUndefined(); expect(configured.workflow.execution).toBeUndefined(); expect(configured.workflow.nodes.some(node => node.kind === 'subflow' || node.subflow)).toBe(false);
  const { path } = await value.dispatch('project.backup', { projectId: configured.id }) as { path: string }, manifestPath = join(path, 'project.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  expect(manifest.schemaVersion).toBe(3);
  const isolated = await runtime({ seed: false }), restored = projectSchema.parse(await isolated.value.dispatch('project.importBackup', { path }));
  expect(restored.id).not.toBe(configured.id); expect(restored.shots[0].animation).toEqual(configured.shots[0].animation);
  for (const schemaVersion of [1, 2]) { await writeFile(manifestPath, JSON.stringify({ ...manifest, schemaVersion })); await expect(isolated.value.dispatch('project.importBackup', { path })).rejects.toThrow('格式 3'); }
});
it('stores an application receipt atomically and returns it after lost acknowledgement without overwriting later edits', async () => {
  const { value } = await runtime({ provider: async () => ({ text: '新的系列风格' }) });
  const project = projectSchema.parse(await value.dispatch('project.create', { title: '应用回执', brief: '' }));
  const model = await value.dispatch('model.save', { model: { name: 'fixture', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1', model: 'fixture', capabilities: ['text'] } }) as { id: string };
  const configured = projectSchema.parse(await value.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: workflowSchema.parse({ id: 'style', name: 'style', version: 1, nodes: [node('style', { kind: 'style', modelId: model.id })], edges: [] }) }));
  const run = await value.dispatch('run.start', { projectId: project.id }) as RunRecord; await value.waitForIdle(); const request = { runId: run.id, nodeId: 'style', revision: configured.revision, applicationId: 'same application' };
  const applied = projectSchema.parse(await value.dispatch('node.apply', request));
  const later = projectSchema.parse(await value.dispatch('project.update', { projectId: project.id, revision: applied.revision, patch: { title: '应用后人工修改' } }));
  expect(await value.dispatch('node.apply', request)).toEqual(applied);
  expect(projectDetailSchema.parse(await value.dispatch('project.get', { projectId: project.id })).project).toEqual(later);
  await expect(value.dispatch('node.apply', { ...request, revision: later.revision })).rejects.toThrow('不同的步骤或修订');
});

it('bridges nested native interrupts through both subflow checkpoints and keeps the second review pending across restart', async () => {
  const { value, directory } = await runtime(), project = projectSchema.parse(await value.dispatch('project.create', { title: '嵌套审阅', brief: '嵌套原文' }));
  const inner = { id: 'inner', version: 1, name: 'inner', inputs: [], outputs: [{ name: 'brief', type: 'string', nodeId: 'last', path: ['brief'] }], nodes: [node('first', { requiresReview: true }), node('last', { requiresReview: true })], edges: [{ id: 'e', source: 'first', target: 'last' }] };
  const outer = { id: 'outer', version: 1, name: 'outer', inputs: [], outputs: [{ name: 'brief', type: 'string', nodeId: 'inner-call', path: ['outputs', 'brief'] }], nodes: [node('inner-call', { kind: 'subflow', subflow: { id: 'inner', version: 1, inputs: {} } })], edges: [] };
  await value.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { id: 'parent', name: 'parent', version: 1, nodes: [node('outer-call', { kind: 'subflow', subflow: { id: 'outer', version: 1, inputs: {} } })], edges: [], subflows: [inner, outer] } });
  const run = await value.dispatch('run.start', { projectId: project.id }) as RunRecord; await value.waitForIdle(); let inspected = await value.dispatch('run.inspect', { runId: run.id }) as RunInspection; expect(inspected.run.status, inspected.run.error).toBe('waiting_review');
  expect(inspected.run.currentNodeId).toBe('outer-call/subflow/inner-call/subflow/first');
  await value.dispatch('run.review', { runId: run.id, approved: true }); await value.waitForIdle(); inspected = await value.dispatch('run.inspect', { runId: run.id }) as RunInspection; expect(inspected.run.status, inspected.run.error).toBe('waiting_review'); expect(inspected.run.currentNodeId).toBe('outer-call/subflow/inner-call/subflow/last');
  await value.close(); const second = await runtime({ dataDirectory: directory }); await second.value.dispatch('run.review', { runId: run.id, approved: true }); await second.value.waitForIdle(); inspected = await second.value.dispatch('run.inspect', { runId: run.id }) as RunInspection; expect(inspected.run.status, inspected.run.error).toBe('succeeded'); expect(inspected.steps.every(step => step.status === 'succeeded')).toBe(true);
  expect(await second.value.dispatch('node.result', { runId: run.id, nodeId: 'outer-call' })).toMatchObject({ outputs: { brief: '嵌套原文' } });
});

it('passes typed number and boolean inputs through nested templates without coercing actual JSON values', async () => {
  const { value } = await runtime(), project = projectSchema.parse(await value.dispatch('project.create', { title: '类型透传', brief: '' }));
  const inner = { id: 'typed-inner', version: 1, name: 'typed-inner', inputs: [{ name: 'count', type: 'number', required: true }, { name: 'enabled', type: 'boolean', required: true }], outputs: [{ name: 'matched', type: 'boolean', nodeId: 'choice', path: ['matched'] }], nodes: [node('choice', { kind: 'condition', config: { value: '{{input.enabled}}', count: '{{input.count}}' } })], edges: [] };
  const outer = { id: 'typed-outer', version: 1, name: 'typed-outer', inputs: [{ name: 'count', type: 'number', required: true }, { name: 'enabled', type: 'boolean', required: true }], outputs: [{ name: 'matched', type: 'boolean', nodeId: 'inner', path: ['outputs', 'matched'] }], nodes: [node('inner', { kind: 'subflow', subflow: { id: inner.id, version: 1, inputs: { count: { literal: '{{input.count}}' }, enabled: { literal: '{{input.enabled}}' } } } })], edges: [] };
  const savedInner = await value.dispatch('workflowTemplate.save', { name: inner.name, inputs: inner.inputs, outputs: inner.outputs, workflow: { id: 'inner-body', version: 1, name: inner.name, nodes: inner.nodes, edges: [] } }) as WorkflowTemplate;
  outer.nodes[0].subflow!.id = savedInner.id;
  const savedOuter = await value.dispatch('workflowTemplate.save', { name: outer.name, inputs: outer.inputs, outputs: outer.outputs, workflow: { id: 'outer-body', version: 1, name: outer.name, nodes: outer.nodes, edges: [], subflows: [savedInner.definition] } }) as WorkflowTemplate;
  inner.id = savedInner.id; outer.id = savedOuter.id;
  const workflow = workflowSchema.parse({ id: 'parent', name: 'parent', version: 1, nodes: [node('outer', { kind: 'subflow', subflow: { id: outer.id, version: 1, inputs: { count: { literal: 3 }, enabled: { literal: true } } } }), node('yes'), node('no')], edges: [{ id: 'yes', source: 'outer', target: 'yes', condition: 'true' }, { id: 'no', source: 'outer', target: 'no', condition: 'false' }], subflows: [inner, outer] });
  await value.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow }); const run = await value.dispatch('run.start', { projectId: project.id }) as RunRecord; await value.waitForIdle(); const inspection = await value.dispatch('run.inspect', { runId: run.id }) as RunInspection; expect(inspection.run.status, inspection.run.error).toBe('succeeded'); expect(inspection.steps.find(step => step.id === 'no')?.status).toBe('skipped');
  const input = await value.dispatch('run.inspect', { runId: run.id, nodeId: 'outer/subflow/inner/subflow/choice' }) as RunInspection; expect(input.selected?.node).toMatchObject({ config: { value: true, count: 3 } });
  const invalid = structuredClone(workflow); invalid.subflows![1].inputs[0].type = 'boolean'; expect(() => validateWorkflowComposition(invalid)).toThrow('类型须为');
});

it('inspects more than one hundred expanded steps and preserves colon-containing namespaces in summaries and activity pages', async () => {
  const { value } = await runtime(), project = projectSchema.parse(await value.dispatch('project.create', { title: '展开详情', brief: '' }));
  const children = Array.from({ length: 100 }, (_, index) => node(`child:${index}`, { requiresReview: index === 0 }));
  const definition = { id: 'large', version: 1, name: 'large', inputs: [], outputs: [], nodes: children, edges: [] };
  await value.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { id: 'parent', name: 'parent', version: 1, nodes: [node('scope:call', { kind: 'subflow', subflow: { id: 'large', version: 1, inputs: {} } })], edges: [], subflows: [definition] } });
  const run = await value.dispatch('run.start', { projectId: project.id }) as RunRecord; await value.waitForIdle();
  const inspected = await value.dispatch('run.inspect', { runId: run.id }) as RunInspection; expect(inspected.run.status).toBe('waiting_review'); expect(inspected.steps).toHaveLength(101);
  const childId = 'scope:call/subflow/child%3A0'; expect(inspected.run.completedNodeIds).toContain(childId);
  const page = await value.dispatch('run.activities', { runId: run.id, nodeId: childId, limit: 1 }) as { items: { nodeId: string }[] }; expect(page.items).toHaveLength(1); expect(page.items[0].nodeId).toBe(childId);
});
