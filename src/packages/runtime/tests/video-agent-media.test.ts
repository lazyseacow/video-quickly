import { planningFixtureResponse, storyboardFixtureResponse } from '../../../../tests/fixtures/planning-response';
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, createNativeVideoWorkflow, modelSchema, projectSchema, runInspectionSchema, runSchema, type ProjectDocument } from '@video-quickly/contracts';
import { importSkillFixture } from '../../../../tests/fixtures/import-skill';
import { createActivityExecutor, validateMediaActivity } from '../../integrations/src/index.js';
import { probeMedia, runMedia } from '../../video/src/node.js';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../src/index.js';

const ffmpeg = process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
const mediaAvailable = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0 && spawnSync(ffprobe, ['-version'], { windowsHide: true }).status === 0;
const directories: string[] = [], servers: Server[] = [], runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it.skipIf(!mediaAvailable).each(['MCP', 'legacy planning Skill'] as const)('resumes Agent edits with %s and exports the reported timeline, music, captions and camera motion', async capability => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-agent-real-media-')); directories.push(directory);
  const sourceImage = join(directory, 'source.png'), videos = new Map<string, Buffer>();
  for (const color of ['blue', 'red']) {
    const path = join(directory, `${color}.mp4`);
    await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:r=30:d=1`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
    videos.set(`/${color}.mp4`, await readFile(path));
  }
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(directory, 'blue.mp4'), '-frames:v', '1', sourceImage]);
  const musicPath = join(directory, 'music.wav');
  await runMedia(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', musicPath]);
  const imageBytes = await readFile(sourceImage);
  const storyboard = [
    { title: '蓝色天空', narration: '雨落下了。', visualPrompt: '蓝色天空与水滴', durationUs: 1_000_000 },
    { title: '红色天空', narration: '红霞升起。', visualPrompt: '红色天空与晚霞', durationUs: 1_000_000 },
  ];
  let controllerRequests = 0, imageRequests = 0, videoRequests = 0, fromShotId = '', toShotId = '', rightShotId = '', baseUrl = '';
  let musicAssetId = '', foreignMusicId = '', musicClipId = '';
  const expectedFade = () => ({ fromShotId, toShotId, type: 'fade', startFrame: 24, endFrameExclusive: 30, startUs: 800_000, durationUs: 200_000 });
  const musicDraft = (gainDb = -6) => ({ assetId: musicAssetId, startUs: 200_000, sourceInUs: 0, durationUs: 2_000_000, gainDb, fadeInUs: 100_000, fadeOutUs: 0, loop: true });
  const splitDraft = () => ({ shotId: toShotId, atUs: 510_000 });
  const edit = (requestId: string, input: Record<string, unknown>) => ({ name: 'execute_video_task', input: { operation: 'edit', requestId, ...input } });
  const fixtureErrors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        const video = videos.get(request.url ?? '');
        response.setHeader('content-type', video ? 'video/mp4' : 'image/png');
        response.end(video ?? imageBytes); return;
      }
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const input = JSON.parse(body) as { narration?: string; prompt?: string; images?: string[]; tools?: Array<{ function: { name: string; parameters: { properties: Record<string, unknown> } } }>; messages?: Array<{ role: string; content?: string }> };
      response.setHeader('content-type', 'application/json');
      if (request.url === '/generate-image' || request.url === '/generate-video') {
        const shot = storyboard.find(value => value.narration === input.narration);
        expect(shot).toBeDefined(); expect(input.prompt).toContain(shot!.visualPrompt);
        const image = request.url === '/generate-image';
        if (image) imageRequests++;
        else { videoRequests++; expect(input.images).toEqual([`data:image/png;base64,${imageBytes.toString('base64')}`]); }
        response.end(JSON.stringify({ url: `${baseUrl}/${image ? 'source.png' : shot === storyboard[0] ? 'blue.mp4' : 'red.mp4'}` })); return;
      }
      const index = controllerRequests++;
      const receipt = JSON.parse(input.messages?.findLast(message => message.role === 'tool')?.content ?? '{}');
      let call: { name: string; input: Record<string, unknown> } | undefined;
      if (index === 0) {
        expect({ imageRequests, videoRequests }).toEqual({ imageRequests: 2, videoRequests: 2 });
        const fields = input.tools?.find(tool => tool.function.name === 'execute_video_task')?.function.parameters.properties;
        expect(fields?.operation).toMatchObject({ enum: ['image', 'video', 'edit', 'import'] });
        expect(fields?.transitions).toMatchObject({ items: { required: ['fromShotId', 'toShotId', 'type'], properties: { type: { enum: ['cut', 'fade', 'wipe'] } } } });
        expect(fields?.edits).not.toHaveProperty('items.properties.transition');
        expect(Object.keys((fields?.timeline as { properties: Record<string, unknown> }).properties)).toEqual(['splits', 'reorder', 'music', 'captions', 'subtitleMode', 'keyframes']);
        call = { name: 'read_project_snapshot', input: {} };
      }
      if (index === 1) {
        const project = projectSchema.parse(receipt);
        const [first, second] = project.shots; fromShotId = first.id; toShotId = second.id;
        for (const shot of [first, second]) {
          expect(shot.assetId).toBeTruthy(); expect(shot.videoAssetId).toBeTruthy(); expect(shot.animation.transition).toBe('cut');
        }
        call = { name: 'execute_video_task', input: { operation: 'import', requestId: 'import', shotId: fromShotId, data: imageBytes.toString('base64'), mimeType: 'image/png' } };
      }
      if (index === 2) {
        call = edit('edit', { edits: [{ shotId: fromShotId, inUs: 0, outUs: 800_000 }],
          transitions: [{ fromShotId, toShotId, type: 'fade' }],
        });
      }
      if (index === 3) {
        expect(receipt.result?.appliedTransitions).toEqual([expectedFade()]);
        call = { name: 'list_audio_assets', input: {} };
      }
      if (index === 4) {
        expect(receipt).toEqual({ items: [{ id: musicAssetId, name: 'music.wav', scope: 'library' }], nextCursor: null });
        call = edit('invalid', { timeline: { splits: [splitDraft()], music: { upsert: [{ ...musicDraft(), assetId: foreignMusicId }] } } });
      }
      if (index === 5) {
        expect(receipt).toMatchObject({ recoverable: true, error: expect.stringContaining('背景音乐必须引用') });
        expect(projectSchema.parse(receipt.project).shots.map(shot => shot.id)).toEqual([fromShotId, toShotId]);
        call = edit('structure', { timeline: {
          splits: [splitDraft()], music: { upsert: [musicDraft()] }, subtitleMode: 'script',
          captions: [{ shotId: fromShotId, cues: [{ startUs: 100_000, endUs: 500_000, text: ' OK ' }] }],
        } });
      }
      if (index === 6) {
        const { splits, music } = receipt.result.appliedEdits;
        expect(splits).toEqual([{ left: { shotId: toShotId, index: 1, startUs: 800_000, durationUs: 500_000, startFrame: 24, endFrameExclusive: 39 },
          right: { shotId: expect.any(String), index: 2, startUs: 1_300_000, durationUs: 500_000, startFrame: 39, endFrameExclusive: 54 } }]);
        rightShotId = splits[0].right.shotId;
        expect(music).toEqual({ upserted: [{ ...musicDraft(), id: expect.any(String), sourceDurationUs: 1_000_000, audibleDurationUs: 1_600_000 }], removedIds: [] });
        musicClipId = music.upserted[0].id;
        expect(receipt.result.appliedEdits).toMatchObject({ subtitleMode: 'script', captions: [{ shotId: fromShotId, projectStartUs: 0,
          cues: [{ text: 'OK', startUs: 100_000, endUs: 500_000 }] }] });
        call = edit('motion', { timeline: { reorder: { shotIds: [rightShotId], targetIndex: 1 },
          music: { upsert: [{ id: musicClipId, gainDb: -9 }], removeIds: ['old-music'] },
          keyframes: [{ shotId: rightShotId, frames: [
            { atUs: 200_000, panX: 0, panY: 0, zoom: 1, easing: 'linear' }, { atUs: 399_000, panX: .35, panY: 0, zoom: 1 },
          ] }],
        }, transitions: [{ fromShotId, toShotId: rightShotId, type: 'fade' }, { fromShotId: rightShotId, toShotId, type: 'cut' }] });
      }
      if (index === 7) {
        const applied = receipt.result.appliedEdits;
        expect(applied.shotOrder.map((position: { shotId: string }) => position.shotId)).toEqual([fromShotId, rightShotId, toShotId]);
        expect(applied.music).toEqual({ upserted: [{ ...musicDraft(-9), id: musicClipId, sourceDurationUs: 1_000_000, audibleDurationUs: 1_600_000 }], removedIds: ['old-music'] });
        expect(applied.keyframes).toMatchObject([{ shotId: rightShotId, frames: [
          { atUs: 200_000, timeUs: 700_000, frame: 30, panX: 0, zoom: 1, easing: 'linear' },
          { atUs: 400_000, timeUs: 900_000, frame: 36, panX: .35, zoom: 1, easing: 'smoothstep' },
        ] }]);
        expect(receipt.result.appliedTransitions).toMatchObject([{ ...expectedFade(), toShotId: rightShotId }, { type: 'cut', startFrame: 39, durationUs: 0 }]);
      }
      if (call) expect(input.tools?.map(tool => tool.function.name)).toContain(call.name);
      response.end(JSON.stringify({ id: `agent-real-media-${index}`, object: 'chat.completion', created: 1, model: 'controller', choices: [{ index: 0,
        finish_reason: call ? 'tool_calls' : 'stop', message: call
          ? { role: 'assistant', content: null, tool_calls: [{ id: `tool-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] }
          : { role: 'assistant', content: '已补充参考素材并调整剪辑。' } }] }));
    } catch (error) { fixtureErrors.push(error); response.statusCode = 500; response.end('Fixture failed'); }
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务未启动。'); baseUrl = `http://127.0.0.1:${address.port}`;
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, ffmpegPath: ffmpeg, preflightActivity: validateMediaActivity,
    executeActivity: createActivityExecutor({ ffmpegPath: ffmpeg }), provider: async ({ prompt }) => !prompt.includes('自动视频制作步骤：旁白与分镜')
      ? planningFixtureResponse(prompt, '生成蓝色天空与水滴。')
      : storyboardFixtureResponse(prompt, JSON.stringify({ shots: storyboard, entities: [] })) };
  let interrupted = false;
  const runtime = createRuntime({ ...options, failpoint(point, id) {
    if (point === 'after-commit' && id === 'animation/tool/structure') { interrupted = true; throw new SimulatedProcessExit(); }
  } });
  runtimes.add(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '实际制作验收', brief: '制作蓝天转到晚霞的两镜视频', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } }));
  musicAssetId = assetSchema.parse(await runtime.dispatch('asset.import', { path: musicPath })).id;
  const foreign = projectSchema.parse(await runtime.dispatch('project.create', { title: '其他项目' }));
  foreignMusicId = assetSchema.parse(await runtime.dispatch('asset.import', { path: musicPath, projectId: foreign.id })).id;
  const controller = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '制作 Agent', provider: 'openai-compatible', baseUrl: `${baseUrl}/v1`, model: 'controller', connectionType: 'text', capabilities: ['text', 'tools'] } }));
  async function mediaModel(connectionType: 'image' | 'video') {
    return modelSchema.parse(await runtime.dispatch('model.save', { model: { name: connectionType, provider: 'custom-http', baseUrl, model: connectionType, connectionType, capabilities: [connectionType],
      parameters: { requestPath: `generate-${connectionType}`, requestTemplate: { prompt: '{{prompt}}', images: '{{character_images}}', narration: '{{narration}}' }, resultUrlPath: 'url' } } }));
  }
  const image = await mediaModel('image'), video = await mediaModel('video'), workflow = createNativeVideoWorkflow();
  let skillId: string | undefined, connectionId: string | undefined;
  if (capability === 'legacy planning Skill') {
    const skillDirectory = join(directory, 'planning-skill'); await mkdir(skillDirectory);
    await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: planning-skill\ndescription: 创作时选择的叙事方法\n---\n保持镜头之间的画面连续。');
    skillId = (await importSkillFixture(runtime.dispatch, { path: skillDirectory })).skills[0].id;
  } else {
    const connection = await runtime.dispatch('tool.register', { server: { name: '剪辑能力', transport: 'http', url: `${baseUrl}/mcp`, enabled: true } }) as { id: string };
    connectionId = connection.id;
  }
  const shots = storyboard.map((shot, index) => ({ ...shot, id: `shot-${index + 1}`, animation: { transition: 'cut' } }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: {
    shots, musicClips: [{ id: 'old-music', assetId: musicAssetId, durationUs: 200_000, startUs: 1_000_000 }], workflow: {
    ...workflow,
    nodes: workflow.nodes.map(node => skillId && ['brief', 'style', 'script'].includes(node.id) ? { ...node, skillIds: [skillId] } : node),
    production: { ...workflow.production, agentInheritsPlanningSkills: skillId ? undefined : false, textModelId: controller.id, imageModelId: image.id, videoModelId: video.id, referenceMode: 'generate' },
  } } }));
  expect(project.workflow.production.agentSkillIds).toEqual([]);
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  expect(interrupted).toBe(true);
  await runtime.close(); runtimes.delete(runtime);
  const reopened = createRuntime(options); runtimes.add(reopened);
  if (skillId) await reopened.dispatch('skill.toggle', { skillId, enabled: false });
  if (connectionId) await reopened.dispatch('tool.toggle', { serverId: connectionId, enabled: false });
  await reopened.dispatch('run.resume', { runId: run.id }); await reopened.waitForIdle();
  const inspection = runInspectionSchema.parse(await reopened.dispatch('run.inspect', { runId: run.id, nodeId: 'animation' }));
  expect(fixtureErrors).toEqual([]); expect(inspection.run.status, inspection.run.error).toBe('succeeded');
  expect(inspection.selected?.node).toMatchObject({ kind: 'agent', skillIds: skillId ? [skillId] : [] });
  if (skillId) expect(inspection.selected?.skills).toEqual([expect.objectContaining({ id: skillId, enabled: true })]);
  expect(inspection.steps.map(step => step.id)).toEqual(['brief', 'style', 'script', 'assets', 'video', 'animation', 'animation/tool/import', 'animation/tool/edit', 'animation/tool/invalid', 'animation/tool/structure', 'animation/tool/motion', 'export']);
  expect(inspection.steps.filter(step => step.status !== 'succeeded').map(step => [step.id, step.status])).toEqual([['animation/tool/invalid', 'failed']]);
  expect({ controllerRequests, imageRequests, videoRequests }).toEqual({ controllerRequests: 8, imageRequests: 2, videoRequests: 2 });
  const saved = projectSchema.parse((await reopened.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project);
  expect(saved.shots[0]).toMatchObject({ id: fromShotId, durationUs: 800_000, animation: { transition: 'cut' }, audioProcessing: { videoAudio: { enabled: true } } });
  expect(saved.shots.map(shot => shot.id)).toEqual([fromShotId, rightShotId, toShotId]);
  expect(saved.shots[1]).toMatchObject({ id: rightShotId, sourceInUs: 500_000, sceneIndex: 1, animation: { transition: 'fade', keyframes: [{ timeUs: 700_000 }, { timeUs: 900_000 }] } });
  expect(saved.shots[2]).toMatchObject({ id: toShotId, sourceInUs: 0, sceneIndex: 1, animation: { transition: 'cut' } });
  expect(saved.musicClips).toEqual([{ id: musicClipId, ...musicDraft(-9) }]);
  expect(saved.workflow.production.subtitleMode).toBe('script');
  expect(saved.shots[0].assetId).toBeTruthy(); expect(saved.shots[0].videoAssetId).toBeTruthy();
  expect(await reopened.dispatch('node.result', { runId: run.id, nodeId: 'animation/tool/edit' })).toMatchObject({ appliedTransitions: [expectedFade()] });
  const output = await reopened.dispatch('node.result', { runId: run.id, nodeId: 'export' }) as { videoPath: string; subtitlePath: string; timelinePath: string };
  const exported = await probeMedia(output.videoPath, ffprobe);
  expect(exported).toMatchObject({ width: 160, height: 90, audio: true }); expect(exported.duration).toBeCloseTo(1.8, 1);
  const timeline = JSON.parse(await readFile(output.timelinePath, 'utf8'));
  expect(timeline.renderSchedule[1].firstFrame).toBe(expectedFade().startFrame);
  expect(timeline.clips.map((clip: { shotId: string }) => clip.shotId)).toEqual([fromShotId, rightShotId, toShotId]);
  expect(timeline.musicClips).toEqual(saved.musicClips);
  const rgbPath = join(directory, 'export.rgb');
  await runMedia(ffmpeg, ['-v', 'error', '-i', output.videoPath, '-pix_fmt', 'rgb24', '-f', 'rawvideo', rgbPath]);
  const rgb = await readFile(rgbPath);
  const { startFrame, endFrameExclusive } = expectedFade();
  const pixel = (frame: number, x = 80) => { const offset = ((frame * 90 + 45) * 160 + x) * 3; return rgb.subarray(offset, offset + 3); };
  expect(pixel(startFrame)[2]).toBeGreaterThan(230);
  expect(pixel(startFrame)[0]).toBeLessThan(20);
  for (const channel of [0, 2]) {
    expect(pixel(startFrame + 3)[channel]).toBeGreaterThan(110);
    expect(pixel(startFrame + 3)[channel]).toBeLessThan(145);
  }
  expect(pixel(endFrameExclusive - 1)[2]).toBeGreaterThan(20);
  expect(pixel(endFrameExclusive)[0]).toBeGreaterThan(230);
  expect(pixel(endFrameExclusive)[2]).toBeLessThan(20);
  expect(pixel(30, 24)[0]).toBeGreaterThan(230);
  expect(pixel(36, 24)[0]).toBeLessThan(65);
  expect(pixel(39, 24)[0]).toBeGreaterThan(230);
  expect(await readFile(output.subtitlePath, 'utf8')).toContain('00:00:00,100 --> 00:00:00,500\nOK');
  const pcmPath = join(directory, 'export.pcm');
  await runMedia(ffmpeg, ['-v', 'error', '-i', output.videoPath, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', pcmPath]);
  const pcm = await readFile(pcmPath);
  function musicAmplitude(startSample: number) {
    let real = 0, imaginary = 0;
    for (let index = 0; index < 800; index++) {
      const sample = pcm.readInt16LE((startSample + index) * 2) / 32768;
      const angle = 2 * Math.PI * 880 * index / 8000;
      real += sample * Math.cos(angle); imaginary += sample * Math.sin(angle);
    }
    return 2 * Math.hypot(real, imaginary) / 800;
  }
  expect(musicAmplitude(8_000)).toBeGreaterThan(.01);
  expect(musicAmplitude(320)).toBeLessThan(musicAmplitude(8_000) * .25);
  const replay = await reopened.dispatch('run.replay', { runId: run.id }) as { externalCalls: number; matchesSnapshot: boolean };
  expect(replay).toMatchObject({ externalCalls: 0, matchesSnapshot: true }); expect(imageRequests).toBe(2); expect(videoRequests).toBe(2);
}, 60_000);
