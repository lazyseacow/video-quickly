import { planningFixtureResponse, storyboardFixtureResponse } from './fixtures/planning-response';
import { fixtureCharacterImage } from './fixtures/character-image';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captionsEnabled, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, getModelParameterFields, modelSchema, planReferenceImageSequences, projectSchema, resolveProductionWorkflow, runInspectionSchema, runSchema, videoReferenceImages, type AssetRecord, type ProjectDocument, type ShotCandidate } from '@video-quickly/contracts';
import { requestCostMetrics } from '../src/packages/runtime/src/costs';
import { validateExecutionModel } from '../src/packages/runtime/src/execution-model';
import { matchingStepModels } from '../src/renderer/lib/workflow-guidance';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../src/packages/runtime/src';
import { createActivityExecutor, validateMediaActivity } from '../src/packages/integrations/src';
import { probeMedia, runMedia } from '../src/packages/video/src/node';
import { applyProductionProjectDraft, applyStageConfigurationDraft, stageConfigurationDraftSchema, updateProductionConfigurationDraft } from '../src/renderer/lib/stage-configuration-draft';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>(), servers: Server[] = [];
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('shares text and video choices while preserving explicit task overrides and keeping subtitles off', () => {
  const initial = createNativeVideoWorkflow();
  const workflow = resolveProductionWorkflow({ ...initial, production: { ...initial.production!, textModelId: 'text', videoModelId: 'video' }, nodes: initial.nodes.map(node => node.id === 'style' ? { ...node, modelId: 'special', config: { ...node.config, modelOverride: true } } : node) });
  expect(workflow.nodes.filter(node => ['brief', 'script'].includes(node.id)).map(node => node.modelId)).toEqual(['text', 'text']);
  expect(workflow.nodes.find(node => node.id === 'style')?.modelId).toBe('special');
  expect(workflow.nodes.find(node => node.id === 'video')?.modelId).toBe('video');
  expect(workflow.nodes.some(node => node.id === 'voice')).toBe(false);
  expect(workflow.stages?.map(stage => stage.label)).toEqual(['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出']);
  expect(captionsEnabled({ workflow })).toBe(false);
  expect(resolveProductionWorkflow({ ...workflow, production: { ...workflow.production!, textModelId: undefined } }).nodes.find(node => node.id === 'brief')?.modelId).toBeUndefined();
});

it('requires generated first frames only while the built-in image model is selected', () => {
  const initial = createNativeVideoWorkflow();
  const withImage = resolveProductionWorkflow({ ...initial, production: { ...initial.production, imageModelId: 'image' } });
  expect(withImage.production.referenceMode).toBe('generate');
  const imageStep = withImage.nodes.find(node => node.id === 'assets')!;
  expect(imageStep).toMatchObject({ modelId: 'image', config: { groupReferenceImages: true } });
  expect(imageStep.config.useFirstShotReference).toBeUndefined();
  expect(withImage.nodes.find(node => node.id === 'video')?.config.requiresShotFirstFrame).toBe(true);
  const cleared = resolveProductionWorkflow({ ...withImage, production: { ...withImage.production, imageModelId: undefined } });
  expect(cleared.production.referenceMode).toBe('existing');
  const assets = cleared.nodes.find(node => node.id === 'assets')!;
  expect(assets.modelId).toBeUndefined();
  expect(assets.config.groupReferenceImages).toBeUndefined();
  expect(assets.config.useFirstShotReference).toBeUndefined();
  expect(cleared.nodes.find(node => node.id === 'video')?.config.requiresShotFirstFrame).toBeUndefined();
  expect(() => validateExecutionModel(assets, undefined)).not.toThrow();
});

