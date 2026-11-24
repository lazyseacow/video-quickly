import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assetSchema, chargeConfirmationSchema, MAX_NOVEL_ADAPTATION_INSTRUCTION_LENGTH, modelSchema, novelAdaptationStateSchema, projectReadinessSchema, projectSchema, runSchema, type NovelAdaptationState } from '@video-quickly/contracts';
import { createRuntime, type RuntimeOptions } from '../src/packages/runtime/src';
import { fixtureCharacterImage } from './fixtures/character-image';
import { importSkillFixture } from './fixtures/import-skill';
import { approvedDialogue, approvedScreenplay, characterSkill, directorDraft, novelCharacter, novelFixtureResponse, novelShot, novelSource } from './fixtures/novel-adaptation';

const directories: string[] = [];
const runtimes = new Set<ReturnType<typeof createRuntime>>();

afterEach(async () => {
  await Promise.all([...runtimes].map(runtime => runtime.close()));
  runtimes.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type GenerationStep = 'screenplay' | 'characters' | 'storyboard';
type GenerationOptions = { skillIds?: string[]; instruction?: string };

async function workspace() {
  const directory = await mkdtemp(join(tmpdir(), 'vq-novel-adaptation-'));
  directories.push(directory);
  const calls: { prompt: string; schemaName?: string }[] = [];
  const options: RuntimeOptions = {
    dataDirectory: directory, seed: false, requireChargeConfirmation: true,
    provider: async ({ prompt, outputSchemaName }) => {
      calls.push({ prompt, schemaName: outputSchemaName });
      return novelFixtureResponse(prompt, outputSchemaName);
    },
  };
  function open() {
    const instance = createRuntime(options);
    runtimes.add(instance);
    return instance;
  }
  let runtime = open();
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: {
    name: '导演改编夹具', provider: 'openai-compatible', textProtocol: 'responses', baseUrl: 'http://127.0.0.1:1/v1',
    capabilities: ['text', 'structured-output'], connectionType: 'text', model: 'novel-fixture',
  } }));
  const { project: created } = await runtime.dispatch('dramaStudio.create', {
    mode: 'novel', novelSource, work: { title: '渡口来信', visualStyle: 'live-action', narrativeMode: 'mixed' },
  }) as { project: unknown };
  const project = projectSchema.parse(created);
  const projectId = project.id;
  const get = async () => novelAdaptationStateSchema.parse(await runtime.dispatch('novelAdaptation.get', { projectId }));
  const readProject = async () => projectSchema.parse((await runtime.dispatch('project.get', { projectId }) as { project: unknown }).project);
  const action = async <T extends { revision: number }>(method: string, input: T) => novelAdaptationStateSchema.parse(await runtime.dispatch(method, { projectId, ...input }));
  const startParams = (state: NovelAdaptationState, step: GenerationStep, options?: GenerationOptions) =>
    ({ projectId, revision: state.revision, modelId: model.id, step, ...options, requestId: randomUUID() });
  const quote = (params: ReturnType<typeof startParams>) => runtime.dispatch('billing.prepare', { method: 'novelAdaptation.start', params });
  async function generate(state: NovelAdaptationState, step: GenerationStep, options?: GenerationOptions) {
    const params = startParams(state, step, options);
    const charge = chargeConfirmationSchema.parse(await quote(params));
    await runtime.dispatch('novelAdaptation.start', { ...params, chargeConfirmationId: charge.confirmationId });
    await runtime.waitForIdle();
    const result = await get();
    expect(result.runs[step]?.status, result.runs[step]?.error).toBe('succeeded');
    return result;
  }
  return {
    get runtime() { return runtime; },
    directory, project, calls, action, get, readProject, startParams, quote, generate,
    async reopen() { await runtime.close(); runtimes.delete(runtime); runtime = open(); },
  };
}

