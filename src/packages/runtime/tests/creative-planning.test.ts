import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  characterProfileSchema, chargeConfirmationSchema, creativeObjectivePlanSchema, creativePlanningResultSchema, creativeStyleCardSchema, modelSchema, projectSchema, recordPageSchema, runSchema, workspaceSummarySchema,
} from '@video-quickly/contracts';
import { importSkillFixture } from '../../../../tests/fixtures/import-skill';
import { createRuntime, SimulatedProcessExit, type RuntimeOptions } from '../src/index.js';

const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const goal = '雨夜，追踪线索的女孩穿过车站，交出最后一封信。';
const skillInstruction = '跨镜头保留主色光源的方向，并用一次明确的动作收尾。';
const style = {
  fields: { artStyle: '低饱和电影风', palette: '深蓝与琥珀', composition: '用走廊透视引导视线', lighting: '左侧冷光与暖色背光',
    characterAppearance: '深色雨衣与短发', sceneContinuity: '同一车站的湿地面与站牌' },
  swatches: [{ hex: '#16283F', label: '深蓝' }, { hex: '#CC8342', label: '琥珀' }, { hex: '#C6D6DD', label: '反光灰' }],
};
const storyboard = { shots: [
  { title: '入口', narration: '', visualPrompt: '深蓝雨幕中出现车站入口。', soundPrompt: '密雨' },
  { title: '找线索', narration: '信还在。', visualPrompt: '沿琥珀灯带寻找蓝色信封。', soundPrompt: '脚步' },
  { title: '交信', narration: '', visualPrompt: '在琥珀暖光中交出蓝色信封。', soundPrompt: '纸声' },
] };
const secondSegment = { title: '翻开站牌', narration: '原来在这里。', visualPrompt: '沿琥珀灯带翻开旧站牌，露出蓝色信封。', soundPrompt: '金属轻响' };
const stages = ['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出'];
const scopedRevision = 'creative_storyboard_scoped_revision';

type ModelBody = { model?: string; input?: { role: string; content: unknown }[]; text?: { format?: { name?: string; schema?: unknown } }; tools?: unknown };
type Call = { path: string; body: ModelBody };
type Runtime = ReturnType<typeof createRuntime>;
const runtimes = new Set<Runtime>();
const directories: string[] = [], servers: Server[] = [];

afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close()));
  runtimes.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function open(options: RuntimeOptions) {
  const runtime = createRuntime(options);
  runtimes.add(runtime);
  return runtime;
}

function outputFor(name: string | undefined) {
  if (name === 'creative_style_card') return style;
  if (name === 'creative_storyboard') return storyboard;
  if (name === 'creative_storyboard_revision') return secondSegment;
  return undefined;
}

async function fixture(extra: Partial<RuntimeOptions> = {}, respond: (name: string | undefined) => unknown = outputFor) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-creative-planning-'));
  directories.push(directory);
  const calls: Call[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelBody;
    calls.push({ path: request.url ?? '', body });
    const output = respond(body.text?.format?.name);
    response.setHeader('content-type', 'application/json');
    if (!output) { response.statusCode = 400; response.end(JSON.stringify({ error: { message: 'Unexpected fixture request' } })); return; }
    response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const options: RuntimeOptions = { dataDirectory: directory, seed: false, ...extra };
  const runtime = open(options);
  const modelInput = {
    provider: 'openai-compatible', connectionType: 'text', textProtocol: 'responses',
    baseUrl: `http://127.0.0.1:${address.port}/v1`, capabilities: ['text', 'structured-output'],
  };
  const vision = modelSchema.parse(await runtime.dispatch('model.save', { model: { ...modelInput, name: '参考图夹具', model: 'fixture-vision', capabilities: [...modelInput.capabilities, 'vision'] } }));
  const textOnly = modelSchema.parse(await runtime.dispatch('model.save', { model: { ...modelInput, name: '文本夹具', model: 'fixture-text' } }));
  const skillDirectory = join(directory, 'scene-continuity');
  await mkdir(skillDirectory);
  await writeFile(join(skillDirectory, 'SKILL.md'), `---\nname: scene-continuity\ndescription: 风格连续性夹具\n---\n${skillInstruction}`);
  const { skills } = await importSkillFixture(runtime.dispatch, { path: skillDirectory });
  const path = join(directory, 'reference.png');
  await writeFile(path, Buffer.from(image, 'base64'));
  const request = { requestId: randomUUID(), title: '雨夜短片', goal, modelId: vision.id, skillIds: [skills[0].id], reference: { path } };
  return { options, runtime, calls, request, textOnly, directory };
}

