import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createNativeVideoWorkflow, modelSchema, projectSchema, runInspectionSchema, runSchema, type ProjectDocument } from '@video-quickly/contracts';
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

it.skipIf(!mediaAvailable)('resumes after applying Agent edits and exports a real trimmed MP4 without regenerating workflow media', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-agent-real-media-')); directories.push(directory);
  const sourceVideo = join(directory, 'source.mp4'), sourceImage = join(directory, 'source.png');
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceVideo]);
  await runMedia(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourceVideo, '-frames:v', '1', sourceImage]);
  const videoBytes = await readFile(sourceVideo), imageBytes = await readFile(sourceImage);
  let controllerRequests = 0, imageRequests = 0, videoRequests = 0, shotId = '', baseUrl = '';
  const fixtureErrors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        response.setHeader('content-type', request.url === '/source.mp4' ? 'video/mp4' : 'image/png');
        response.end(request.url === '/source.mp4' ? videoBytes : imageBytes); return;
      }
      let body = ''; for await (const chunk of request) body += chunk.toString();
      const input = JSON.parse(body) as { prompt?: string; tools?: Array<{ function: { name: string; parameters: { properties: Record<string, { enum?: string[] }> } } }>; messages?: Array<{ role: string; content?: string }> };
      response.setHeader('content-type', 'application/json');
      if (request.url === '/generate-image') { imageRequests++; expect(input.prompt).toContain('蓝色天空'); response.end(JSON.stringify({ url: `${baseUrl}/source.png` })); return; }
      if (request.url === '/generate-video') { videoRequests++; expect(input.prompt).toContain('蓝色天空'); response.end(JSON.stringify({ url: `${baseUrl}/source.mp4` })); return; }
      const index = controllerRequests++;
      let call: { name: string; input: Record<string, unknown> } | undefined;
      if (index === 0) {
        expect({ imageRequests, videoRequests }).toEqual({ imageRequests: 1, videoRequests: 1 });
        expect(input.tools?.find(tool => tool.function.name === 'execute_video_task')?.function.parameters.properties.operation.enum).toEqual(['image', 'video', 'edit', 'import']);
        call = { name: 'read_project_snapshot', input: {} };
      }
      if (index === 1) {
        const project = projectSchema.parse(JSON.parse(input.messages?.findLast(message => message.role === 'tool')?.content ?? '{}'));
        const shot = project.shots[0]; shotId = shot.id;
        expect(shot.assetId).toBeTruthy(); expect(shot.videoAssetId).toBeTruthy();
        call = { name: 'execute_video_task', input: { operation: 'import', requestId: 'import', shotId, data: imageBytes.toString('base64'), mimeType: 'image/png' } };
      }
      if (index === 2) call = { name: 'execute_video_task', input: { operation: 'edit', requestId: 'edit', edits: [{ shotId, inUs: 0, outUs: 800_000, transition: 'cut' }] } };
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
    executeActivity: createActivityExecutor({ ffmpegPath: ffmpeg }), provider: async () => JSON.stringify({ shots: [{ title: '蓝色天空', narration: '雨落下了。', visualPrompt: '蓝色天空与水滴', durationUs: 1_000_000 }], entities: [] }) };
  let interrupted = false;
  const runtime = createRuntime({ ...options, failpoint(point, id) {
    if (point === 'after-commit' && id === 'animation/tool/edit') { interrupted = true; throw new SimulatedProcessExit(); }
  } });
  runtimes.add(runtime);
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '实际制作验收', brief: '制作蓝色天空的一秒视频', profile: { width: 160, height: 90, frameRate: { numerator: 30, denominator: 1 } } }));
  const controller = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '制作 Agent', provider: 'openai-compatible', baseUrl: `${baseUrl}/v1`, model: 'controller', connectionType: 'text', capabilities: ['text', 'tools'] } }));
  async function mediaModel(connectionType: 'image' | 'video') {
    return modelSchema.parse(await runtime.dispatch('model.save', { model: { name: connectionType, provider: 'custom-http', baseUrl, model: connectionType, connectionType, capabilities: [connectionType],
      parameters: { requestPath: `generate-${connectionType}`, requestTemplate: { prompt: '{{prompt}}' }, resultUrlPath: 'url' } } }));
  }
  const image = await mediaModel('image'), video = await mediaModel('video'), workflow = createNativeVideoWorkflow();
  const connection = await runtime.dispatch('tool.register', { server: { name: '剪辑能力', transport: 'http', url: `${baseUrl}/mcp`, enabled: true } }) as { id: string };
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: { workflow: {
    ...workflow, production: { ...workflow.production, textModelId: controller.id, imageModelId: image.id, videoModelId: video.id, referenceMode: 'generate' },
  } } }));
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id })); await runtime.waitForIdle();
  expect(interrupted).toBe(true);
  await runtime.close(); runtimes.delete(runtime);
  const reopened = createRuntime(options); runtimes.add(reopened);
  await reopened.dispatch('tool.toggle', { serverId: connection.id, enabled: false });
  await reopened.dispatch('run.resume', { runId: run.id }); await reopened.waitForIdle();
  const inspection = runInspectionSchema.parse(await reopened.dispatch('run.inspect', { runId: run.id }));
  expect(fixtureErrors).toEqual([]); expect(inspection.run.status, inspection.run.error).toBe('succeeded');
  expect(inspection.steps.map(step => step.id)).toEqual(['brief', 'style', 'script', 'assets', 'video', 'animation', 'animation/tool/import', 'animation/tool/edit', 'export']);
  expect(inspection.steps.every(step => step.status === 'succeeded')).toBe(true);
  expect({ controllerRequests, imageRequests, videoRequests }).toEqual({ controllerRequests: 4, imageRequests: 1, videoRequests: 1 });
  const saved = projectSchema.parse((await reopened.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project);
  expect(saved.shots[0]).toMatchObject({ id: shotId, durationUs: 800_000, audioProcessing: { videoAudio: { enabled: true } } });
  expect(saved.shots[0].assetId).toBeTruthy(); expect(saved.shots[0].videoAssetId).toBeTruthy();
  const output = await reopened.dispatch('node.result', { runId: run.id, nodeId: 'export' }) as { videoPath: string; subtitlePath: string };
  const exported = await probeMedia(output.videoPath, ffprobe);
  expect(exported).toMatchObject({ width: 160, height: 90, audio: true }); expect(exported.duration).toBeCloseTo(.8, 1);
  expect(await readFile(output.subtitlePath, 'utf8')).toBe('');
  const replay = await reopened.dispatch('run.replay', { runId: run.id }) as { externalCalls: number; matchesSnapshot: boolean };
  expect(replay).toMatchObject({ externalCalls: 0, matchesSnapshot: true }); expect(imageRequests).toBe(1); expect(videoRequests).toBe(1);
}, 30_000);