it('keeps locked shots as native group boundaries and counts only generated first frames', () => {
  const initial = createNativeVideoWorkflow();
  const workflow = resolveProductionWorkflow({ ...initial, production: { ...initial.production, imageModelId: 'image' } });
  const project = projectSchema.parse({ id: 'grouped-first-frames', title: '首帧分组', brief: '', profile: DEFAULT_VIDEO_PROFILE, revision: 1, createdAt: '', updatedAt: '', workflow,
    shots: ['a', 'b', 'locked', 'c', 'd'].map(id => ({ id, title: id, narration: '', visualPrompt: '同一场景', durationUs: 1_000_000, locked: id === 'locked' })),
  });
  const node = workflow.nodes.find(node => node.id === 'assets')!;
  const model = modelSchema.parse({ id: 'image', name: '图片模型', provider: 'openai-compatible', model: 'doubao-seedream-5-0-lite-260128', baseUrl: 'http://127.0.0.1:1', connectionType: 'image', capabilities: ['image'], createdAt: '', updatedAt: '' });
  expect(planReferenceImageSequences({ project, node, model }).map(sequence => [sequence.seedream, sequence.batches.map(batch => batch.map(shot => shot.id))]))
    .toEqual([[true, [['a', 'b']]], [true, [['c', 'd']]]]);
  expect(requestCostMetrics(project, node, model)).toEqual({ source: 'request', requestCount: 2, images: 4 });

  const { groupReferenceImages: _group, ...legacyConfig } = node.config;
  const legacy = { ...node, config: { ...legacyConfig, useFirstShotReference: true } };
  expect(planReferenceImageSequences({ project, node: legacy, model }).map(sequence => [sequence.seedream, sequence.batches.map(batch => batch.map(shot => shot.id))]))
    .toEqual([[false, [['a'], ['b'], ['c'], ['d']]]]);
  expect(requestCostMetrics(project, legacy, model)).toEqual({ source: 'request', requestCount: 4, images: 4 });
});

it('validates known Seedance audio-only combinations when no shot image is available', () => {
  const workflow = createNativeVideoWorkflow();
  const project = projectSchema.parse({ id: 'reference-audio', title: '声音参考', brief: '', profile: DEFAULT_VIDEO_PROFILE, revision: 1, createdAt: '', updatedAt: '',
    shots: [{ id: 'text-only', title: '一段旁白', narration: '', visualPrompt: '夜景', durationUs: 2_000_000 }],
    workflow: { ...workflow, production: { ...workflow.production, referenceAudioAssetIds: ['reference'] } },
  });
  const node = project.workflow.nodes.find(node => node.id === 'video')!, [shot] = project.shots;
  const model = modelSchema.parse({ id: 'video', name: 'Seedance', provider: 'seedance', model: 'doubao-seedance-2-0-260128', baseUrl: 'http://127.0.0.1:1', connectionType: 'video', capabilities: ['video'], createdAt: '', updatedAt: '' });
  expect(() => videoReferenceImages(project, node, model, shot, [], [])).toThrow('Seedance 2.0 参考音频时需要一张参考图');
  expect(videoReferenceImages(project, node, { ...model, model: 'doubao-seedance-2-5-260905' }, shot, [], [])).toEqual({ mode: 'text', referenceIds: [] });
});

it.each(['seedance', 'openai-compatible', 'custom-http', 'comfyui'] as const)('accepts any configured %s video model without an extra capability flag', provider => {
  const node = createNativeVideoWorkflow().nodes.find(node => node.id === 'video')!;
  const model = modelSchema.parse({ id: 'video', name: '视频', provider, model: 'custom-video-endpoint', baseUrl: 'http://127.0.0.1:1', connectionType: 'video', capabilities: ['video'], createdAt: '', updatedAt: '' });
  expect(matchingStepModels(node, [model])).toEqual([model]);
  expect(() => validateExecutionModel({ ...node, modelId: model.id }, model)).not.toThrow();
  if (provider === 'custom-http' || provider === 'comfyui') expect(getModelParameterFields(model)).toEqual([]);
});

it('restores all four stages and project settings together, detecting changes to shared settings', () => {
  const workflow = createNativeVideoWorkflow(), current = { brief: '原主题', style: '原风格', profile: { width: 640, height: 360, frameRate: { numerator: 30, denominator: 1 }, fitMode: 'contain' as const, previewScale: .5 } };
  const settings = { ...workflow.production!, textModelId: 'next-text', videoModelId: 'next-video' };
  const draft = updateProductionConfigurationDraft('project', undefined, workflow, workflow.nodes, settings, current, { ...current, brief: '下一次主题' });
  const restored = stageConfigurationDraftSchema.parse(JSON.parse(JSON.stringify(draft)));
  expect(applyStageConfigurationDraft(workflow, restored).workflow.nodes.find(node => node.id === 'script')?.modelId).toBe('next-text');
  const generatedFields = { brief: { topic: '生成的主题', audience: '', coreMessage: '', narrativeOrder: '', targetDuration: '', expression: '' } };
  const completed = { ...workflow, production: { ...workflow.production!, manualPlanningFields: generatedFields } };
  const applied = applyStageConfigurationDraft(completed, restored);
  expect(applied.conflicts).toEqual([]);
  expect(applied.workflow.production).toMatchObject({ textModelId: 'next-text', manualPlanningFields: generatedFields });
  expect(applyProductionProjectDraft(current, restored).settings.brief).toBe('下一次主题');
  expect(applyProductionProjectDraft({ ...current, brief: '其他窗口的主题' }, restored).conflicts).toEqual(['brief']);
  expect(applyStageConfigurationDraft({ ...workflow, production: { ...workflow.production!, textModelId: 'remote' } }, restored).conflicts).toContain('production');
});