async function result(runtime: Runtime, runId: string) {
  return creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.get', { runId }));
}

function outputNames(calls: Call[]) { return calls.map(call => call.body.text?.format?.name); }

async function savedProject(runtime: Runtime, projectId: string) {
  const { project } = await runtime.dispatch('project.get', { projectId }) as { project: unknown };
  return projectSchema.parse(project);
}

it('sends the selected image and Skill, applies editable shots, revises only segment two, and reuses the saved style in another work', async () => {
  const { runtime, calls, request, textOnly } = await fixture();
  const [first, duplicate] = (await Promise.all([runtime.dispatch('creativePlanning.start', request), runtime.dispatch('creativePlanning.start', request)]))
    .map(value => creativePlanningResultSchema.parse(value));
  expect(duplicate.id).toBe(first.id);
  await expect(runtime.dispatch('creativePlanning.start', { ...request, goal: '其他目标' })).rejects.toThrow('请求');
  await runtime.waitForIdle();
  const draft = await result(runtime, first.id);
  expect(draft.status, draft.error).toBe('succeeded');
  assert(draft.reference && draft.styleCard && draft.shots);
  expect(draft.styleCard).toMatchObject({ version: 1, reference: { assetId: draft.reference.id, version: draft.reference.version }, ...style });
  await expect(runtime.dispatch('asset.delete', { assetId: draft.reference.id })).rejects.toThrow('正在使用');
  expect(draft.shots.map(shot => shot.durationUs)).toEqual([5_000_000, 5_000_000, 5_000_000]);
  expect(draft.shots.map(shot => shot.title)).toEqual(storyboard.shots.map(shot => shot.title));
  expect(outputNames(calls)).toEqual(['creative_style_card', 'creative_storyboard']);
  expect(calls.every(call => call.path === '/v1/responses' && !call.body.tools)).toBe(true);
  expect(calls[0].body.input).toEqual([{ role: 'user', content: [
    { type: 'input_text', text: expect.stringContaining(skillInstruction) },
    { type: 'input_image', image_url: `data:image/png;base64,${image}`, detail: 'auto' },
  ] }]);
  expect(JSON.stringify(calls[0].body.input)).toContain(goal);
  const storyboardPrompt = calls[1].body.input?.[0]?.content;
  expect(storyboardPrompt).toEqual(expect.stringContaining(skillInstruction));
  expect(storyboardPrompt).toEqual(expect.stringContaining(style.swatches[1].hex));

  const applied = projectSchema.parse(await runtime.dispatch('creativePlanning.apply', { runId: first.id }));
  expect(applied.workflow.stages?.map(stage => stage.label)).toEqual(stages);
  expect(applied.workflow.production.manualPlanningSteps).toEqual(['brief', 'style', 'script']);
  expect(applied.style).toContain(style.swatches[1].hex);
  expect(applied.shots).toEqual(draft.shots);
  const authored = projectSchema.parse(await runtime.dispatch('project.update', { projectId: applied.id, revision: applied.revision,
    patch: { shots: [{ ...applied.shots[0], narration: '我沿着站台灯走。' }, ...applied.shots.slice(1)] } }));
  expect(authored.shots[0].narration).toBe('我沿着站台灯走。');
  expect(await runtime.dispatch('creativePlanning.apply', { runId: first.id })).toMatchObject({ shots: authored.shots, revision: authored.revision });

  const instruction = '保持配色，只改第二段，让女孩翻开旧站牌。';
  const revised = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.revise', { requestId: randomUUID(), runId: first.id, instruction }));
  await runtime.waitForIdle();
  const revision = await result(runtime, revised.id);
  expect(revision.status, revision.error).toBe('succeeded');
  assert(revision.shots);
  expect(revision.parentRunId).toBe(first.id);
  expect(revision.styleCard).toEqual(draft.styleCard);
  expect(revision.shots).toEqual([authored.shots[0], { ...authored.shots[1], ...secondSegment }, authored.shots[2]]);
  expect(outputNames(calls)).toEqual(['creative_style_card', 'creative_storyboard', 'creative_storyboard_revision']);
  const revisionPrompt = calls[2].body.input?.[0]?.content;
  expect(revisionPrompt).toEqual(expect.stringContaining(instruction));
  expect(revisionPrompt).toEqual(expect.stringContaining(style.swatches[1].hex));
  const savedRevision = projectSchema.parse(await runtime.dispatch('creativePlanning.apply', { runId: revised.id }));
  expect(savedRevision.shots).toEqual(revision.shots);
  expect(savedRevision.style).toBe(authored.style);
  expect(savedRevision.workflow).toEqual(authored.workflow);

  const reused = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.start', {
    ...request, requestId: randomUUID(), title: '雨夜续集', modelId: textOnly.id, reference: { styleCardId: draft.styleCard.id },
  }));
  await runtime.waitForIdle();
  expect(await result(runtime, reused.id)).toMatchObject({ status: 'succeeded', styleCard: draft.styleCard });
  expect(reused.projectId).not.toBe(first.projectId);
  expect(outputNames(calls.slice(3))).toEqual(['creative_storyboard']);
  expect(calls[3].body.model).toBe('fixture-text');
  expect(recordPageSchema(creativeStyleCardSchema).parse(await runtime.dispatch('creativePlanning.styleCards', {})).items).toEqual([draft.styleCard]);
  expect(workspaceSummarySchema.parse(await runtime.dispatch('workspace.summary', {})).projects).toHaveLength(2);
});

