import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { applyResearchClaims, projectSchema, researchResultSchema, runSchema, type ModelProfile, type ProjectDocument, type ResearchSource, type UsageRecord } from '@video-quickly/contracts';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../packages/runtime/src';

const directories: string[] = [], servers: Server[] = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();
afterEach(async () => { await Promise.all([...runtimes].map(runtime => runtime.close())); runtimes.clear(); await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }))); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function open(directory: string, options: Partial<RuntimeOptions> = {}) { const runtime = createRuntime({ dataDirectory: directory, seed: false, ffmpegPath: '/unused-by-research', ...options }); runtimes.add(runtime); return runtime; }
async function current(runtime: ReturnType<typeof createRuntime>, projectId: string) { return (await runtime.dispatch('project.get', { projectId }) as { project: ProjectDocument }).project; }
async function fixture(options: Partial<RuntimeOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'video-quickly-research-runtime-')); directories.push(directory);
  let received!: () => void;
  const requestReceived = new Promise<void>(resolve => { received = resolve; });
  const requests: Array<{ model: string; messages: Array<{ content: string }> }> = [], state = { sourceId: '', drop: false, hold: false, script: false };
  const server = createServer((request, response) => { void (async () => {
    let body = ''; for await (const chunk of request) body += chunk.toString(); requests.push(JSON.parse(body)); received();
    if (state.drop) { response.destroy(); return; } if (state.hold) return;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(state.script ? { shots: [{ title: '候选镜头', narration: '候选文案', visualPrompt: '候选画面' }] } : { claims: [{ text: '纸张由植物纤维构成', status: 'verified', evidence: [{ sourceId: state.sourceId, quote: '纸张由植物纤维构成。' }], shotIds: ['shot-1'] }] }) } }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }));
  })().catch(error => response.destroy(error instanceof Error ? error : undefined)); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务地址无效');
  const runtime = open(directory, options), original = projectSchema.parse(await runtime.dispatch('project.create', { title: '研究核验项目' }));
  const source = await runtime.dispatch('research.source.read', { text: '真实资料：纸张由植物纤维构成。\n其他原文供人工核验。', title: '真实原文' }) as ResearchSource; state.sourceId = source.id;
  const project = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: original.revision, patch: { researchSources: [source], shots: [1, 2].map(index => ({ id: `shot-${index}`, title: `镜头${index}`, narration: '原始旁白', visualPrompt: '', durationUs: 1_000_000 })) } }));
  const model = await runtime.dispatch('model.save', { model: { name: '研究HTTP夹具', provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'research-fixture', capabilities: ['text'], pricing: { currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 2 } } }) as ModelProfile;
  return { runtime, directory, project, source, model, requests, state, requestReceived };
}
async function analyze(runtime: ReturnType<typeof createRuntime>, project: ProjectDocument, model: ModelProfile, extra = {}) { return runSchema.parse(await runtime.dispatch('research.analyze', { projectId: project.id, revision: project.revision, modelId: model.id, ...extra })); }

it('keeps real model evidence pending until explicit human application, review and shot binding', async () => {
  const { runtime, project, source, model, requests } = await fixture();
  const run = await analyze(runtime, project, model); await runtime.waitForIdle();
  const result = researchResultSchema.parse(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'research' }));
  expect(requests).toHaveLength(1); expect(requests[0].messages[0].content).toContain(JSON.stringify(source.content)); expect(requests[0].messages[0].content.length).toBeLessThanOrEqual(120_000);
  expect(result.claims[0].status).toBe('pending'); expect(result.claims[0].evidence?.[0].quote).toBe('纸张由植物纤维构成。'); expect(await current(runtime, project.id)).toEqual(project);
  await expect(runtime.dispatch('node.apply', { runId: run.id, nodeId: 'research', revision: project.revision })).rejects.toThrow('比较证据候选');
  const draft = applyResearchClaims(project, result, result.claims, result.shotSuggestions);
  const applied = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { claims: draft.claims, shots: draft.shots } }));
  expect(applied.shots[0].claimIds).toEqual([result.claims[0].id]); expect(applied.shots[1].claimIds).toEqual([]);
  const reviewedAt = '2026-10-30T00:00:00.000Z';
  const verified = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: applied.revision, patch: { claims: applied.claims.map(claim => ({ ...claim, status: 'verified', reviewedAt, reviewNote: '已逐字检查原文' })) } }));
  await expect(runtime.dispatch('project.update', { projectId: project.id, revision: verified.revision, patch: { claims: verified.claims.map(claim => ({ ...claim, text: '偷偷改主张仍已核验' })) } })).rejects.toThrow('重新核验');
  await expect(runtime.dispatch('project.update', { projectId: project.id, revision: verified.revision, patch: { researchSources: [{ ...source, title: '更正来源名' }] } })).rejects.toThrow('重新核验');
  const changed = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: verified.revision, patch: { claims: verified.claims.map(claim => ({ ...claim, text: '已重新核对的修改', reviewedAt: '2026-10-30T01:00:00.000Z' })) } })); expect(changed.claims[0].status).toBe('verified');
  const pending = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: changed.revision, patch: { claims: changed.claims.map(claim => ({ ...claim, text: '修改后待核验', status: 'pending', reviewedAt: undefined })) } })); expect(pending.claims[0].reviewedAt).toBeUndefined();
  await expect(runtime.dispatch('project.saveShot', { projectId: project.id, revision: pending.revision, shot: { ...pending.shots[0], claimIds: ['not-in-project'] } })).rejects.toThrow('事实主张');
  await expect(runtime.dispatch('project.update', { projectId: project.id, revision: pending.revision, patch: { claims: [] } })).rejects.toThrow('事实主张');
  const costs = await runtime.dispatch('cost.list', { projectId: project.id }) as { items: UsageRecord[] }; expect(costs.items).toHaveLength(1); expect(costs.items[0]).toMatchObject({ status: 'completed', providerUsage: { source: 'provider', inputTokens: 20, outputTokens: 30 } });
});

