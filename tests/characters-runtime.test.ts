import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, characterProfileSchema, projectSchema, workflowNodeSchema, type AssetRecord, type CharacterProfile, type ModelProfile, type ProjectDocument, type RunRecord, type ShotCandidate, type UsageRecord, type WorkspaceSnapshot } from '@video-quickly/contracts';
import { createActivityExecutor, validateMediaActivity } from '../packages/integrations/src';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';

const directories: string[] = [], servers: Server[] = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function open(directory: string, extra: Partial<RuntimeOptions> = {}) { const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused', preflightActivity: validateMediaActivity, executeActivity: createActivityExecutor(), ...extra }); runtimes.add(runtime); return runtime; }
async function fixture(extra: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-characters-api-')); directories.push(directory);
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = createServer((request, response) => { void (async () => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    const path = request.url ?? ''; requests.push({ path, body: JSON.parse(body) as Record<string, unknown> }); response.setHeader('content-type', 'application/json');
    if (path.endsWith('/chat/completions')) response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ shots: [{ title: '新标题', narration: '新旁白', visualPrompt: '新画面', durationUs: 1_000_000 }] }) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
    else response.end(JSON.stringify({ data: [{ b64_json: Buffer.concat([png, Buffer.from(String(requests.length))]).toString('base64') }] }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('无效测试服务');
  const runtime = open(directory, extra);
  const profiles: CharacterProfile[] = [], assets: AssetRecord[] = [];
  for (const name of ['目标角色', '另镜头角色']) {
    const path = join(directory, `${name}.png`); await writeFile(path, png);
    const asset = assetSchema.parse(await runtime.dispatch('asset.import', { path, kind: 'image' })); assets.push(asset);
    profiles.push(characterProfileSchema.parse(await runtime.dispatch('character.save', { character: { name, description: `${name}的固定设定`, referenceAssetIds: [asset.id] } })));
  }
  const original = projectSchema.parse(await runtime.dispatch('project.create', { title: '角色快照' }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { shots: profiles.map((profile, index) => ({ id: `shot-${index}`, title: `镜头 ${index}`, narration: '示例旁白', visualPrompt: '示例画面', durationUs: 1_000_000, characterIds: [profile.id] })) } }));
  const model = await runtime.dispatch('model.save', { model: { name: '图像角色模型', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'gpt-image-fixture', capabilities: ['image'], pricing: { currency: 'USD', perImage: .4 } } }) as ModelProfile;
  return { runtime, directory, project, profiles, assets, model, requests };
}
async function generate(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument, model: ModelProfile) { const run = await runtime.dispatch('shot.regenerate', { projectId: project.id, shotId: project.shots[0].id, revision: project.revision, kind: 'image', modelId: model.id }) as RunRecord; await runtime.waitForIdle(); return run; }
async function candidates(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument) { return (await runtime.dispatch('shot.candidates', { projectId: project.id, shotId: project.shots[0].id }) as { items: ShotCandidate[] }).items; }

it('uses only the selected shot character, keeps the candidate snapshot and rejects a later profile edit', async () => {
  const { runtime, project, profiles, model, requests, assets } = await fixture();
  const run = await generate(runtime, project, model);
  expect(requests).toHaveLength(1); expect(requests[0].path).toBe('/v1/images/edits');
  expect(requests[0].body.prompt).toContain(profiles[0].description); expect(requests[0].body.prompt).not.toContain(profiles[1].description); expect(requests[0].body.images).toEqual([{ image_url: `data:image/png;base64,${png.toString('base64')}` }]);
  const [candidate] = await candidates(runtime, project); expect(candidate.characters).toEqual([profiles[0]]);
  const costs = await runtime.dispatch('cost.list', { runId: run.id }) as { items: UsageRecord[] };
  expect(costs.items[0]).toMatchObject({ status: 'completed', requestMetrics: { source: 'request', images: 1 }, estimatedAmount: .4, estimateBasis: 'request' }); expect(costs.items[0].actualAmount).toBeUndefined();
  await runtime.dispatch('character.save', { character: { ...profiles[0], description: '更新过的角色设定' } });
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: project.revision })).rejects.toThrow('角色设定');
  await expect(runtime.dispatch('asset.delete', { assetId: assets[0].id })).rejects.toThrow('正在使用');
});

it('restores frozen character profiles rather than substituting newly edited library settings', async () => {
  let crashed = false;
  const { runtime: first, directory, project, profiles, model, requests } = await fixture({ failpoint(point, id) { if (!crashed && point === 'after-result' && id === 'regenerate') { crashed = true; throw new SimulatedProcessExit(); } } });
  const run = await generate(first, project, model); expect(crashed).toBe(true);
  await first.close(); runtimes.delete(first);
  const second = open(directory);
  await second.dispatch('character.save', { character: { ...profiles[0], description: '恢复前人工编辑' } });
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  const [candidate] = await candidates(second, project);
  expect(candidate.characters).toEqual([profiles[0]]); expect(requests).toHaveLength(1);
  await expect(second.dispatch('shot.candidate.apply', { projectId: project.id, candidateId: candidate.id, revision: project.revision })).rejects.toThrow('角色设定');
});