it('resumes after the style card committed, reusing it without resending the reference image', async () => {
  let crashed = false;
  const { runtime, calls, request, options } = await fixture({ failpoint(point, nodeId) {
    if (!crashed && point === 'after-commit' && nodeId === 'style') { crashed = true; throw new SimulatedProcessExit(); }
  } });
  const draft = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.start', request));
  await runtime.waitForIdle();
  expect(crashed).toBe(true);
  expect(outputNames(calls)).toEqual(['creative_style_card']);
  const before = await result(runtime, draft.id);
  expect(before.styleCard).toMatchObject(style);
  expect(before.shots).toBeUndefined();
  await runtime.close();
  runtimes.delete(runtime);
  const reopened = open({ ...options, failpoint: undefined });
  const receipt = creativePlanningResultSchema.parse(await reopened.dispatch('creativePlanning.start', request));
  expect(receipt.id).toBe(draft.id);
  await reopened.dispatch('run.resume', { runId: draft.id });
  await reopened.waitForIdle();
  const recovered = await result(reopened, draft.id);
  expect(recovered.status, recovered.error).toBe('succeeded');
  expect(recovered.styleCard).toEqual(before.styleCard);
  expect(recovered.shots).toHaveLength(3);
  expect(outputNames(calls)).toEqual(['creative_style_card', 'creative_storyboard']);
  expect(await reopened.dispatch('run.replay', { runId: draft.id })).toMatchObject({ matchesSnapshot: true, externalCalls: 0 });
});

it('recovers a standalone style extraction from its snapshot and leaves the work library empty', async () => {
  let crashed = false;
  const { runtime, calls, request, options } = await fixture({ failpoint(point, nodeId) {
    if (!crashed && point === 'after-commit' && nodeId === 'style') { crashed = true; throw new SimulatedProcessExit(); }
  } }, name => name === 'creative_objective' ? { route: 'style-only', reason: '只需风格卡', totalSeconds: null, shotCount: null,
    shotSeconds: null, keyframeShots: null } : outputFor(name));
  const plan = creativeObjectivePlanSchema.parse(await runtime.dispatch('creativePlanning.plan', { requestId: randomUUID(), goal: request.goal, modelId: request.modelId }));
  const draft = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.start', { ...request, plan: { id: plan.id, optionId: plan.options[0].id } }));
  await runtime.waitForIdle();
  expect(crashed).toBe(true);
  await runtime.close();
  runtimes.delete(runtime);

  const reopened = open({ ...options, failpoint: undefined });
  expect(await reopened.dispatch('run.inspect', { runId: draft.id })).toMatchObject({ recovery: { resume: true } });
  await reopened.dispatch('run.resume', { runId: draft.id });
  await reopened.waitForIdle();
  expect(await result(reopened, draft.id)).toMatchObject({ status: 'succeeded', route: 'style-only', styleCard: { ...style, id: draft.id } });
  expect(outputNames(calls)).toEqual(['creative_objective', 'creative_style_card']);
  expect(await reopened.dispatch('dramaWork.list', {})).toMatchObject({ items: [] });
  expect(workspaceSummarySchema.parse(await reopened.dispatch('workspace.summary', {})).projects).toEqual([]);
  expect(await reopened.dispatch('run.replay', { runId: draft.id })).toMatchObject({ matchesSnapshot: true, externalCalls: 0 });
});