it.each(['after-result', 'after-commit'] as const)('restores a fixed research response after %s without another model request', async point => {
  let crashed = false;
  const { runtime: first, directory, project, source, model, requests } = await fixture({ failpoint(current, id) { if (!crashed && id === 'research' && current === point) { crashed = true; throw new SimulatedProcessExit(); } } });
  const run = await analyze(first, project, model); await first.waitForIdle(); expect(crashed).toBe(true); expect(requests).toHaveLength(1);
  await first.close(); runtimes.delete(first); const second = open(directory);
  const replacement = await second.dispatch('research.source.read', { text: '之后导入的新资料，不应进入旧模型结果。' }) as ResearchSource;
  const edited = projectSchema.parse(await second.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { researchSources: [replacement], title: '之后的人工标题' } }));
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle(); expect(await second.dispatch('run.get', { runId: run.id })).toMatchObject({ status: 'succeeded' }); expect(requests).toHaveLength(1);
  const result = researchResultSchema.parse(await second.dispatch('node.result', { runId: run.id, nodeId: 'research' })); expect(result.sourceHashes).toEqual([{ sourceId: source.id, sha256: source.sha256 }]); expect(() => applyResearchClaims(edited, result, result.claims)).toThrow('资料'); expect(await current(second, project.id)).toEqual(edited);
});

it('never repeats an unknown research submission through restart and resume', async () => {
  const { runtime: first, directory, project, model, requests, state } = await fixture(); state.drop = true;
  const run = await analyze(first, project, model); await first.waitForIdle(); expect(requests).toHaveLength(1);
  await first.close(); runtimes.delete(first); const second = open(directory);
  await second.dispatch('run.resume', { runId: run.id }); await second.waitForIdle(); expect(requests).toHaveLength(1);
  expect(await second.dispatch('run.activities', { runId: run.id })).toMatchObject({ items: [{ status: 'unknown' }] });
  expect(await second.dispatch('node.result', { runId: run.id, nodeId: 'research' })).toBeNull();
});

it('preserves research scope on an explicit canceled-task remake instead of running the whole project', async () => {
  const { runtime, project, model, state, requests, requestReceived } = await fixture(); state.hold = true;
  const parent = await analyze(runtime, project, model, { sourceIds: [project.researchSources![0].id], instruction: '固定研究要求' }); await requestReceived; expect(requests).toHaveLength(1);
  await runtime.dispatch('run.cancel', { runId: parent.id }); await runtime.waitForIdle(); state.hold = false;
  const restarted = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, parentRunId: parent.id })); await runtime.waitForIdle(); expect(requests).toHaveLength(2); expect(requests[1].messages[0].content).toContain('固定研究要求'); expect(restarted.parentRunId).toBe(parent.id);
  const result = researchResultSchema.parse(await runtime.dispatch('node.result', { runId: restarted.id, nodeId: 'research' })); expect(result.claims).toHaveLength(1); expect(await current(runtime, project.id)).toEqual(project);
});

it('round-trips captured sources and references in backups, rejecting corrupted hashes and immutable source replacement', async () => {
  const { runtime, project, source, model } = await fixture();
  const run = await analyze(runtime, project, model); await runtime.waitForIdle(); const result = researchResultSchema.parse(await runtime.dispatch('node.result', { runId: run.id, nodeId: 'research' }));
  const draft = applyResearchClaims(project, result, result.claims, result.shotSuggestions), saved = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { claims: draft.claims, shots: draft.shots } }));
  await expect(runtime.dispatch('project.update', { projectId: project.id, revision: saved.revision, patch: { researchSources: [{ ...source, sha256: '0'.repeat(64) }] } })).rejects.toThrow('校验失败');
  const alternate = source.content + '替换正文'; await expect(runtime.dispatch('project.update', { projectId: project.id, revision: saved.revision, patch: { researchSources: [{ ...source, content: alternate, sha256: createHash('sha256').update(alternate).digest('hex') }], claims: [] , shots: saved.shots.map(shot => ({ ...shot, claimIds: [] })) } })).rejects.toThrow('不可直接替换');
  const backup = await runtime.dispatch('project.backup', { projectId: project.id }) as { path: string }, restored = projectSchema.parse(await runtime.dispatch('project.importBackup', { path: backup.path })); expect(restored.researchSources).toEqual(saved.researchSources); expect(restored.claims).toEqual(saved.claims); expect(restored.shots[0].claimIds).toEqual(saved.shots[0].claimIds); expect(restored.id).not.toBe(project.id);
  const path = join(backup.path, 'project.json'), manifest = JSON.parse(await readFile(path, 'utf8')) as { project: ProjectDocument }; manifest.project.researchSources![0].content += '破坏正文'; await writeFile(path, JSON.stringify(manifest)); await expect(runtime.dispatch('project.importBackup', { path: backup.path })).rejects.toThrow('校验失败');
});