it('requires director approval before character creation and saves storyboard bindings to the Skill-backed characters', async () => {
  const source = await workspace();
  const initial = await source.get();
  expect(initial.source).toBe(novelSource);
  expect(source.project.workflow.production.novelAdaptation).toBe(true);
  expect(source.project.workflow.stages?.map(({ label }) => label)).toEqual(['策划与分镜', '素材与配音', '剪辑与动画', '审阅与导出']);
  const readiness = projectReadinessSchema.parse(await source.runtime.dispatch('project.readiness', { projectId: source.project.id }));
  expect(readiness.ready).toBe(false);
  expect(readiness.issues.map(issue => issue.fix)).toContain('novel-adaptation');
  await expect(source.runtime.dispatch('run.start', { projectId: source.project.id, nodeId: 'director-characters' })).rejects.toThrow('审核导演剧本');
  await expect(source.quote(source.startParams(initial, 'characters'))).rejects.toThrow();
  await expect(source.quote(source.startParams(initial, 'storyboard'))).rejects.toThrow();
  await expect(source.runtime.dispatch('novelAdaptation.start', source.startParams(initial, 'screenplay'))).rejects.toThrow('确认');
  expect(source.calls).toHaveLength(0);

  const draft = await source.generate(initial, 'screenplay');
  expect(draft.screenplay).toMatchObject({ text: directorDraft, approved: false });
  expect(source.calls[0].prompt).toContain(novelSource);
  expect((await source.readProject()).originalText ?? '').toBe('');
  await expect(source.quote(source.startParams(draft, 'characters'))).rejects.toThrow();

  const approved = await source.action('novelAdaptation.approve', { revision: draft.revision, screenplay: approvedScreenplay });
  expect(approved.screenplay).toMatchObject({ text: approvedScreenplay, approved: true });
  await source.reopen();
  expect(await source.get()).toMatchObject({ source: novelSource, screenplay: approved.screenplay });
  await expect(source.quote(source.startParams(approved, 'storyboard'))).rejects.toThrow();

  const skillDirectory = join(source.directory, 'wardrobe-guidance');
  await mkdir(skillDirectory);
  await writeFile(join(skillDirectory, 'SKILL.md'), `---\nname: wardrobe-guidance\ndescription: 角色服装一致性\n---\n${characterSkill}`);
  const { skills } = await importSkillFixture(source.runtime.dispatch, { path: skillDirectory });
  const extracted = await source.generate(approved, 'characters', { skillIds: [skills[0].id] });
  expect(extracted.characters.items).toMatchObject([novelCharacter]);
  expect(extracted.characters.applied).toBe(false);
  expect(source.calls[1].prompt).toContain(approvedDialogue);
  expect(source.calls[1].prompt).toContain(characterSkill);
  await expect(source.quote(source.startParams(extracted, 'storyboard'))).rejects.toThrow();

  const portrait = await fixtureCharacterImage();
  const imagePath = join(source.directory, 'reference.png');
  await writeFile(imagePath, portrait);
  const image = assetSchema.parse(await source.runtime.dispatch('asset.import', { path: imagePath, kind: 'image' }));
  const edited = { ...extracted.characters.items[0], description: '林夏穿着一件带醒目银条的橙色雨衣。', referenceAssetIds: [image.id] };
  const roles = await source.action('novelAdaptation.applyCharacters', { revision: extracted.revision, characters: [edited] });
  await expect(source.runtime.dispatch('asset.list', { kind: 'image' })).resolves.toMatchObject({ items: [{ id: image.id, inUse: true }] });
  await expect(source.runtime.dispatch('asset.delete', { assetId: image.id })).rejects.toThrow('正在使用');
  const backup = await source.runtime.dispatch('project.backup', { projectId: roles.projectId }) as { path: string };
  const backupData = JSON.parse(await readFile(join(backup.path, 'project.json'), 'utf8')) as { assets: { id: string; path: string }[] };
  expect(backupData).toMatchObject({ schemaVersion: 10, novelAdaptation: {
    source: novelSource, screenplay: { text: approvedScreenplay, approved: true },
    characters: { items: [edited], applied: true }, storyboard: { shots: [], applied: false },
  } });
  expect(backupData.assets).toEqual([expect.objectContaining({ id: image.id, path: expect.stringMatching(/^assets\/.+\.png$/) })]);
  expect(await readFile(join(backup.path, backupData.assets[0].path))).toEqual(portrait);
  const storyboard = await source.generate(roles, 'storyboard');
  expect(storyboard.storyboard.shots).toMatchObject([{ title: novelShot.title, creativeEntityKeys: [novelCharacter.key] }]);
  expect((await source.readProject()).shots).toEqual([]);
  const storyboardCalls = source.calls.slice(2);
  expect(storyboardCalls.map(({ schemaName }) => schemaName)).toEqual(['video_storyboard_outline', 'video_storyboard_batch']);
  expect(storyboardCalls.every(({ prompt }) => prompt.includes(approvedDialogue) && prompt.includes(edited.description))).toBe(true);

  const previous = await source.readProject();
  const title = `${previous.title}（修订）`;
  await source.runtime.dispatch('project.update', { projectId: previous.id, revision: previous.revision, patch: { title } });
  await expect(source.action('novelAdaptation.applyStoryboard', { revision: storyboard.revision })).rejects.toThrow('项目已修改');
  expect(await source.readProject()).toMatchObject({ title, shots: [] });
  const instruction = '镜头缓慢推近铜钥匙。';
  const currentStoryboard = await source.generate(await source.get(), 'storyboard', { instruction });
  expect(currentStoryboard.runs.storyboard?.instruction).toBe(instruction);
  for (const call of source.calls.slice(-2)) {
    expect(call.prompt).toContain(instruction);
    expect(call.prompt).toContain(`第 1 镜 ${novelShot.title}（5 秒）`);
  }
  const applied = await source.action('novelAdaptation.applyStoryboard', { revision: currentStoryboard.revision });
  expect(applied.storyboard.applied).toBe(true);
  const saved = await source.readProject();
  expect(saved.title).toBe(title);
  expect(saved.originalText).toBe(approvedScreenplay);
  expect(saved.creativeContext?.entities).toEqual(expect.arrayContaining([expect.objectContaining({ key: novelCharacter.key, name: novelCharacter.name })]));
  expect(saved.shots.map(({ title, creativeEntityKeys }) => ({ title, creativeEntityKeys }))).toEqual([{ title: novelShot.title, creativeEntityKeys: [novelCharacter.key] }]);
  expect(saved.workflow.production.manualPlanningSteps).toContain('script');
  const after = projectReadinessSchema.parse(await source.runtime.dispatch('project.readiness', { projectId: saved.id }));
  expect(after.issues.map(issue => issue.fix)).not.toContain('novel-adaptation');
  const callsBeforeProduction = source.calls.length;
  const formalRoleStep = runSchema.parse(await source.runtime.dispatch('run.start', { projectId: saved.id, nodeId: 'director-characters' }));
  await source.runtime.waitForIdle();
  const roleOutput = await source.runtime.dispatch('node.result', { runId: formalRoleStep.id, nodeId: 'director-characters' });
  expect(roleOutput).toMatchObject({ source: 'project', characters: [{ key: edited.key, referenceAssetIds: [image.id] }], text: expect.stringContaining(edited.description) });
  expect(source.calls).toHaveLength(callsBeforeProduction);

  const roleInstruction = '保留雨衣，为角色添加渔灯。';
  const revisedRoles = await source.generate(applied, 'characters', { instruction: roleInstruction });
  expect(revisedRoles.runs.characters?.instruction).toBe(roleInstruction);
  expect(revisedRoles.characters.applied).toBe(false);
  expect(source.calls.at(-1)?.prompt).toContain(edited.description);
  expect(source.calls.at(-1)?.prompt).toContain(roleInstruction);
  expect(source.calls.at(-1)?.prompt).not.toContain(image.id);
});