it('resumes a confirmed preview, preserves dialogue-only frame bindings, and replaces only the redone shot', async () => {
  let crashed = false, imageSubmissions = 0, imageResumes = 0;
  const imageScopes: string[][] = [];
  const bytes = Buffer.from(image, 'base64');
  const timestamp = new Date().toISOString();
  const { runtime, calls, request, options } = await fixture({
    failpoint(point, nodeId) {
      if (!crashed && point === 'after-result' && nodeId === 'assets') { crashed = true; throw new SimulatedProcessExit(); }
    },
    async executeActivity(context) {
      expect(context.node).toMatchObject({ id: 'assets', kind: 'assets', config: { operation: 'prepare-references', referenceMode: 'generate' } });
      expect(context.project.style).toContain(style.swatches[1].hex);
      const receipt = `image-receipt:${context.operationId}`;
      if (context.remoteTaskId) {
        expect(context.remoteTaskId).toBe(receipt);
        imageResumes++;
      } else {
        context.persistRemoteTask(receipt);
        imageSubmissions++;
        imageScopes.push(context.project.shots.map(shot => shot.id));
      }
      const assets = await Promise.all(context.project.shots.map(async shot => {
        const id = `keyframe-${createHash('sha256').update(`${context.runId}:${shot.id}`).digest('hex').slice(0, 24)}`;
        const path = join(context.dataDirectory, `${id}.png`);
        if (!context.remoteTaskId) await writeFile(path, bytes);
        return { id, name: `${shot.title}.png`, kind: 'image', path, mimeType: 'image/png', size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: timestamp, active: true,
          provenance: 'fixture', retained: false, projectId: context.project.id, shotId: shot.id };
      }));
      return { assets };
    },
  }, name => name === 'creative_objective' ? { route: 'keyframe-preview', reason: '预演入口和交信', totalSeconds: 12, shotCount: 3,
    shotSeconds: [2, 4, 6], keyframeShots: [1, 3] } : name === 'creative_storyboard_planned' ? storyboard : outputFor(name));
  const imageModel = modelSchema.parse(await runtime.dispatch('model.save', { model: { provider: 'openai-compatible', connectionType: 'image',
    baseUrl: 'http://127.0.0.1:1234/v1', name: '关键镜头夹具', model: 'fixture-image', capabilities: ['image'] } }));
  const plan = creativeObjectivePlanSchema.parse(await runtime.dispatch('creativePlanning.plan', { requestId: randomUUID(), goal: request.goal, modelId: request.modelId }));
  expect(plan.route).toBe('keyframe-preview');
  expect(plan.options).toHaveLength(1);
  const started = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.start', {
    ...request, plan: { id: plan.id, optionId: plan.options[0].id },
  }));
  await runtime.waitForIdle();
  const draft = await result(runtime, started.id);
  expect(draft.status, draft.error).toBe('succeeded');
  assert(draft.shots && draft.preview);
  const [firstId, middleId, thirdId] = draft.shots.map(shot => shot.id);
  expect(draft.shots.map(shot => shot.durationUs)).toEqual([2_000_000, 4_000_000, 6_000_000]);
  expect(imageSubmissions).toBe(0);
  const selection = { requestId: randomUUID(), runId: draft.id, revision: draft.preview.revision, imageModelId: imageModel.id, shotIds: [middleId, thirdId] };
  const generated = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.previewStart', selection));
  await runtime.waitForIdle();
  expect(crashed).toBe(true);
  expect(imageSubmissions).toBe(1);
  expect((await result(runtime, generated.id)).keyframes).toBeUndefined();
  await runtime.close();
  runtimes.delete(runtime);

  const reopened = open({ ...options, failpoint: undefined });
  await reopened.dispatch('run.resume', { runId: generated.id });
  await reopened.waitForIdle();
  const recovered = await result(reopened, generated.id);
  expect(recovered.status, recovered.error).toBe('succeeded');
  assert(recovered.keyframes);
  expect(recovered.keyframes.map(asset => asset.shotId)).toEqual([middleId, thirdId]);
  expect(await reopened.dispatch('creativePlanning.previewStart', selection)).toMatchObject({ id: generated.id });
  expect(imageSubmissions).toBe(1);
  expect(imageResumes).toBe(1);
  expect(outputNames(calls)).toEqual(['creative_objective', 'creative_style_card', 'creative_storyboard_planned']);
  expect((await savedProject(reopened, draft.projectId)).shots).toEqual([]);
  const firstImage = recovered.keyframes[0].id, thirdImage = recovered.keyframes[1].id;
  await reopened.dispatch('creativePlanning.previewApply', { runId: generated.id, shotId: middleId });
  const applied = projectSchema.parse(await reopened.dispatch('creativePlanning.apply', { runId: draft.id }));
  expect(applied.shots.map(shot => shot.assetId)).toEqual([undefined, firstImage, undefined]);
  expect(applied.workflow.stages?.map(stage => stage.label)).toEqual(stages);

  const narration = '把信交给我。';
  const editedLine = projectSchema.parse(await reopened.dispatch('project.update', { projectId: applied.id, revision: applied.revision,
    patch: { shots: applied.shots.map(shot => shot.id === thirdId ? { ...shot, narration } : shot) } }));
  const unchanged = (await result(reopened, draft.id)).preview;
  expect(unchanged?.frames.find(frame => frame.shotId === middleId)).toMatchObject({ current: { id: firstImage }, stale: false });
  expect(unchanged?.frames.find(frame => frame.shotId === thirdId)).toMatchObject({ candidate: { asset: { id: thirdImage }, stale: false } });
  await reopened.dispatch('creativePlanning.previewApply', { runId: generated.id, shotId: thirdId });
  const afterLine = await savedProject(reopened, draft.projectId);
  expect(afterLine.shots[2]).toMatchObject({ narration, assetId: thirdImage });
  expect(afterLine.revision).toBeGreaterThan(editedLine.revision);

  await reopened.dispatch('project.update', { projectId: afterLine.id, revision: afterLine.revision,
    patch: { shots: afterLine.shots.map(shot => shot.id === middleId ? { ...shot, visualPrompt: '镜头改为蓝色信封特写。' } : shot) } });
  const changed = (await result(reopened, draft.id)).preview;
  assert(changed);
  expect(changed.frames.find(frame => frame.shotId === middleId)).toMatchObject({ current: { id: firstImage }, stale: true });
  expect(changed.frames.find(frame => frame.shotId === thirdId)).toMatchObject({ current: { id: thirdImage }, stale: false });
  await expect(reopened.dispatch('creativePlanning.previewStart', { ...selection, requestId: randomUUID(), shotIds: [firstId] })).rejects.toThrow(/分镜.*变更|重新/);
  const redo = creativePlanningResultSchema.parse(await reopened.dispatch('creativePlanning.previewStart', {
    ...selection, requestId: randomUUID(), revision: changed.revision, shotIds: [middleId], instruction: '保留构图，减少背景人物。',
  }));
  await reopened.waitForIdle();
  const ready = (await result(reopened, draft.id)).preview;
  const comparison = ready?.frames.find(frame => frame.shotId === middleId);
  expect(comparison).toMatchObject({ current: { id: firstImage }, candidate: { runId: redo.id, stale: false } });
  assert(comparison?.candidate);
  expect(comparison.candidate.asset.id).not.toBe(firstImage);
  await reopened.dispatch('creativePlanning.previewApply', { runId: redo.id, shotId: middleId });
  const final = await savedProject(reopened, draft.projectId);
  expect(final.shots.map(shot => shot.assetId)).toEqual([undefined, comparison.candidate.asset.id, thirdImage]);
  expect(imageScopes).toEqual([[middleId, thirdId], [middleId]]);
});