it('keeps a local research summary read-only and retains claim bindings in ordinary generated scripts', async () => {
  const { runtime, project, source, model } = await fixture({ provider: async request => { expect(request.prompt).toContain('已核对主张'); expect(request.prompt).toContain('verified'); return JSON.stringify({ shots: [{ title: '模型新标题', narration: '新旁白', visualPrompt: '新画面', claimIds: ['model-invented'] }] }); } });
  const linked = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { claims: [{ id: 'manual-claim', text: '已核对主张', source: source.title, locator: '', status: 'verified' }], shots: project.shots.map((shot, index) => index ? shot : { ...shot, claimIds: ['manual-claim'] }) } }));
  const local = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'research' })); await runtime.waitForIdle(); expect(await runtime.dispatch('node.result', { runId: local.id, nodeId: 'research' })).toMatchObject({ kind: 'research-summary', readonly: true, claims: [{ status: 'verified' }] });
  const ready = projectSchema.parse(await runtime.dispatch('workflow.save', { projectId: project.id, revision: linked.revision, workflow: { ...linked.workflow, nodes: linked.workflow.nodes.map(node => node.kind === 'script' ? { ...node, modelId: model.id, requiresReview: false } : node) } }));
  const scripted = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId: 'script' })); await runtime.waitForIdle(); const output = await runtime.dispatch('node.result', { runId: scripted.id, nodeId: 'script' }) as { shots: ProjectDocument['shots'] }; expect(output.shots[0].claimIds).toEqual(['manual-claim']);
  const applied = projectSchema.parse(await runtime.dispatch('node.apply', { runId: scripted.id, nodeId: 'script', revision: ready.revision })); expect(applied.shots[0].claimIds).toEqual(['manual-claim']);
});

it('guards only the target candidate facts and source metadata while allowing unrelated research edits', async () => {
  const { runtime, project, source, model, state } = await fixture(); state.script = true;
  const quote = '纸张由植物纤维构成。', startOffset = source.content.indexOf(quote);
  const claim = { id: 'bound-claim', text: '待核验事实', source: source.title, locator: '', status: 'pending' as const, evidence: [{ sourceId: source.id, sourceSha256: source.sha256, startOffset, endOffset: startOffset + quote.length, quote }] };
  const linked = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: project.revision, patch: { claims: [claim], shots: project.shots.map((shot, index) => index ? shot : { ...shot, claimIds: [claim.id] }) } }));
  const candidate = async (value: ProjectDocument) => {
    await runtime.dispatch('shot.regenerate', { projectId: value.id, revision: value.revision, shotId: 'shot-1', kind: 'script', modelId: model.id }); await runtime.waitForIdle();
    const page = await runtime.dispatch('shot.candidates', { projectId: value.id, shotId: 'shot-1', limit: 1 }) as { items: Array<{ id: string }> }; return page.items[0];
  };
  const first = await candidate(linked), unrelated = await runtime.dispatch('research.source.read', { text: '无关材料的真实正文', title: '另一份资料' }) as ResearchSource;
  const changedUnrelated = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: linked.revision, patch: { researchSources: [source, unrelated], claims: [claim, { id: 'unrelated-claim', text: '其他主张', source: unrelated.title, locator: '', status: 'pending' }] } }));
  const applied = projectSchema.parse(await runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: changedUnrelated.revision, candidateId: first.id })); expect(applied.shots[0].title).toBe('候选镜头'); expect(applied.claims).toHaveLength(2); expect(applied.researchSources).toHaveLength(2);
  const second = await candidate(applied);
  const changedFact = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: applied.revision, patch: { claims: applied.claims.map(item => item.id === claim.id ? { ...item, text: '更改后的相关事实', status: 'disputed' } : item) } }));
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: changedFact.revision, candidateId: second.id })).rejects.toThrow('主张或核验结论已变化');
  const changedSource = projectSchema.parse(await runtime.dispatch('project.update', { projectId: project.id, revision: changedFact.revision, patch: { claims: applied.claims, researchSources: [{ ...source, title: '相关来源名称已更正' }, unrelated] } }));
  await expect(runtime.dispatch('shot.candidate.apply', { projectId: project.id, revision: changedSource.revision, candidateId: second.id })).rejects.toThrow('证据来源已变化');
});