it('rejects changed reference bytes and unsupported image references before journaling or reserving cost', async () => {
  const { runtime, project, model, assets, requests } = await fixture();
  const incompatible = await runtime.dispatch('model.save', { model: { ...model, id: undefined, name: '不支持角色参考', model: 'dall-e-3' } }) as ModelProfile;
  const invalid = await generate(runtime, project, incompatible);
  const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(snapshot.runs.find(run => run.id === invalid.id)).toMatchObject({ status: 'needs_attention', error: expect.stringContaining('图像编辑协议'), activities: [] });
  expect((await runtime.dispatch('cost.list', { runId: invalid.id }) as { items: UsageRecord[] }).items).toEqual([]); expect(requests).toHaveLength(0);
  await writeFile(assets[0].path, Buffer.alloc(png.length, 1));
  const corrupted = await generate(runtime, project, model);
  expect((await runtime.dispatch('cost.list', { runId: corrupted.id }) as { items: UsageRecord[] }).items).toEqual([]); expect(requests).toHaveLength(0);
});

it('retains existing character bindings through an ordinary script to image pipeline', async () => {
  const { runtime, project, model, profiles, requests } = await fixture();
  const single = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [project.shots[0]] } }));
  const text = await runtime.dispatch('model.save', { model: { ...model, id: undefined, name: '文字角色模型', model: 'text-fixture', capabilities: ['text'], pricing: null } }) as ModelProfile;
  await runtime.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'character-pipeline', version: 1, name: '角色连贯性', nodes: [workflowNodeSchema.parse({ id: 'script', kind: 'script', label: '脚本', modelId: text.id }), workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: '图片', modelId: model.id })], edges: [{ id: 'next', source: 'script', target: 'assets' }] } });
  const run = await runtime.dispatch('run.start', { projectId: single.id }) as RunRecord; await runtime.waitForIdle();
  const snapshot = await runtime.dispatch('workspace.snapshot') as WorkspaceSnapshot;
  expect(snapshot.runs.find(record => record.id === run.id)?.status).toBe('succeeded');
  expect(requests).toHaveLength(2); expect(JSON.stringify(requests[0].body.messages)).toContain('仅文字，没有发送参考图'); expect(JSON.stringify(requests[0].body.messages)).toContain(profiles[0].description);
  expect(requests[1].path).toBe('/v1/images/edits'); expect(requests[1].body.images).toHaveLength(1);
  expect((await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project.shots[0].characterIds).toEqual([profiles[0].id]);
});

it('backs up distinct same-named candidate files and restores character IDs with public reference assets', async () => {
  const { runtime, project, profiles, model, directory } = await fixture();
  await generate(runtime, project, model); await generate(runtime, project, model);
  const destination = join(directory, 'backup'); await mkdir(destination);
  await runtime.dispatch('project.backup', { projectId: project.id, destination });
  const manifest = JSON.parse(await readFile(join(destination, 'project.json'), 'utf8')) as { characters: CharacterProfile[]; assets: AssetRecord[] };
  expect(manifest.characters).toEqual(profiles); expect(new Set(manifest.assets.map(asset => asset.path)).size).toBe(manifest.assets.length);
  const restored = projectSchema.parse(await runtime.dispatch('project.importBackup', { path: destination }));
  expect(restored.shots[0].characterIds?.[0]).not.toBe(profiles[0].id);
  const profile = characterProfileSchema.parse(await runtime.dispatch('character.get', { characterId: restored.shots[0].characterIds![0] }));
  expect(profile.description).toBe(profiles[0].description);
  const references = await runtime.dispatch('character.references', { characterId: profile.id }) as AssetRecord[];
  expect(references[0].projectId).toBeUndefined(); expect(await readFile(references[0].path)).toEqual(png);
});

it('rejects unknown character associations in project and single-shot save APIs without changing revision', async () => {
  const { runtime, project } = await fixture();
  await expect(runtime.dispatch('project.saveShot', { projectId: project.id, revision: project.revision, shot: { ...project.shots[0], characterIds: ['missing-character'] } })).rejects.toThrow('角色不存在');
  await expect(runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { shots: [{ ...project.shots[0], characterIds: ['missing-character'] }] } })).rejects.toThrow('角色不存在');
  expect((await runtime.dispatch('project.get', { projectId: project.id }) as { project: ProjectDocument }).project).toEqual(project);
});