it('previews a single sentence change in the first draft shot and confirms only that change', async () => {
  const originalNarration = '先藏好信。灯突然亮了。别回头。';
  const lineText = '站牌亮了一瞬。';
  const { runtime, calls, request, options } = await fixture({}, name => {
    if (name === 'creative_storyboard') return { shots: [{ ...storyboard.shots[0], narration: originalNarration }, ...storyboard.shots.slice(1)] };
    if (name === scopedRevision) return { lineText };
    return outputFor(name);
  });
  const { id: draftId } = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.start', request));
  await runtime.waitForIdle();
  const draft = await result(runtime, draftId);
  assert(draft.shots && draft.styleCard);
  const initialProject = await savedProject(runtime, draft.projectId);
  const scope = { shotId: draft.shots[0].id, fields: ['lineText'], sentenceIndex: 1 };
  const input = { requestId: randomUUID(), runId: draftId, scope, instruction: '只缩短选中的一句话。' };
  const { id: revisionId } = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.revise', input));
  await runtime.waitForIdle();
  const preview = await result(runtime, revisionId);
  expect(preview.status, preview.error).toBe('succeeded');
  expect(preview.target).toMatchObject({ ...scope, shotTitle: draft.shots[0].title });
  expect(preview.changes).toEqual([{ field: 'lineText', before: '灯突然亮了。', after: lineText }]);
  const shots = [{ ...draft.shots[0], narration: `先藏好信。${lineText}别回头。` }, ...draft.shots.slice(1)];
  expect(preview.shots).toEqual(shots);
  expect(preview.styleCard).toEqual(draft.styleCard);
  expect(await savedProject(runtime, draft.projectId)).toEqual(initialProject);
  expect(outputNames(calls)).toEqual(['creative_style_card', 'creative_storyboard', scopedRevision]);
  expect(calls[2].body.input?.[0]?.content).toEqual(expect.stringContaining(style.swatches[1].hex));
  expect(calls[2].body.tools).toBeUndefined();
  expect(calls[2].body.text?.format?.schema).toMatchObject({ additionalProperties: false, required: ['lineText'] });

  // Reopening a finished request returns the saved proposal and leaves application explicit.
  await runtime.close();
  runtimes.delete(runtime);
  const reopened = open(options);
  const recovered = creativePlanningResultSchema.parse(await reopened.dispatch('creativePlanning.revise', input));
  expect(recovered.id).toBe(revisionId);
  expect(recovered.changes).toEqual(preview.changes);
  expect(calls).toHaveLength(3);
  const applied = projectSchema.parse(await reopened.dispatch('creativePlanning.apply', { runId: revisionId }));
  expect(applied.shots).toEqual(shots);
  expect(applied.style).toContain(style.swatches[1].hex);
  expect(applied.workflow.stages?.map(stage => stage.label)).toEqual(stages);
  expect(await reopened.dispatch('creativePlanning.apply', { runId: revisionId })).toMatchObject({ revision: applied.revision, shots });

  const newer = projectSchema.parse(await reopened.dispatch('project.update', { projectId: applied.id, revision: applied.revision, patch: {
    shots: [{ ...applied.shots[0], narration: `她跑近站台。${applied.shots[0].narration}` }, ...applied.shots.slice(1)],
  } }));
  await expect(reopened.dispatch('creativePlanning.revise', { ...input, requestId: randomUUID(), runId: revisionId })).rejects.toThrow('旁白已变更');
  expect(await savedProject(reopened, applied.id)).toEqual(newer);
  expect(calls).toHaveLength(3);
});