it('keeps explicit model edits from the workflow editor when unified defaults change later', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-native-binding-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false }); runtimes.add(runtime);
  let project = projectSchema.parse(await runtime.dispatch('project.create', { title: '独立模型覆盖' }));
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, production: { ...project.workflow.production!, textModelId: 'shared', videoModelId: 'video' } } } }));
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.id === 'style' ? { ...node, modelId: 'explicit' } : node) } } }));
  expect(project.workflow.nodes.find(node => node.id === 'style')).toMatchObject({ modelId: 'explicit', config: { modelOverride: true } });
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, production: { ...project.workflow.production!, textModelId: 'next-shared' } } } }));
  expect(project.workflow.nodes.find(node => node.id === 'style')?.modelId).toBe('explicit'); expect(project.workflow.nodes.find(node => node.id === 'script')?.modelId).toBe('next-shared');
  project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.id === 'style' ? { ...node, config: { ...node.config, modelOverride: false } } : node) } } }));
  expect(project.workflow.nodes.find(node => node.id === 'style')).toMatchObject({ modelId: 'next-shared', config: { modelOverride: false } });
});

async function fixture(audio = true, failpoint?: RuntimeOptions['failpoint'], shotCount = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-native-video-')); directories.push(directory);
  const source = join(directory, 'source.mp4');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1', ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-shortest'] : ['-an']), source]);
  const bytes = await readFile(source), frame = (await fixtureCharacterImage()).toString('base64'); let submissions = 0, textCalls = 0, imageCalls = 0;
  const received: Record<string, unknown>[] = [];
  let baseUrl = '';
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') {
      let body = ''; for await (const chunk of request) body += chunk;
      if (/\/images\/(generations|edits)$/.test(request.url ?? '')) { imageCalls++; response.end(JSON.stringify({ data: [{ b64_json: frame }] })); return; }
      received.push(JSON.parse(body)); submissions++; response.end(JSON.stringify({ id: `native-task-${submissions}` }));
    } else if (request.url === '/video.mp4') { response.setHeader('content-type', 'video/mp4'); response.end(bytes); }
    else response.end(JSON.stringify({ status: 'succeeded', content: { video_url: `${baseUrl}/video.mp4` } }));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture server unavailable'); baseUrl = `http://127.0.0.1:${address.port}`;
  const storyboard = JSON.stringify({ shots: Array.from({ length: shotCount }, (_, index) => ({ title: `视频镜头 ${index + 1}`, narration: '雨落下了。', visualPrompt: '蓝色天空', soundPrompt: '轻声讲述，雨声', durationUs: 2_000_000 })) });
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, ffmpegPath: ffmpeg, preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor({ ffmpegPath: ffmpeg }), failpoint,
    provider: async ({ prompt }) => { textCalls++; return prompt.includes('自动视频制作步骤：旁白与分镜') ? storyboardFixtureResponse(prompt, storyboard) : planningFixtureResponse(prompt, '连续的蓝色画面与自然声音。'); } };
  const runtime = createRuntime(options); runtimes.add(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '视频制作', brief: '讲述雨水', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } }));
  const text = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '文本夹具', provider: 'ollama', model: 'text', connectionType: 'text', capabilities: ['text'], baseUrl } }));
  const video = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '视频夹具', provider: 'seedance', model: 'custom-video-endpoint', connectionType: 'video', capabilities: ['video'], baseUrl } }));
  const image = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '图片夹具', provider: 'openai-compatible', model: 'fixture-image', connectionType: 'image', capabilities: ['image'], baseUrl } }));
  const configured = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: resolveProductionWorkflow({ ...project.workflow, production: { ...project.workflow.production!, textModelId: text.id, videoModelId: video.id, imageModelId: image.id } }) } }));
  return { runtime, options, configured, received, counts: () => ({ submissions, textCalls }), imageCalls: () => imageCalls, current: async (target = runtime) => (await target.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project };
}

