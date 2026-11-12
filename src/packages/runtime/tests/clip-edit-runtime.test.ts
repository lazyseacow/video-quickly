import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_AUDIO_PROCESSING, projectSchema, type AssetRecord, type ModelProfile, type ProjectDocument } from '@video-quickly/contracts';
import { deleteShotRanges, resolveShotSpans, restoreShotRanges } from '../../video/src/clip-edits';
import { createRuntime, type RuntimeOptions } from '../src';
import { storyboardFixtureResponse } from '../../../../tests/fixtures/planning-response';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const rate = { numerator: 30, denominator: 1 };
async function fixture(options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-edl-runtime-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ...options }); runtimes.add(runtime);
  let project = projectSchema.parse(await runtime.dispatch('project.create', { templateId: 'history-handdrawn', title: '原录音恢复与备份' }));
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'shot', title: '保留逻辑镜头', narration: '', visualPrompt: '', durationUs: 8_000_000, sourceInUs: 0 }] } }));
  const assets: AssetRecord[] = [];
  for (const [name, kind] of [['old.wav', 'audio'], ['old.mp4', 'video'], ['new.wav', 'audio']] as const) {
    const path = join(directory, name); await writeFile(path, `independent fixture ${name}`);
    assets.push(await runtime.dispatch('asset.import', { path, kind, projectId: project.id, ...(name.startsWith('old') ? { shotId: 'shot' } : {}) }) as AssetRecord);
  }
  project = (await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project;
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: project.shots.map(shot => ({ ...shot, captionTrack: { timeBase: 'source', alignment: 'speech', granularity: 'word', sourceAssetId: assets[0].id, sourceSha256: assets[0].sha256, cues: Array.from({ length: 8 }, (_, index) => ({ id: `w${index}`, text: `词${index}`, startUs: index * 1_000_000, endUs: (index + 1) * 1_000_000 })) } })) } }));
  let counter = 0; const edited = deleteShotRanges(project, 'shot', [{ startUs: 0, endUs: 2_000_000 }, { startUs: 4_000_000, endUs: 5_000_000 }], rate, assets, kind => `${kind}-${++counter}`);
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: edited.shots, clipEditSources: edited.clipEditSources, clipEditPlans: edited.clipEditPlans } }));
  return { directory, runtime, project, assets };
}

it('rejects dangling or mutable edit records and protects every original media file from deletion', async () => {
  const { runtime, project, assets } = await fixture();
  await expect(runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { clipEditPlans: [] } })).rejects.toThrow('不存在');
  await expect(runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { clipEditPlans: project.clipEditPlans!.map(plan => ({ ...plan, spans: plan.spans.map((span, index) => index ? span : { ...span, audioInUs: span.audioInUs + 1 }) })) } })).rejects.toThrow('原地改写');
  await expect(runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { clipEditSources: project.clipEditSources!.map(source => ({ ...source, assetHashes: source.assetHashes.map(value => ({ ...value, sha256: 'f'.repeat(64) })) })) } })).rejects.toThrow('校验值');
  await runtime.dispatch('asset.import', { projectId: project.id, shotId: 'shot', path: assets[2].path, kind: 'audio' });
  const replaced = (await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project;
  expect(resolveShotSpans(replaced.shots[0], replaced).map(span => [span.audioInUs, span.videoInUs])).toEqual([[0, 2_000_000], [2_000_000, 5_000_000]]);
  await expect(runtime.dispatch('asset.delete', { assetId: assets[0].id })).rejects.toThrow('正在使用');
  const restored = restoreShotRanges(replaced, 'shot'); expect(restored.shots[0]).toMatchObject({ audioAssetId: assets[0].id, videoAssetId: assets[1].id, durationUs: 8_000_000 });
});