it('invalidates approval and rejects a stale edit or charge confirmation after the novel source changes', async () => {
  const source = await workspace();
  const initial = await source.get();
  const draft = await source.generate(initial, 'screenplay');
  const approved = await source.action('novelAdaptation.approve', { revision: draft.revision, screenplay: approvedScreenplay });
  const extraction = source.startParams(approved, 'characters');
  const quote = chargeConfirmationSchema.parse(await source.quote(extraction));

  const replacement = '清晨，守灯人在最后一格楼梯捡到一张手绘地图。';
  const edited = await source.action('novelAdaptation.saveSource', { revision: approved.revision, source: replacement });
  expect(edited).toMatchObject({ source: replacement, screenplay: { text: '', approved: false }, characters: { items: [], applied: false }, storyboard: { shots: [], applied: false } });
  await expect(source.action('novelAdaptation.approve', { revision: draft.revision, screenplay: approvedScreenplay })).rejects.toThrow();
  await expect(source.runtime.dispatch('novelAdaptation.start', { ...extraction, chargeConfirmationId: quote.confirmationId })).rejects.toThrow();
  await expect(source.quote(source.startParams(edited, 'storyboard'))).rejects.toThrow();
  expect(source.calls).toHaveLength(1);
  expect(await source.get()).toEqual(edited);
});

it('persists a charged instruction and supplies the confirmed screenplay as bounded context for a revision', async () => {
  const source = await workspace();
  const initial = await source.get();
  const initialInstruction = '用渡船上的细节交代悬念。';
  await expect(source.quote(source.startParams(initial, 'screenplay', {
    instruction: '字'.repeat(MAX_NOVEL_ADAPTATION_INSTRUCTION_LENGTH + 1),
  }))).rejects.toThrow();
  expect(source.calls).toHaveLength(0);
  const draft = await source.generate(initial, 'screenplay', { instruction: ` ${initialInstruction}\n` });
  expect(draft.runs.screenplay?.instruction).toBe(initialInstruction);
  expect(source.calls[0].prompt).toContain(initialInstruction);
  expect(source.calls[0].prompt).not.toContain('上一版');

  const priorTail = '这句位于长度上限之外，不发送给模型。';
  const approved = await source.action('novelAdaptation.approve', {
    revision: draft.revision, screenplay: [approvedScreenplay, '场景。'.repeat(3_000), priorTail].join('\n'),
  });
  const instruction = '将对白改得更克制。';
  const params = source.startParams(approved, 'screenplay', { instruction });
  const charge = chargeConfirmationSchema.parse(await source.quote(params));
  await expect(source.runtime.dispatch('novelAdaptation.start', {
    ...params, instruction: '换成新版要求。', chargeConfirmationId: charge.confirmationId,
  })).rejects.toThrow('费用确认');
  expect(source.calls).toHaveLength(1);
  await source.runtime.dispatch('novelAdaptation.start', { ...params, chargeConfirmationId: charge.confirmationId });
  await source.runtime.waitForIdle();
  expect(source.calls[1].prompt).toContain(approvedDialogue);
  expect(source.calls[1].prompt).toContain(instruction);
  expect(source.calls[1].prompt).not.toContain(priorTail);
  await source.reopen();
  const revised = await source.get();
  expect(revised.runs.screenplay).toMatchObject({ instruction, status: 'succeeded' });
  expect(revised.screenplay).toEqual({ text: directorDraft, approved: false });
  await expect(source.quote(source.startParams(revised, 'characters'))).rejects.toThrow();
});