it.skipIf(!mediaAvailable)('produces videos from existing storyboard frames or text without selecting an image model', async () => {
  const source = await fixture();
  const frame = await fixtureCharacterImage(), path = join(source.options.dataDirectory, 'manual-frame.png');
  await writeFile(path, frame);
  const asset = await source.runtime.dispatch('asset.import', { projectId: source.configured.id, path, kind: 'image' }) as AssetRecord;
  const project = projectSchema.parse(await source.runtime.dispatch('project.update', { projectId: source.configured.id, revision: source.configured.revision, patch: {
    creativeContext: { entities: [{ key: 'person', kind: 'character', name: '雨中人', description: '蓝色雨衣' }] },
    shots: ['有画面的镜头', '只有描述的镜头'].map((title, index) => ({ id: `manual-${index}`, title, visualPrompt: '雨中人望向蓝色天空', narration: '雨落下了。', durationUs: 2_000_000,
      creativeEntityKeys: ['person'], ...(index === 0 ? { assetId: asset.id } : {}) })),
    workflow: { ...source.configured.workflow, production: { ...source.configured.workflow.production, imageModelId: undefined, manualPlanningSteps: ['script'] } },
  } }));
  expect(await source.runtime.dispatch('project.readiness', { projectId: project.id })).toMatchObject({ ready: true });
  const billing = await source.runtime.dispatch('billing.prepare', { method: 'run.start', params: { projectId: project.id } }) as { estimate: { items: Array<{ kind: string }> } };
  expect(billing.estimate.items.map(item => item.kind)).toEqual(['text', 'video']);
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: project.id }));
  await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.id }));
  expect(finished.status, finished.error).toBe('succeeded');
  expect(source.imageCalls()).toBe(0);
  expect(source.received).toHaveLength(2);
  expect(source.received[0].content).toEqual(expect.arrayContaining([{ type: 'image_url', image_url: { url: `data:image/png;base64,${frame.toString('base64')}` }, role: 'first_frame' }]));
  expect(source.received[1].content).toEqual([{ type: 'text', text: expect.stringContaining('蓝色雨衣') }]);
});

it.skipIf(!mediaAvailable)('uses one storyboard profile for every generated clip and exports their native sound', async () => {
  const source = await fixture(true, undefined, 2);
  const profile = { ...source.configured.profile, width: 180, height: 320, frameRate: { numerator: 60, denominator: 1 }, fitMode: 'blur' };
  await source.runtime.dispatch('project.update', { projectId: source.configured.id, revision: source.configured.revision, patch: { profile } });
  const ready = await source.runtime.dispatch('project.readiness', { projectId: source.configured.id }) as { ready: boolean }; expect(ready.ready).toBe(true);
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.configured.id })); await source.runtime.waitForIdle();
  const inspection = runInspectionSchema.parse(await source.runtime.dispatch('run.inspect', { runId: started.id }));
  expect(inspection.run.status, inspection.run.error).toBe('succeeded'); expect(inspection.steps.every(step => step.status === 'succeeded')).toBe(true);
  const project = await source.current(); expect(project.shots).toHaveLength(2);
  for (const shot of project.shots) {
    expect(shot).toMatchObject({ soundPrompt: '轻声讲述，雨声', durationUs: 1_000_000, audioProcessing: { version: 2, videoAudio: { enabled: true } } });
    expect(shot.audioAssetId).toBeUndefined();
  }
  expect(source.counts()).toEqual({ submissions: 2, textCalls: 4 });
  for (const body of source.received) {
    expect(body).toMatchObject({ generate_audio: true, ratio: '9:16' });
    expect(JSON.stringify(body)).toContain('分镜全局帧率为 60 fps');
    expect(JSON.stringify(body)).toContain('雨落下了。');
    expect(JSON.stringify(body)).toContain('轻声讲述');
  }
  const script = await source.runtime.dispatch('run.step.payload', { runId: started.id, nodeId: 'script', kind: 'output' });
  expect(script).toMatchObject({ value: { profile } });
  const { value: { assets } } = await source.runtime.dispatch('run.step.payload', { runId: started.id, nodeId: 'video', kind: 'output' }) as { value: { assets: AssetRecord[] } };
  expect(assets.map(asset => asset.id)).toEqual(project.shots.map(shot => shot.videoAssetId));
  for (const asset of assets) {
    expect(asset).toMatchObject({ width: 180, height: 320, durationUs: 1_000_000 });
    expect(await probeMedia(asset.path, ffprobe)).toMatchObject({ width: 180, height: 320, frameRate: '60/1', audio: true });
  }
  const payload = await source.runtime.dispatch('run.step.payload', { runId: started.id, nodeId: 'export', kind: 'output' }) as { value: { videoPath: string; subtitlePath: string } };
  expect((await probeMedia(payload.value.videoPath, ffprobe)).audio).toBe(true); expect(await readFile(payload.value.subtitlePath, 'utf8')).toBe('');
  const backup = await source.runtime.dispatch('project.backup', { projectId: project.id }) as { path: string };
  expect(JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8'))).toMatchObject({ schemaVersion: 9, project: { workflow: { production: { manualPlanningFields: { brief: { topic: expect.any(String) } } } } } });
});

