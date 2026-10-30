import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_AUDIO_PROCESSING, projectSchema, type AssetRecord, type JsonValue, type ModelProfile, type ProjectDocument, type ProjectSummary, type ShotCandidate } from '@video-quickly/contracts';
import { deleteShotRanges, resolveShotSpans, restoreShotRanges } from '../../video/src/clip-edits';
import { createRuntime, type RuntimeOptions } from '../src';
import { DocumentStore, openDatabase, WORKSPACE_MIGRATIONS } from '../src/database';
import { migrateDatabase } from '../src/migrations';

const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const rate = { numerator: 30, denominator: 1 };
async function fixture(options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-edl-runtime-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ...options }); runtimes.add(runtime);
  let project = projectSchema.parse(await runtime.dispatch('project.create', { title: '原录音恢复与备份' }));
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
  const replaced = projectSchema.parse(await runtime.dispatch('asset.select', { projectId: project.id, shotId: 'shot', assetId: assets[2].id, revision: project.revision }));
  expect(resolveShotSpans(replaced.shots[0], replaced).map(span => [span.audioInUs, span.videoInUs])).toEqual([[0, 2_000_000], [2_000_000, 5_000_000]]);
  await expect(runtime.dispatch('asset.delete', { assetId: assets[0].id })).rejects.toThrow('正在使用');
  const restored = restoreShotRanges(replaced, 'shot'); expect(restored.shots[0]).toMatchObject({ audioAssetId: assets[0].id, videoAssetId: assets[1].id, durationUs: 8_000_000 });
});

it('backs up format 2 with original source hashes and remaps complete source identities on import', async () => {
  const { runtime, project, assets } = await fixture();
  const backup = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  const manifest = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')) as { schemaVersion: number; project: ProjectDocument; assets: AssetRecord[] };
  expect(manifest.schemaVersion).toBe(2); expect(manifest.assets.map(asset => asset.id)).toEqual(expect.arrayContaining([assets[0].id, assets[1].id]));
  const restored = projectSchema.parse(await runtime.dispatch('project.importBackup', { path: backup.path }));
  expect(restored.id).not.toBe(project.id); expect(resolveShotSpans(restored.shots[0], restored).map(span => span.videoInUs)).toEqual([2_000_000, 5_000_000]);
  const source = restored.clipEditSources![0]; expect(source.original.audioAssetId).not.toBe(assets[0].id); expect(source.original.captionTrack?.sourceAssetId).toBe(source.original.audioAssetId);
  expect(source.assetHashes.find(value => value.assetId === source.original.audioAssetId)?.sha256).toBe(assets[0].sha256);
  manifest.schemaVersion = 1; await writeFile(join(backup.path, 'project.json'), JSON.stringify(manifest));
  await expect(runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('格式 2');
  manifest.schemaVersion = 2; manifest.project.clipEditSources![0].assetHashes[0].sha256 = 'f'.repeat(64); await writeFile(join(backup.path, 'project.json'), JSON.stringify(manifest));
  await expect(runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('校验值');
});

it('retains format 1 for a legacy project and selects format 2 for explicit DSP alone', async () => {
  const { runtime } = await fixture(); let project = projectSchema.parse(await runtime.dispatch('project.create', { title: '纯旧格式' }));
  const original = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  expect(JSON.parse(await readFile(join(original.path, 'project.json'), 'utf8')).schemaVersion).toBe(1);
  expect(projectSchema.parse(await runtime.dispatch('project.importBackup', { path: original.path })).shots).toEqual([]);
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ id: 'dsp', title: '只调声音', narration: '', visualPrompt: '', durationUs: 1_000_000, audioProcessing: DEFAULT_AUDIO_PROCESSING }] } }));
  const dsp = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string }; expect(JSON.parse(await readFile(join(dsp.path, 'project.json'), 'utf8')).schemaVersion).toBe(2);
});

it('upgrades a real v5 database atomically, backfills original references, and projects the edited first frame without heavy context', async () => {
  const { directory, runtime, project, assets } = await fixture(); await runtime.close(); runtimes.delete(runtime);
  project.shots = project.shots.map(shot => ({ ...shot, audioAssetId: undefined, videoAssetId: undefined }));
  const migrationDirectory = await mkdtemp(join(tmpdir(), 'vq-edl-v5-')); directories.push(migrationDirectory);
  const previous = new Database(join(migrationDirectory, 'workspace.sqlite')); migrateDatabase(previous, migrationDirectory, WORKSPACE_MIGRATIONS.filter(value => value.version <= 5));
  const old = new DocumentStore(previous); for (const asset of assets) old.put('asset', asset.id, asset); old.put('project', project.id, project);
  const run = { id: 'review', status: 'waiting_review', projectId: project.id }; old.put('run', run.id, run);
  previous.exec("CREATE TABLE checkpoints (thread_id TEXT PRIMARY KEY, checkpoint BLOB); INSERT INTO checkpoints VALUES ('review', X'0102');"); previous.close();
  const upgraded = openDatabase(migrationDirectory), store = new DocumentStore(upgraded);
  try {
    expect(upgraded.pragma('user_version', { simple: true })).toBe(7); expect(store.get('project', project.id)).toEqual(project); expect(store.get('run', run.id)).toEqual(run);
    expect(upgraded.prepare('SELECT hex(checkpoint) AS value FROM checkpoints').get()).toEqual({ value: '0102' });
    const summary = store.get<ProjectSummary>('project-summary', project.id)!;
    expect(summary.thumbnailShot).toMatchObject({ videoInUs: 2_000_000, sceneInUs: 2_000_000, captionTrack: { cues: [expect.objectContaining({ text: '词2' })] } });
    expect(summary.thumbnailShot?.clipEdit).toBeUndefined(); expect(summary).not.toHaveProperty('clipEditSources'); expect(summary).not.toHaveProperty('clipEditPlans');
    expect(JSON.stringify(summary).length).toBeLessThan(2000);
    const referenced = upgraded.prepare('SELECT asset_id FROM project_asset_references WHERE project_id = ? ORDER BY asset_id').all(project.id) as { asset_id: string }[];
    expect(referenced.map(value => value.asset_id)).toEqual(expect.arrayContaining([assets[0].id, assets[1].id]));
    const originalBody = createHash('sha256').update(JSON.stringify(project)).digest('hex'); expect(createHash('sha256').update(JSON.stringify(store.get('project', project.id))).digest('hex')).toBe(originalBody);
    store.put('project', project.id, { ...project, revision: project.revision + 1, shots: project.shots.map(shot => ({ ...shot, clipEdit: { ...shot.clipEdit!, inUs: 1_000_000 }, durationUs: shot.durationUs - 1_000_000 })) });
    expect(store.get<ProjectSummary>('project-summary', project.id)?.thumbnailShot?.videoInUs).toBe(3_000_000);
  } finally { upgraded.close(); }
});