it('rejects a model patch outside the requested line and keeps a normal project safe across retry and stale apply', async () => {
  const lineText = '人快到了。';
  let revisionCalls = 0;
  const { runtime, calls, textOnly } = await fixture({}, name => {
    if (name === scopedRevision) return ++revisionCalls === 1 ? { lineText, visualPrompt: '越界修改画面' } : { lineText };
    return outputFor(name);
  });
  const character = characterProfileSchema.parse(await runtime.dispatch('character.save', { character: { name: '小林', description: '深色雨衣与短发', referenceAssetIds: [] } }));
  const created = projectSchema.parse(await runtime.dispatch('project.create', { title: '追信', originalText: goal }));
  const dialogue = { id: 'watchman', kind: 'dialogue', speakerId: character.id, text: '我在等信。', emotion: '压低声音', pauseAfterUs: 300_000 };
  const original = projectSchema.parse(await runtime.dispatch('project.update', { projectId: created.id, revision: created.revision, patch: {
    style: '低饱和深蓝 #16283F 与琥珀 #CC8342。',
    shots: [
      { ...storyboard.shots[0], id: 'entrance', durationUs: 6_000_000, locked: true },
      { ...storyboard.shots[1], id: 'platform', durationUs: 4_500_000 },
      { ...storyboard.shots[2], id: 'envelope', durationUs: 7_500_000, drama: { lines: [
        { id: 'announcement', kind: 'narration', text: '站台广播突然响起。' }, dialogue,
      ] } },
      { ...storyboard.shots[0], id: 'departure', title: '背影', durationUs: 3_000_000 },
    ],
  } }));
  const input = { projectId: original.id, revision: original.revision, modelId: textOnly.id, instruction: '让选中的台词更加简洁。',
    scope: { shotId: 'envelope', fields: ['lineText'], lineId: dialogue.id } };
  await expect(runtime.dispatch('creativePlanning.revise', { ...input, requestId: randomUUID(), scope: { shotId: 'entrance', fields: ['title'] } })).rejects.toThrow(/锁定|解锁/);
  expect(calls).toHaveLength(0);
  const { id } = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.revise', { ...input, requestId: randomUUID() }));
  await runtime.waitForIdle();
  const rejected = await result(runtime, id);
  expect(['failed', 'needs_attention']).toContain(rejected.status);
  expect(rejected.failedNodeId).toBe('script');
  expect(rejected.changes).toBeUndefined();
  await expect(runtime.dispatch('creativePlanning.apply', { runId: id })).rejects.toThrow();
  expect(await savedProject(runtime, original.id)).toEqual(original);

  await runtime.dispatch('run.step.retry', { runId: id, nodeId: rejected.failedNodeId });
  await runtime.waitForIdle();
  const retried = await result(runtime, id);
  expect(retried.status, retried.error).toBe('succeeded');
  expect(retried.changes).toEqual([{ field: 'lineText', before: dialogue.text, after: lineText }]);
  expect(outputNames(calls)).toEqual([scopedRevision, scopedRevision]);
  assert(original.shots[2].drama);
  const shots = [original.shots[0], original.shots[1], { ...original.shots[2], drama: {
    ...original.shots[2].drama, lines: [original.shots[2].drama.lines[0], { ...dialogue, text: lineText }],
  } }, original.shots[3]];
  expect(retried.shots).toEqual(shots);
  expect(await savedProject(runtime, original.id)).toEqual(original);
  const applied = projectSchema.parse(await runtime.dispatch('creativePlanning.apply', { runId: id }));
  expect(applied).toEqual({ ...original, revision: applied.revision, updatedAt: applied.updatedAt, shots });

  const { id: staleId } = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.revise', {
    ...input, revision: applied.revision, requestId: randomUUID(), scope: { shotId: 'envelope', fields: ['lineText'], lineId: 'announcement' },
  }));
  await runtime.waitForIdle();
  expect((await result(runtime, staleId)).status).toBe('succeeded');
  const newer = projectSchema.parse(await runtime.dispatch('project.update', { projectId: original.id, revision: applied.revision, patch: { title: '人工改名' } }));
  await expect(runtime.dispatch('creativePlanning.apply', { runId: staleId })).rejects.toThrow(/项目已变更|修订/);
  expect(await savedProject(runtime, original.id)).toEqual(newer);
});

