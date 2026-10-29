import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, projectSchema, captionTrackSchema, type ModelProfile, type ProjectDocument, type RunRecord, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { createActivityExecutor } from '../packages/integrations/src';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';

const directories: string[] = [];
const servers: Server[] = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => { void Promise.resolve(handler(request, response)).catch(error => response.destroy(error instanceof Error ? error : undefined)); }); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('无效的测试服务地址');
  return `http://127.0.0.1:${address.port}/v1`;
}

function open(directory: string, extra: Partial<RuntimeOptions> = {}) {
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/not-used-by-transcription', executeActivity: createActivityExecutor(), ...extra }); runtimes.add(runtime); return runtime;
}

async function setup(runtime: ReturnType<typeof createRuntime>, directory: string, baseUrl: string) {
  const original = projectSchema.parse(await runtime.dispatch('project.create', { title: 'ASR恢复' }));
  const path = join(directory, 'voice.wav'); await writeFile(path, Buffer.from('fixture audio upload'));
  const asset = assetSchema.parse(await runtime.dispatch('asset.import', { projectId: original.id, path, kind: 'audio' }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { shots: [{ id: 'voice-shot', title: '旁白镜头', narration: '原始旁白', visualPrompt: '', durationUs: 1_000_000, audioAssetId: asset.id }, { id: 'untouched-shot', title: '保持原样', narration: '其他镜头旁白', visualPrompt: '', durationUs: 1_000_000 }] } }));
  const model = await runtime.dispatch('model.save', { model: { name: 'ASR本机夹具', provider: 'openai-compatible', baseUrl, model: 'fixture-asr', capabilities: ['asr'] } }) as ModelProfile;
  return { project, asset, model };
}