it.skipIf(!mediaAvailable)('recovers a committed native video without submitting or generating its text again', async () => {
  let interrupted = false;
  const source = await fixture(true, (point, activityId) => { if (!interrupted && point === 'after-commit' && activityId === 'video') { interrupted = true; throw new SimulatedProcessExit(); } });
  const path = join(source.options.dataDirectory, 'reference.wav');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2', path]);
  const bytes = await readFile(path);
  const asset = await source.runtime.dispatch('asset.import', { projectId: source.configured.id, path, kind: 'audio', purpose: 'reference-audio' }) as { id: string };
  await source.runtime.dispatch('project.update', { projectId: source.configured.id, revision: source.configured.revision, patch: {
    profile: { ...source.configured.profile, frameRate: { numerator: 60, denominator: 1 } },
    workflow: { ...source.configured.workflow, production: { ...source.configured.workflow.production, referenceAudioAssetIds: [asset.id] } },
  } });
  await unlink(path);
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.configured.id })); await source.runtime.waitForIdle(); await source.runtime.close(); runtimes.delete(source.runtime);
  const recovered = createRuntime({ ...source.options, failpoint: undefined }); runtimes.add(recovered);
  await recovered.dispatch('run.resume', { runId: started.id }); await recovered.waitForIdle();
  const run = runSchema.parse(await recovered.dispatch('run.get', { runId: started.id })); expect(run.status, run.error).toBe('succeeded'); expect(source.counts()).toEqual({ submissions: 1, textCalls: 4 });
  expect(source.received[0].content).toEqual(expect.arrayContaining([{ type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,' + bytes.toString('base64') }, role: 'reference_audio' }]));
});

it.skipIf(!mediaAvailable)('applies regenerated native sound without mixing an existing separate voice over it', async () => {
  const source = await fixture();
  await source.runtime.dispatch('run.start', { projectId: source.configured.id }); await source.runtime.waitForIdle();
  let project = await source.current(); const shotId = project.shots[0].id, voice = join(source.options.dataDirectory, 'voice.wav');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', voice]);
  await source.runtime.dispatch('asset.import', { projectId: project.id, shotId, path: voice, kind: 'audio' }); project = await source.current();
  expect(project.shots[0].audioAssetId).toBeTruthy();
  const run = runSchema.parse(await source.runtime.dispatch('shot.regenerate', { projectId: project.id, shotId, kind: 'video', revision: project.revision })); await source.runtime.waitForIdle();
  const finished = runSchema.parse(await source.runtime.dispatch('run.get', { runId: run.id })); expect(finished.status, finished.error).toBe('succeeded');
  const candidates = await source.runtime.dispatch('shot.candidates', { projectId: project.id, shotId }) as { items: ShotCandidate[] };
  const applied = projectSchema.parse(await source.runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidates.items[0].id, revision: project.revision }));
  expect(applied.shots[0].audioAssetId).toBeUndefined(); expect(applied.shots[0].audioProcessing).toMatchObject({ version: 2, videoAudio: { enabled: true } });
});

it.skipIf(!mediaAvailable)('keeps a silent provider result for inspection and never resubmits it during resume', async () => {
  const source = await fixture(false);
  const started = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: source.configured.id })); await source.runtime.waitForIdle();
  const failed = runSchema.parse(await source.runtime.dispatch('run.get', { runId: started.id })); expect(failed.status).toBe('needs_attention'); expect(failed.error).toContain('音轨');
  await source.runtime.dispatch('run.resume', { runId: started.id }); await source.runtime.waitForIdle(); expect(source.counts()).toEqual({ submissions: 1, textCalls: 4 });
});