it('blocks invalid inputs before billing, then retries an invalid storyboard with the already saved style card', async () => {
  let storyboardCalls = 0;
  const { runtime, calls, request, textOnly, directory } = await fixture({}, name => {
    if (name === 'creative_storyboard' && ++storyboardCalls === 1) return { shots: storyboard.shots.slice(1) };
    return outputFor(name);
  });
  const fakeImage = join(directory, 'wrong-image.png');
  await writeFile(fakeImage, '没有真实的图片字节');
  await expect(runtime.dispatch('creativePlanning.start', { ...request, modelId: textOnly.id })).rejects.toThrow('视觉');
  await expect(runtime.dispatch('creativePlanning.start', { ...request, reference: { path: fakeImage } })).rejects.toThrow('参考图');
  expect(calls).toEqual([]);
  expect(workspaceSummarySchema.parse(await runtime.dispatch('workspace.summary', {})).projects).toHaveLength(0);

  const created = creativePlanningResultSchema.parse(await runtime.dispatch('creativePlanning.start', request));
  await runtime.waitForIdle();
  const failed = await result(runtime, created.id);
  expect(['failed', 'needs_attention']).toContain(failed.status);
  expect(failed.failedNodeId).toBe('script');
  expect(failed.styleCard).toMatchObject(style);
  expect(failed.shots).toBeUndefined();
  await runtime.dispatch('run.step.retry', { runId: created.id, nodeId: 'script' });
  await runtime.waitForIdle();
  const retried = runSchema.parse(await runtime.dispatch('run.get', { runId: created.id }));
  if (retried.status !== 'succeeded') {
    expect(retried.stepRetry?.status).toBe('completed');
    await runtime.dispatch('run.resume', { runId: created.id });
    await runtime.waitForIdle();
  }
  const completed = await result(runtime, created.id);
  expect(completed.status, completed.error).toBe('succeeded');
  expect(completed.styleCard).toEqual(failed.styleCard);
  expect(completed.shots).toHaveLength(3);
  expect(outputNames(calls)).toEqual(['creative_style_card', 'creative_storyboard', 'creative_storyboard']);
});

