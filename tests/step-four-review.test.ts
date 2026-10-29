import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { projectSchema, workflowNodeSchema, type AssetRecord, type CharacterProfile, type ModelProfile, type RunRecord, type UsageRecord } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit } from '../packages/runtime/src';

const directories: string[] = [];
const servers: Server[] = [];
const runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it.each(['max_tokens', 'max_completion_tokens'] as const)('forwards configured %s and advanced text parameters to the real DeepAgent request', async tokenParameter => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((request, response) => { void (async () => {
    let body = ''; for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body) as Record<string, unknown>);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 'review-response', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '完成独立参数检查。' } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务地址无效。');
  const directory = await mkdtemp(join(tmpdir(), 'vq-step-four-review-')); directories.push(directory);
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-for-agent-review' }); runtimes.push(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: 'Agent参数审查' }));
  const model = await runtime.dispatch('model.save', { model: { name: '审查夹具', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', capabilities: ['text', 'tools'], parameters: { [tokenParameter]: 73, temperature: .2, top_p: .91 } } }) as ModelProfile;
  await runtime.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'review', name: '参数审查', version: 1, nodes: [workflowNodeSchema.parse({ id: 'agent', kind: 'agent', label: 'Agent', modelId: model.id })], edges: [] } });
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord;
  await runtime.waitForIdle();
  expect(await runtime.dispatch('run.get', { runId: run.id })).toMatchObject({ status: 'succeeded' });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ [tokenParameter]: 73, temperature: .2, top_p: .91 });
}, 30_000);

it('backs up multiple generated candidates whose source directories contain the same basename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-backup-review-')); directories.push(directory);
  let generated = 0;
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-for-backup-review', executeActivity: async context => {
    generated++;
    const folder = join(directory, context.runId); await mkdir(folder);
    const path = join(folder, 'same-shot.png'), bytes = Buffer.from(`generated fixture ${generated}`);
    await writeFile(path, bytes);
    const asset: AssetRecord = { id: `candidate-asset-${generated}`, projectId: context.project.id, shotId: context.project.shots[0].id, name: 'same-shot.png', kind: 'image', path, mimeType: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: '', provenance: 'isolated external-result fixture', active: true, retained: false };
    return { assets: [asset] };
  } }); runtimes.push(runtime);
  const original = projectSchema.parse(await runtime.dispatch('project.create', { title: '候选备份审查' }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { shots: [{ id: 'shot', title: '镜头', narration: '', visualPrompt: '画面', durationUs: 1_000_000 }] } }));
  const model = await runtime.dispatch('model.save', { model: { name: '媒体边界夹具', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', capabilities: ['image'] } }) as ModelProfile;
  for (let index = 0; index < 2; index++) {
    const run = await runtime.dispatch('shot.regenerate', { projectId: project.id, revision: project.revision, shotId: 'shot', kind: 'image', modelId: model.id }) as RunRecord;
    await runtime.waitForIdle(); expect(await runtime.dispatch('run.get', { runId: run.id })).toMatchObject({ status: 'succeeded' });
  }
  expect(generated).toBe(2);
  const backup = await runtime.dispatch('project.backup', { projectId: project.id, destination: join(directory, 'backup') }) as { path: string };
  await expect(runtime.dispatch('project.importBackup', { path: backup.path })).resolves.toMatchObject({ title: '候选备份审查（恢复）' });
  const manifest = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')) as { assets: AssetRecord[] };
  expect(new Set(manifest.assets.map(asset => asset.path)).size).toBe(2);
});

it('keeps existing shot character bindings through an ordinary script-to-image workflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-role-flow-review-')); directories.push(directory);
  let seenCharacterIds: string[] | undefined;
  let seenCharacters: CharacterProfile[] | undefined;
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-for-character-review',
    provider: async () => JSON.stringify({ shots: [{ title: '重写后的镜头', narration: '新旁白', visualPrompt: '新画面', durationUs: 1_000_000 }] }),
    executeActivity: async context => { seenCharacterIds = context.project.shots[0].characterIds; seenCharacters = context.characters; return { ready: true }; },
  }); runtimes.push(runtime);
  const character = await runtime.dispatch('character.save', { character: { name: '小青', description: '固定蓝色外衣', referenceAssetIds: [] } }) as CharacterProfile;
  const original = projectSchema.parse(await runtime.dispatch('project.create', { title: '普通角色流程' }));
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { shots: [{ id: 'same-shot', title: '原镜头', narration: '原旁白', visualPrompt: '原画面', durationUs: 1_000_000, characterIds: [character.id] }] } }));
  const text = await runtime.dispatch('model.save', { model: { name: '脚本夹具', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture-text', capabilities: ['text'] } }) as ModelProfile;
  const image = await runtime.dispatch('model.save', { model: { name: '图片夹具', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture-image', capabilities: ['image'] } }) as ModelProfile;
  await runtime.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'roles', name: '普通角色流程', version: 1, nodes: [workflowNodeSchema.parse({ id: 'script', kind: 'script', label: '脚本', modelId: text.id }), workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: '图片', modelId: image.id })], edges: [{ id: 'edge', source: 'script', target: 'assets' }] } });
  const run = await runtime.dispatch('run.start', { projectId: project.id }) as RunRecord;
  await runtime.waitForIdle(); expect(await runtime.dispatch('run.get', { runId: run.id })).toMatchObject({ status: 'succeeded' });
  expect(seenCharacterIds).toEqual([character.id]); expect(seenCharacters).toEqual([character]);
});

