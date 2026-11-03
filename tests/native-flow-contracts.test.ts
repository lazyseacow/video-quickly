import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captionsEnabled, modelCapabilitySchema, modelConnectionTypes, modelSchema, projectSchema, validateModelConnection, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime } from '../packages/runtime/src';
import { validateExecutionModel } from '../packages/runtime/src/execution-model';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function fixture(seed = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-native-contracts-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed }); runtimes.push(runtime); return runtime;
}
const base = { name: '隔离模型', provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1' };

it('exposes three explicit model types and rejects audio capabilities, providers and tasks', () => {
  expect(modelConnectionTypes.map(type => type.id)).toEqual(['text', 'image', 'video']);
  for (const capability of ['tts', 'asr']) expect(modelCapabilitySchema.safeParse(capability).success).toBe(false);
  for (const provider of ['qwen-tts', 'volcengine-tts', 'volcengine-asr']) expect(modelSchema.shape.provider.safeParse(provider).success).toBe(false);
  expect(workflowNodeSchema.safeParse({ id: 'voice', kind: 'voice', label: '配音' }).success).toBe(false);
  expect(workflowNodeSchema.safeParse({ id: 'caption', kind: 'animation', label: '识别', config: { operation: 'transcribe' } }).success).toBe(false);
  expect(() => validateModelConnection({ connectionType: 'text', provider: 'openai-compatible', capabilities: ['text', 'vision', 'tools'] })).not.toThrow();
  expect(() => validateModelConnection({ connectionType: 'text', provider: 'openai-compatible', capabilities: ['text', 'image'] })).toThrow();
  expect(() => validateModelConnection({ connectionType: 'image', provider: 'seedream', capabilities: ['image', 'video'] })).toThrow();
  const video = modelSchema.parse({ ...base, id: 'video', connectionType: 'video', capabilities: ['video'], parameters: {  }, createdAt: '', updatedAt: '' });
  expect(() => validateExecutionModel(workflowNodeSchema.parse({ id: 'edit', kind: 'animation', label: '剪辑准备', config: { operation: 'prepare-edit' } }), video)).toThrow('剪辑准备使用本地时间轴');
});

it('rejects missing types and audio requests before creating a model or run', async () => {
  const runtime = await fixture();
  for (const model of [{ ...base, capabilities: ['text'] }, { ...base, connectionType: 'audio', capabilities: ['tts'] }, { ...base, connectionType: 'text', capabilities: ['text', 'tts', 'asr'] }]) await expect(runtime.dispatch('model.save', { model })).rejects.toThrow();
  for (const connectionType of ['text', 'image', 'video']) await runtime.dispatch('model.save', { model: { ...base, name: connectionType, connectionType, capabilities: [connectionType] } });
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '隔离项目' }));
  await expect(runtime.dispatch('caption.transcribe', {})).rejects.toThrow('未知操作');
  await expect(runtime.dispatch('model.voices', {})).rejects.toThrow('未知操作');
  await expect(runtime.dispatch('shot.regenerate', { projectId: project.id, shotId: 'shot', kind: 'audio', revision: project.revision })).rejects.toThrow();
  await expect(runtime.dispatch('run.start', { projectId: project.id, transcription: { shotId: 'shot', modelId: 'model' } })).rejects.toThrow();
  expect(await runtime.dispatch('run.list', { projectId: project.id })).toMatchObject({ items: [], nextCursor: null });
});

it('uses one native workflow for the example and both project categories with subtitles off', async () => {
  const runtime = await fixture(true), workspace = await runtime.dispatch('workspace.snapshot') as { projects: unknown[] };
  const projects = [...workspace.projects];
  for (const templateId of ['generic', 'history-handdrawn']) projects.push(await runtime.dispatch('project.create', { title: templateId, templateId }));
  for (const input of projects) {
    const project = projectSchema.parse(input);
    expect(project.workflow.id).toBe('native-video'); expect(project.workflow.production.mode).toBe('native-video');
    expect(project.workflow.nodes.map(node => node.id)).toEqual(['brief', 'style', 'script', 'assets', 'video', 'animation', 'export']);
    expect(project.workflow.stages).toHaveLength(4); expect(captionsEnabled(project)).toBe(false);
  }
});

it('writes format 4 and rejects every earlier backup format', async () => {
  const runtime = await fixture(), project = projectSchema.parse(await runtime.dispatch('project.create', { title: '备份契约' }));
  const backup = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string }, path = join(backup.path, 'project.json');
  const manifest = JSON.parse(await readFile(path, 'utf8')); expect(manifest.schemaVersion).toBe(4);
  expect(projectSchema.parse(await runtime.dispatch('project.importBackup', { path: backup.path })).workflow.production).toEqual(project.workflow.production);
  for (const schemaVersion of [1, 2, 3]) { await writeFile(path, JSON.stringify({ ...manifest, schemaVersion })); await expect(runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('格式 4'); }
});
