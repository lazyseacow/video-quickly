import { expect, it } from 'vitest';
import { characterProfileSchema, creativeContextSchema, createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectCharacterIds, projectSchema, shotCreativePrompt, shotSchema, validateCreativeReferences, type ProjectDocument } from '@video-quickly/contracts';
import { buildWorkflowPrompt, parseWorkflowScript } from '../packages/runtime/src/workflow-prompts';
import { ProjectEditSession, savedEditsSchema } from '../apps/desktop/src/lib/project-edits';
import { applyProductionProjectDraft, stageConfigurationDraftSchema, updateProductionConfigurationDraft } from '../apps/desktop/src/lib/stage-configuration-draft';

const character = (id: string) => characterProfileSchema.parse({ id, name: `角色${id}`, description: `${id}固定外形`, referenceAssetIds: [], revision: 1, createdAt: '', updatedAt: '' });
const context = () => creativeContextSchema.parse({ characterIds: ['a', 'b'], continuity: '傍晚，服装保持一致', entities: [{ key: 'garden', kind: 'scene', name: '花园', description: '木门在左，喷泉在右' }] });
const project = () => projectSchema.parse({ id: 'creative', title: '花园故事', brief: '两位角色在花园相遇', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), shots: [], creativeContext: context(), createdAt: '', updatedAt: '' });
const shot = (extra: Record<string, unknown> = {}) => ({ title: '花园相遇', narration: '我们在这里相遇。', visualPrompt: '两个人站在木门前', durationUs: 2_000_000, ...extra });
const output = (...shots: ReturnType<typeof shot>[]) => JSON.stringify({ shots });

it('bounds creative inputs, rejects duplicate and reserved entity keys, and checks shot references', () => {
  expect(creativeContextSchema.parse({})).toEqual({ characterIds: [], entities: [], continuity: '' });
  for (const invalid of [{ characterIds: ['a', 'a'] }, { characterIds: Array.from({ length: 51 }, (_, index) => String(index)) }, { continuity: 'a'.repeat(10001) }, { entities: [context().entities[0], context().entities[0]] }, { entities: [{ ...context().entities[0], key: 'role-1' }] }]) expect(creativeContextSchema.safeParse(invalid).success).toBe(false);
  expect(() => validateCreativeReferences({ creativeContext: context(), shots: [{ creativeEntityKeys: ['missing'] }] })).toThrow('不存在');
  expect(() => validateCreativeReferences({ creativeContext: context(), shots: [{ creativeEntityKeys: ['garden'] }] })).not.toThrow();
});

it('maps frozen pool keys to real characters and carries newly extracted text settings into the project', () => {
  const current = project();
  const result = parseWorkflowScript(JSON.stringify({
    entities: [{ key: 'red-box', kind: 'prop', name: '红盒子', description: '磨损的红漆木盒' }, { key: 'visitor', kind: 'character', name: '访客', description: '银发，绿色外套' }],
    shots: [shot({ characterKeys: ['role-2'], entityKeys: ['garden', 'red-box'] }), shot({ characterKeys: ['role-1'], entityKeys: ['visitor'] })],
  }), current, false, [character('a'), character('b')]);
  expect(result.shots.map(shot => shot.characterIds)).toEqual([['b'], ['a']]);
  expect(result.shots[0].creativeEntityKeys).toEqual(['garden', 'red-box']);
  expect(result.creativeContext?.entities.map(entity => entity.key)).toEqual(['garden', 'red-box', 'visitor']);
  expect(current.shots).toEqual([]); expect(current.creativeContext?.entities).toHaveLength(1);
  const prompt = shotCreativePrompt(result, result.shots[0]);
  expect(prompt).toContain('木门在左'); expect(prompt).toContain('红漆木盒'); expect(prompt).toContain('傍晚'); expect(prompt).not.toContain('银发');
});

it('rejects fabricated bindings and attempts to change existing definitions before media generation', () => {
  const current = project(), profiles = [character('a'), character('b')];
  for (const keys of [['role-9'], ['invented-id'], ['role-1', 'role-1']]) expect(() => parseWorkflowScript(output(shot({ characterKeys: keys })), current, false, profiles)).toThrow();
  expect(() => parseWorkflowScript(output(shot({ entityKeys: ['invented-scene'] })), current, false, profiles)).toThrow('不存在');
  expect(() => parseWorkflowScript(output(shot()), current, false, profiles)).toThrow('characterKeys');
  expect(() => parseWorkflowScript(JSON.stringify({ entities: [{ ...context().entities[0], description: '改变布局' }], shots: [shot()] }), current, false, profiles)).toThrow('已存在');
  expect(parseWorkflowScript(JSON.stringify({ entities: context().entities, shots: [shot({ characterKeys: [] })] }), current, false, profiles).creativeContext?.entities).toEqual(context().entities);
});