it('keeps human timing, captions and DSP through ordinary script apply and ignores injected media or edit identities', async () => {
  const { runtime, project: initial } = await fixture({ provider: async () => JSON.stringify({ shots: [{ title: '模型改写标题', narration: '模型改写旁白', visualPrompt: '模型改写画面', durationUs: 1_000_000,
    audioAssetId: 'injected-audio', videoAssetId: 'injected-video', audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, gainDb: 18 }, captionTrack: { timeBase: 'scene', alignment: 'estimated', cues: [] }, clipEdit: { planId: 'injected-plan', inUs: 0, restoreInUs: 0, restoreDurationUs: 1_000_000 } }] }) });
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: initial.id, revision: initial.revision, patch: { shots: initial.shots.map(shot => ({ ...shot, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, gainDb: 3 } })) } }));
  const model = await runtime.dispatch('model.save', { model: { name: '隔离文字边界', provider: 'openai-compatible', baseUrl: 'http://unused.invalid', model: 'isolated', capabilities: ['text'], parameters: {} } }) as ModelProfile;
  await runtime.dispatch('workflow.save', { projectId: project.id, revision: project.revision, workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.kind === 'script' ? { ...node, modelId: model.id } : node) } });
  const before = (await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project;
  const run = await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'script' }) as { id: string }; await runtime.waitForIdle();
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: run.id, nodeId: 'script', revision: before.revision }));
  expect(applied.shots[0]).toMatchObject({ title: '模型改写标题', narration: '模型改写旁白', durationUs: before.shots[0].durationUs, audioAssetId: before.shots[0].audioAssetId, videoAssetId: before.shots[0].videoAssetId, clipEdit: before.shots[0].clipEdit, audioProcessing: before.shots[0].audioProcessing });
  expect(applied.shots[0].captionTrack).toEqual(before.shots[0].captionTrack); expect(applied.clipEditSources).toEqual(before.clipEditSources);
});

it('applies regenerated audio on output time and rejects a reused plan identity with changed timing', async () => {
  let generated: AssetRecord;
  const { runtime, project, assets } = await fixture({ executeActivity: async context => {
    if (context.node.kind !== 'voice') throw new Error('隔离回调只允许配音。');
    return { assets: [{ ...generated, shotId: 'shot' }] } as unknown as JsonValue;
  } }); generated = assets[2];
  const model = await runtime.dispatch('model.save', { model: { name: '隔离配音边界', provider: 'openai-compatible', baseUrl: 'http://unused.invalid', model: 'isolated', capabilities: ['tts'], parameters: {} } }) as ModelProfile;
  const run = await runtime.dispatch('shot.regenerate', { projectId: project.id, shotId: 'shot', kind: 'audio', modelId: model.id, revision: project.revision }) as { id: string }; await runtime.waitForIdle();
  const candidate = (await runtime.dispatch('shot.candidates', { projectId: project.id, shotId: 'shot' }) as { items: ShotCandidate[] }).items[0]; expect(candidate.runId).toBe(run.id);
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: project.revision }));
  expect(resolveShotSpans(applied.shots[0], applied).map(span => [span.audioInUs, span.videoInUs])).toEqual([[0, 2_000_000], [2_000_000, 5_000_000]]);
  // Restore the original ref, then remove and reintroduce its ID: equal refs alone do not prove equal inputs.
  let current = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: applied.revision, patch: { shots: project.shots, clipEditPlans: project.clipEditPlans, clipEditSources: project.clipEditSources } }));
  current = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: current.revision, patch: { shots: current.shots.map(shot => ({ ...shot, clipEdit: undefined })), clipEditPlans: [], clipEditSources: [] } }));
  current = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: current.revision, patch: { shots: project.shots, clipEditSources: project.clipEditSources, clipEditPlans: project.clipEditPlans!.map(plan => ({ ...plan, spans: plan.spans.map((span, index) => index ? span : { ...span, audioInUs: span.audioInUs + 1 }) })) } }));
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: current.revision })).rejects.toThrow('计划已变化');
});