it('rejects an ordinary generated result after a referenced global character changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-role-apply-review-')); directories.push(directory);
  let originalDescription: string | undefined;
  const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-for-character-apply', executeActivity: async context => {
    originalDescription = context.characters?.[0].description;
    const path = join(directory, 'image.png'), bytes = Buffer.from('isolated generated image result'); await writeFile(path, bytes);
    return { assets: [{ id: 'generated-image', projectId: context.project.id, shotId: context.project.shots[0].id, name: 'image.png', kind: 'image', path, mimeType: 'image/png', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, active: true, retained: false, createdAt: '', provenance: 'external boundary fixture' }] };
  } }); runtimes.push(runtime);
  const character = await runtime.dispatch('character.save', { character: { name: '小青', description: '旧角色衣服', referenceAssetIds: [] } }) as CharacterProfile;
  const original = projectSchema.parse(await runtime.dispatch('project.create', { title: '普通结果角色保护' }));
  await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { shots: [{ id: 'same-shot', title: '原镜头', narration: '', visualPrompt: '', durationUs: 1_000_000, characterIds: [character.id] }] } });
  const model = await runtime.dispatch('model.save', { model: { name: '图片夹具', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', capabilities: ['image'] } }) as ModelProfile;
  await runtime.dispatch('workflow.save', { projectId: original.id, workflow: { id: 'image', name: '图片', version: 1, nodes: [workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: '图片', modelId: model.id })], edges: [] } });
  const before = await runtime.dispatch('project.get', { projectId: original.id }) as { project: unknown };
  const project = projectSchema.parse(before.project);
  const run = await runtime.dispatch('run.start', { projectId: original.id }) as RunRecord;
  await runtime.waitForIdle(); expect(await runtime.dispatch('run.get', { runId: run.id })).toMatchObject({ status: 'succeeded' });
  expect(originalDescription).toBe('旧角色衣服');
  await runtime.dispatch('character.save', { character: { ...character, description: '人工改为新衣服' } });
  await expect(runtime.dispatch('node.apply', { runId: run.id, nodeId: 'assets', revision: project.revision })).rejects.toThrow('角色');
});

it.each(['after-dispatch', 'after-result', 'after-commit'] as const)('keeps one measured cost record through %s and recovery without repeating a request', async point => {
  const directory = await mkdtemp(join(tmpdir(), 'vq-cost-recovery-review-')); directories.push(directory);
  let calls = 0, interrupted = false;
  const provider = async () => { calls++; return { text: '模型已返回。', usage: { source: 'provider' as const, inputTokens: 100, outputTokens: 20, totalTokens: 120 } }; };
  const first = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-for-cost-review', provider, failpoint(current, id) {
    if (!interrupted && id === 'brief' && current === point) { interrupted = true; throw new SimulatedProcessExit(); }
  } }); runtimes.push(first);
  const project = projectSchema.parse(await first.dispatch('project.create', { title: '费用恢复检查' }));
  const model = await first.dispatch('model.save', { model: { name: '用量夹具', provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', capabilities: ['text'], pricing: { currency: 'USD', inputPerMillionTokens: 2, outputPerMillionTokens: 8 } } }) as ModelProfile;
  await first.dispatch('workflow.save', { projectId: project.id, workflow: { id: 'cost-review', name: '费用恢复', version: 1, nodes: [workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '简报', modelId: model.id })], edges: [] } });
  const run = await first.dispatch('run.start', { projectId: project.id }) as RunRecord;
  await first.waitForIdle(); expect(interrupted).toBe(true);
  await first.close(); runtimes.splice(runtimes.indexOf(first), 1);
  const second = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-for-cost-review', provider }); runtimes.push(second);
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle();
  const records = await second.dispatch('cost.list', { runId: run.id }) as { items: UsageRecord[] };
  expect(records.items).toHaveLength(1); expect(calls).toBe(point === 'after-dispatch' ? 0 : 1);
  expect(records.items[0].actualAmount).toBeUndefined();
  if (point === 'after-dispatch') {
    expect(records.items[0]).toMatchObject({ status: 'unknown' });
    expect(records.items[0].estimatedAmount).toBeUndefined(); expect(records.items[0].providerUsage).toBeUndefined();
  } else {
    expect(records.items[0]).toMatchObject({ status: 'completed', estimateBasis: 'provider', providerUsage: { source: 'provider', inputTokens: 100, outputTokens: 20 } });
    expect(records.items[0].estimatedAmount).toBeCloseTo(.00036);
  }
  await second.dispatch('run.replay', { runId: run.id });
  expect((await second.dispatch('cost.list', { runId: run.id }) as { items: UsageRecord[] }).items).toEqual(records.items);
  expect(calls).toBe(point === 'after-dispatch' ? 0 : 1);
});