it('preserves authored character selections, entity references, locked shots, clip windows and sound in single-shot generation', () => {
  const first = shotSchema.parse({ id: 'first', ...shot(), characterIds: ['b'], creativeEntityKeys: ['garden'], assetId: 'original-image', clipEdit: { planId: 'p', inUs: 0, restoreInUs: 0, restoreDurationUs: 2_000_000 } });
  const locked = shotSchema.parse({ id: 'locked', ...shot(), locked: true, characterIds: ['a'] });
  const current = { ...project(), shots: [first, locked] }, profiles = [character('a'), character('b')];
  const result = parseWorkflowScript(output(shot({ id: 'first', characterKeys: ['role-1'], entityKeys: [], durationUs: 8_000_000 }), shot({ id: 'locked' })), current, false, profiles);
  expect(result.shots[0]).toMatchObject({ characterIds: ['b'], creativeEntityKeys: ['garden'], assetId: 'original-image', durationUs: 2_000_000 });
  expect(result.shots[1]).toBe(locked);
  const single = parseWorkflowScript(output(shot({ id: 'first', characterKeys: ['role-1'], soundPrompt: '轻声讲述', durationUs: 9_000_000 })), { ...current, shots: [first] }, true, profiles);
  expect(single.shots[0]).toMatchObject({ characterIds: ['b'], creativeEntityKeys: ['garden'], durationUs: 2_000_000, soundPrompt: '轻声讲述' });
  expect(() => parseWorkflowScript(JSON.stringify({ entities: [{ key: 'new', kind: 'prop', name: '新道具', description: '' }], shots: [shot()] }), { ...current, shots: [first] }, true, profiles)).toThrow('不能新增');
  const cleared = { ...first, characterIds: [] };
  expect(parseWorkflowScript(output(shot({ characterKeys: ['role-1'] })), { ...current, shots: [cleared] }, false, profiles).shots[0].characterIds).toEqual([]);
});

it('builds stable role keys from the pool and existing shots without sending reference files as text', () => {
  const current = project(); current.shots = [shotSchema.parse({ id: 'one', ...shot(), characterIds: ['b', 'c'] })];
  expect(projectCharacterIds(current)).toEqual(['a', 'b', 'c']);
  const prompt = buildWorkflowPrompt(current, current.workflow.nodes.find(node => node.kind === 'script')!, [], false, [character('c'), character('b'), character('a')]);
  expect(prompt).toContain('"key":"role-1","name":"角色a"'); expect(prompt).toContain('"key":"role-3","name":"角色c"');
  expect(prompt).toContain('木门在左'); expect(prompt).toContain('characterKeys'); expect(prompt).toContain('没有发送参考图');
  expect(prompt).not.toContain('referenceAssetIds');
});

it('round-trips creative edits through drafts, undo, redo and unrelated edit commands', () => {
  const original = project(); delete original.creativeContext;
  const session = new ProjectEditSession(original);
  session.edit({ ...session.state.present, creativeContext: context() }, '设置项目角色');
  const saved = savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state)));
  const recovered = new ProjectEditSession(original, saved);
  expect(recovered.state.present.creativeContext).toEqual(context());
  recovered.undo(); expect(recovered.state.present.creativeContext).toBeNull();
  recovered.redo(); expect(recovered.state.present.creativeContext).toEqual(context());
  recovered.edit({ ...recovered.state.present, title: '修改标题' }, '修改标题');
  const restored = new ProjectEditSession(original, savedEditsSchema.parse(JSON.parse(JSON.stringify(recovered.state))));
  restored.undo(); expect(restored.state.present.creativeContext).toEqual(context());
  restored.undo(); expect(restored.state.present.creativeContext).toBeNull();
});

it('keeps pending creative configuration isolated and detects conflicting project changes', () => {
  const original = project(), before = { brief: original.brief, style: original.style, profile: original.profile, creativeContext: original.creativeContext };
  const next = { ...before, creativeContext: { ...context(), continuity: '清晨' } };
  const draft = updateProductionConfigurationDraft(original.id, undefined, original.workflow, original.workflow.nodes, original.workflow.production, before, next);
  const restored = stageConfigurationDraftSchema.parse(JSON.parse(JSON.stringify(draft)));
  expect(applyProductionProjectDraft(before, restored).settings.creativeContext?.continuity).toBe('清晨');
  expect(applyProductionProjectDraft({ ...before, creativeContext: { ...context(), continuity: '深夜' } }, restored).conflicts).toEqual(['creativeContext']);
  expect(original.creativeContext?.continuity).toBe('傍晚，服装保持一致');
});

it('keeps legacy storyboard output and projects valid without inventing creative settings', () => {
  const original = { ...project(), creativeContext: undefined };
  const result = parseWorkflowScript(output(shot()), original);
  expect(result).not.toHaveProperty('creativeContext'); expect(result.shots[0].characterIds).toBeUndefined();
  expect(result.shots[0].creativeEntityKeys).toBeUndefined();
  expect(projectSchema.parse({ ...original, ...result }) satisfies ProjectDocument).toBeTruthy();
});