it('confirms analysis and execution separately, saves a reusable style card, and refuses an unselected timing compromise', async () => {
  const styleGoal = '只从参考图提取雨夜风格卡。';
  const conflictGoal = '沿用风格出分镜。总时长 15 秒，分成三个镜头，时长分别为 5/8/5 秒。';
  let analysisCount = 0;
  const { runtime, calls, request, options, textOnly } = await fixture({ requireChargeConfirmation: true }, name => {
    if (name !== 'creative_objective') return name === 'creative_storyboard_planned' ? storyboard : outputFor(name);
    return ++analysisCount === 1
      ? { route: 'style-only', reason: '单独保存视觉风格。', totalSeconds: null, shotCount: null, shotSeconds: null, keyframeShots: null }
      : { route: 'storyboard', reason: '使用已保存风格交付分镜。', totalSeconds: 15, shotCount: 3, shotSeconds: [5, 8, 5], keyframeShots: null };
  });
  async function authorize(instance: Runtime, method: string, params: object) {
    const challenge = chargeConfirmationSchema.parse(await instance.dispatch('billing.prepare', { method, params }));
    return { ...params, chargeConfirmationId: challenge.confirmationId };
  }
  const analyzeStyle = { requestId: randomUUID(), goal: styleGoal, modelId: request.modelId };
  await expect(runtime.dispatch('creativePlanning.plan', analyzeStyle)).rejects.toThrow(/费用影响/);
  expect(calls).toHaveLength(0);
  const stylePlan = creativeObjectivePlanSchema.parse(await runtime.dispatch('creativePlanning.plan', await authorize(runtime, 'creativePlanning.plan', analyzeStyle)));
  expect(stylePlan).toMatchObject({ route: 'style-only', options: [{ id: 'original', shotDurationsUs: [], keyframeShots: [] }] });
  expect(workspaceSummarySchema.parse(await runtime.dispatch('workspace.summary', {})).projects).toEqual([]);
  await runtime.close();
  runtimes.delete(runtime);

  const reopened = open(options);
  expect(await reopened.dispatch('creativePlanning.plan', analyzeStyle)).toEqual(stylePlan);
  await expect(reopened.dispatch('creativePlanning.plan', { ...analyzeStyle, goal: conflictGoal })).rejects.toThrow('此分析请求已用于其他目标');
  expect(await reopened.dispatch('cost.tasks')).toMatchObject({ items: [{ id: stylePlan.id, title: '创作目标分析', runAvailable: false }] });
  expect(outputNames(calls)).toEqual(['creative_objective']);
  const styleStart = { ...request, goal: styleGoal, plan: { id: stylePlan.id, optionId: 'original' } };
  const startedStyle = creativePlanningResultSchema.parse(await reopened.dispatch('creativePlanning.start', await authorize(reopened, 'creativePlanning.start', styleStart)));
  await reopened.waitForIdle();
  const styleResult = await result(reopened, startedStyle.id);
  expect(styleResult).toMatchObject({ route: 'style-only', status: 'succeeded', styleCard: style });
  expect(styleResult.shots).toBeUndefined();
  expect(outputNames(calls)).toEqual(['creative_objective', 'creative_style_card']);
  assert(styleResult.styleCard);

  const analyzeStoryboard = { requestId: randomUUID(), goal: conflictGoal, modelId: textOnly.id };
  const plan = creativeObjectivePlanSchema.parse(await reopened.dispatch('creativePlanning.plan', await authorize(reopened, 'creativePlanning.plan', analyzeStoryboard)));
  expect(plan.issues).toHaveLength(1);
  expect(plan.options.map(option => [option.id, option.shotDurationsUs])).toEqual([
    ['keep-shots', [5_000_000, 8_000_000, 5_000_000]], ['keep-total', [5_000_000, 5_000_000, 5_000_000]],
  ]);
  const storyboardStart = { ...request, requestId: randomUUID(), goal: conflictGoal, modelId: textOnly.id, reference: { styleCardId: styleResult.styleCard.id }, plan: { id: plan.id, optionId: 'keep-shots' } };
  await expect(reopened.dispatch('billing.prepare', { method: 'creativePlanning.start', params: { ...storyboardStart, plan: { id: plan.id, optionId: 'unknown' } } })).rejects.toThrow('请选择并确认');
  await expect(reopened.dispatch('billing.prepare', { method: 'creativePlanning.start', params: { ...storyboardStart, goal: styleGoal } })).rejects.toThrow('重新分析');
  await expect(reopened.dispatch('creativePlanning.start', storyboardStart)).rejects.toThrow(/费用影响/);
  expect(outputNames(calls)).toEqual(['creative_objective', 'creative_style_card', 'creative_objective']);
  const started = creativePlanningResultSchema.parse(await reopened.dispatch('creativePlanning.start', await authorize(reopened, 'creativePlanning.start', storyboardStart)));
  await reopened.waitForIdle();
  const draft = await result(reopened, started.id);
  expect(draft).toMatchObject({ route: 'storyboard', status: 'succeeded', styleCard: styleResult.styleCard });
  expect(draft.shots?.map(shot => shot.durationUs)).toEqual([5_000_000, 8_000_000, 5_000_000]);
  expect(outputNames(calls)).toEqual(['creative_objective', 'creative_style_card', 'creative_objective', 'creative_storyboard_planned']);
});