async function location() { const directory = await mkdtemp(join(tmpdir(), 'video-quickly-asr-runtime-')); directories.push(directory); return directory; }
async function savedRun(runtime: ReturnType<typeof createRuntime>, id: string) {
  const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  const run = snapshot.runs.find(run => run.id === id); if (!run) throw new Error('未找到运行'); return run;
}
async function start(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument, model: ModelProfile) {
  return runtime.dispatch('caption.transcribe', { projectId: project.id, revision: project.revision, shotId: project.shots[0].id, modelId: model.id }) as Promise<RunRecord>;
}
async function assertProjectUnchanged(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument) {
  expect((await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project).toEqual(project);
}

it.each(['after-result', 'after-commit'] as const)('restores ASR after %s without resubmitting or automatically applying captions', async point => {
  let calls = 0, crashed = false;
  const baseUrl = await listen(async (request, response) => { for await (const _chunk of request) { /* Drain the actual multipart upload. */ } calls++; response.end(JSON.stringify({ segments: [{ start: .1, end: .8, text: '真实时间戳' }] })); });
  const directory = await location();
  const first = open(directory, { failpoint(current, id) { if (!crashed && current === point && id === 'caption') { crashed = true; throw new SimulatedProcessExit(); } } });
  const { project, model } = await setup(first, directory, baseUrl);
  const run = await start(first, project, model); await first.waitForIdle();
  expect(crashed).toBe(true); expect(calls).toBe(1);
  await first.close(); runtimes.delete(first);
  const second = open(directory);
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  expect((await savedRun(second, run.id)).status).toBe('succeeded'); expect(calls).toBe(1);
  const result = await second.dispatch('node.result', { runId: run.id, nodeId: 'caption' }) as { captionTrack: unknown };
  expect(captionTrackSchema.parse(result.captionTrack).cues[0]).toMatchObject({ startUs: 100_000, endUs: 800_000, text: '真实时间戳' });
  await assertProjectUnchanged(second, project);
});

it('refuses completed cached captions after source bytes change during a restart', async () => {
  let calls = 0, crashed = false;
  const baseUrl = await listen(async (request, response) => { for await (const _chunk of request) { /* Drain upload. */ } calls++; response.end(JSON.stringify({ segments: [{ start: 0, end: .8, text: '旧音频' }] })); });
  const directory = await location();
  const first = open(directory, { failpoint(point, id) { if (!crashed && point === 'after-commit' && id === 'caption') { crashed = true; throw new SimulatedProcessExit(); } } });
  const { project, model, asset } = await setup(first, directory, baseUrl);
  const run = await start(first, project, model); await first.waitForIdle();
  await first.close(); runtimes.delete(first); await writeFile(asset.path, 'tampered source audio');
  const second = open(directory);
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  expect(await savedRun(second, run.id)).toMatchObject({ status: 'needs_attention', error: expect.stringContaining('源音频已更换或损坏') });
  expect(calls).toBe(1); await assertProjectUnchanged(second, project);
});

it('keeps an unknown provider submission blocked through restart and resume', async () => {
  let calls = 0;
  const baseUrl = await listen(async (request, response) => { for await (const _chunk of request) { /* Drain upload. */ } calls++; response.destroy(); });
  const directory = await location(), first = open(directory);
  const { project, model } = await setup(first, directory, baseUrl);
  const run = await start(first, project, model); await first.waitForIdle();
  expect((await savedRun(first, run.id)).activities[0].status).toBe('unknown'); expect(calls).toBe(1);
  await first.close(); runtimes.delete(first);
  const second = open(directory);
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  expect((await savedRun(second, run.id)).activities[0].status).toBe('unknown'); expect(calls).toBe(1);
  await assertProjectUnchanged(second, project);
});

it('preserves the fixed missing-timestamps explanation and rejects stale revision before starting another request', async () => {
  let calls = 0;
  const baseUrl = await listen(async (request, response) => { for await (const _chunk of request) { /* Drain upload. */ } calls++; response.end(JSON.stringify({ text: '只有文字' })); });
  const directory = await location(), runtime = open(directory);
  const { project, model } = await setup(runtime, directory, baseUrl);
  await expect(start(runtime, { ...project, revision: project.revision - 1 }, model)).rejects.toThrow('其他视图修改');
  expect(calls).toBe(0);
  const run = await start(runtime, project, model); await runtime.waitForIdle();
  const failed = await savedRun(runtime, run.id);
  expect(failed.error).toContain('模型没有返回语音时间戳'); expect(failed.activities[0].status).toBe('unknown'); expect(calls).toBe(1);
  await assertProjectUnchanged(runtime, project);
});

it('applies aligned captions only to the requested shot after an explicit node.apply', async () => {
  const baseUrl = await listen(async (request, response) => { for await (const _chunk of request) { /* Drain upload. */ } response.end(JSON.stringify({ segments: [{ start: .1, end: .8, text: '应用识别字幕' }] })); });
  const directory = await location(), runtime = open(directory);
  const { project, model, asset } = await setup(runtime, directory, baseUrl);
  const run = await start(runtime, project, model); await runtime.waitForIdle();
  await assertProjectUnchanged(runtime, project);
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: run.id, nodeId: 'caption', revision: project.revision }));
  expect(applied.revision).toBe(project.revision + 1);
  expect(applied.shots[0].captionTrack).toMatchObject({ alignment: 'speech', sourceAssetId: asset.id, sourceSha256: asset.sha256, cues: [{ startUs: 100_000, endUs: 800_000, text: '应用识别字幕' }] });
  expect(applied.shots[1]).toEqual(project.shots[1]);
});

it('rejects applying a completed transcript when the underlying audio file has changed', async () => {
  let calls = 0;
  const baseUrl = await listen(async (request, response) => { for await (const _chunk of request) { /* Drain upload. */ } calls++; response.end(JSON.stringify({ segments: [{ start: .1, end: .8, text: '已完成识别' }] })); });
  const directory = await location(), runtime = open(directory);
  const { project, model, asset } = await setup(runtime, directory, baseUrl);
  const run = await start(runtime, project, model); await runtime.waitForIdle();
  await writeFile(asset.path, 'source audio changed after recognition');
  await expect(runtime.dispatch('node.apply', { runId: run.id, nodeId: 'caption', revision: project.revision })).rejects.toThrow('源音频已更换或损坏');
  expect(calls).toBe(1); await assertProjectUnchanged(runtime, project);
});