it('backs up format 4 with the original clip ranges and source hashes', async () => {
  const { runtime, project, assets } = await fixture();
  const backup = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const manifest = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')) as { schemaVersion: number; project: ProjectDocument; assets: AssetRecord[] };
  expect(manifest.schemaVersion).toBe(4); expect(manifest.assets.map(asset => asset.id)).toEqual(expect.arrayContaining([assets[0].id, assets[1].id]));
  const exported = projectSchema.parse(manifest.project);
  expect(resolveShotSpans(exported.shots[0], exported).map(span => span.videoInUs)).toEqual([2_000_000, 5_000_000]);
  const source = exported.clipEditSources![0];
  expect(source.original.audioAssetId).toBe(assets[0].id);
  expect(source.original.captionTrack?.sourceAssetId).toBe(assets[0].id);
  expect(source.assetHashes.find(value => value.assetId === assets[0].id)?.sha256).toBe(assets[0].sha256);
});

it('uses format 4 for empty projects and explicit DSP', async () => {
  const { runtime } = await fixture(); let project = projectSchema.parse(await runtime.dispatch('project.create', { templateId: 'history-handdrawn', title: '纯旧格式' }));
  const original = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const manifest = JSON.parse(await readFile(join(original.path, 'project.json'), 'utf8'));
  expect(manifest.schemaVersion).toBe(4);
  expect(projectSchema.parse(manifest.project).shots).toEqual([]);
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'dsp', title: '只调声音', narration: '', visualPrompt: '', durationUs: 1_000_000, audioProcessing: DEFAULT_AUDIO_PROCESSING }] } }));
  const dsp = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string }; expect(JSON.parse(await readFile(join(dsp.path, 'project.json'), 'utf8')).schemaVersion).toBe(4);
});



it('rejects model-provided media and edit identities and preserves human edits when the corrected script is applied', async () => {
  let includeInjectedFields = true;
  const script = { title: '模型改写标题', narration: '模型改写旁白', visualPrompt: '模型改写画面', durationUs: 1_000_000 };
  const injectedFields = {
    audioAssetId: 'injected-audio', videoAssetId: 'injected-video', audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, gainDb: 18 },
    captionTrack: { timeBase: 'scene', alignment: 'estimated', cues: [] }, clipEdit: { planId: 'injected-plan', inUs: 0, restoreInUs: 0, restoreDurationUs: 1_000_000 },
  };
  const { runtime, project: initial } = await fixture({ provider: async ({ prompt }) => storyboardFixtureResponse(prompt, JSON.stringify({ shots: [includeInjectedFields ? { ...script, ...injectedFields } : script] })) });
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: { shots: initial.shots.map(shot => ({ ...shot, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, gainDb: 3 } })) } }));
  const model = await runtime.dispatch('model.save', { model: { name: '隔离文字边界', provider: 'openai-compatible', baseUrl: 'http://unused.invalid', model: 'isolated', connectionType: 'text', capabilities: ['text'], parameters: {} } }) as ModelProfile;
  await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.kind === 'script' ? { ...node, modelId: model.id } : node) } } });
  const before = (await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project;
  const run = await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'script' }) as { id: string }; await runtime.waitForIdle();
  expect(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'script' })).toBeNull();
  expect(await runtime.dispatch('run.inspect', { runId: run.id })).toMatchObject({ steps: [{ id: 'script', status: 'failed', error: expect.stringContaining('shots[0]：含有未定义的字段') }] });
  includeInjectedFields = false;
  await runtime.dispatch('run.step.retry', { runId: run.id, nodeId: 'script' }); await runtime.waitForIdle();
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: run.id, nodeId: 'script', revision: before.revision }));
  expect(applied.shots[0]).toMatchObject({ title: '模型改写标题', narration: '模型改写旁白', durationUs: before.shots[0].durationUs, audioAssetId: before.shots[0].audioAssetId, videoAssetId: before.shots[0].videoAssetId, clipEdit: before.shots[0].clipEdit, audioProcessing: before.shots[0].audioProcessing });
  expect(applied.shots[0].captionTrack).toEqual(before.shots[0].captionTrack); expect(applied.clipEditSources).toEqual(before.clipEditSources);
});
