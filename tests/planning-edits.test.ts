import { expect, it } from 'vitest';
import { createNativeVideoWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type CreativeContext } from '@video-quickly/contracts';
import { applyPlanningEdit, planningResultValue, readRecordedStoryboardDraft, type PlanningShot } from '../apps/desktop/src/lib/planning-edits';
import { editContent, ProjectEditSession } from '../apps/desktop/src/lib/project-edits';

function project() { return projectSchema.parse({ id: 'planning-project', title: '策划修改', brief: '原简报', style: '原风格', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createNativeVideoWorkflow(), createdAt: '', updatedAt: '', shots: ['A', 'B'].map(id => ({ id, title: id, narration: `旁白${id}`, visualPrompt: `画面${id}`, durationUs: 2_000_000 })) }); }
const inputs = (shots: ReturnType<typeof project>['shots']): PlanningShot[] => shots.map(({ id, title, narration, visualPrompt, soundPrompt }) => ({ id, title, narration, visualPrompt, soundPrompt }));

it('saves a brief as one reversible edit while retaining unrelated live project fields', () => {
  const value = project(), session = new ProjectEditSession(value), baseline = editContent(value);
  const live = { ...session.state.present, title: '另一个标题', style: '最新风格' };
  session.edit(live, '现有修改');
  session.edit(applyPlanningEdit(session.state.present, baseline, { kind: 'brief', text: '修改后的简报' }), '修改创意简报');
  expect(session.state.present).toMatchObject({ brief: '修改后的简报', title: '另一个标题', style: '最新风格' });
  expect(session.state.present.shots).toBe(live.shots);
  session.undo(); expect(session.state.present).toEqual(live);
  session.redo(); expect(session.state.present.brief).toBe('修改后的简报');
});

it('edits style and creative context together, independently guarding only changed fields', () => {
  const baseline = editContent(project());
  const context: CreativeContext = { characterIds: [], entities: [{ key: 'room', kind: 'scene', name: '办公室', description: '窗边的办公桌' }], continuity: '保持蓝色服装' };
  const next = applyPlanningEdit(baseline, baseline, { kind: 'style', text: '漫画风格', creativeContext: context });
  expect(next).toMatchObject({ style: '漫画风格', creativeContext: context, brief: baseline.brief });
  expect(applyPlanningEdit({ ...baseline, style: '外部风格' }, baseline, { kind: 'style', text: baseline.style, creativeContext: context }).style).toBe('外部风格');
  expect(() => applyPlanningEdit({ ...baseline, style: '外部风格' }, baseline, { kind: 'style', text: '编辑器风格', creativeContext: context })).toThrow('视觉风格已在其他位置修改');
});

it('changes authored shot fields without overwriting current media, timing, captions or shot order', () => {
  const baseline = editContent(project()), request = inputs(baseline.shots);
  request[0] = { ...request[0], narration: '调整后的旁白', visualPrompt: '更清晰的办公画面', soundPrompt: '自然讲述' };
  const current = { ...baseline, shots: [{ ...baseline.shots[1], title: '外部保留的标题' }, { ...baseline.shots[0], videoAssetId: 'latest-video', durationUs: 4_000_000, videoInUs: 500_000 }, { ...baseline.shots[1], id: 'C', title: '新镜头' }] };
  const before = structuredClone(current);
  const next = applyPlanningEdit(current, baseline, { kind: 'script', shots: request });
  expect(next.shots.map(shot => shot.id)).toEqual(['B', 'A', 'C']);
  expect(next.shots[1]).toMatchObject({ narration: '调整后的旁白', visualPrompt: '更清晰的办公画面', soundPrompt: '自然讲述', videoAssetId: 'latest-video', durationUs: 4_000_000, videoInUs: 500_000 });
  expect(next.shots[0]).toBe(current.shots[0]); expect(next.shots[2]).toBe(current.shots[2]); expect(current).toEqual(before);
});

it('rejects locked, removed or concurrently edited targets atomically', () => {
  const baseline = editContent(project()), request = inputs(baseline.shots);
  request[0].narration = '新旁白'; request[1].title = '新标题';
  const locked = { ...baseline, shots: baseline.shots.map(shot => shot.id === 'B' ? { ...shot, locked: true } : shot) }, before = structuredClone(locked);
  expect(() => applyPlanningEdit(locked, baseline, { kind: 'script', shots: request })).toThrow('已锁定'); expect(locked).toEqual(before);
  expect(() => applyPlanningEdit({ ...baseline, shots: baseline.shots.slice(0, 1) }, baseline, { kind: 'script', shots: request })).toThrow('已移除');
  expect(() => applyPlanningEdit({ ...baseline, shots: baseline.shots.map(shot => ({ ...shot, narration: '外部旁白' })) }, baseline, { kind: 'script', shots: request })).toThrow('已在其他位置修改');
});

it('permits idempotent save retries and ignores removed shots that the author did not change', () => {
  const baseline = editContent(project());
  const change = { kind: 'brief' as const, text: '已提交的简报' };
  const submitted = applyPlanningEdit(baseline, baseline, change);
  expect(applyPlanningEdit(submitted, baseline, change)).toEqual(submitted);
  const unchanged = inputs(baseline.shots), current = { ...baseline, shots: baseline.shots.slice(0, 1) };
  expect(applyPlanningEdit(current, baseline, { kind: 'script', shots: unchanged })).toEqual(current);
});

it('keeps optional sound requirements untouched when opening and saving an unchanged script', () => {
  const baseline = editContent(project());
  const next = applyPlanningEdit(baseline, baseline, { kind: 'script', shots: inputs(baseline.shots) });
  expect(next).toEqual(baseline); expect(next.shots[0]).toBe(baseline.shots[0]);
  expect(planningResultValue(baseline, 'script')).toMatchObject({ shots: [{ soundPrompt: '' }, { soundPrompt: '' }] });
});

it('restores recorded storyboard references while keeping current creative settings', () => {
  const room = { key: 'room', kind: 'scene' as const, name: '办公室', description: '窗边的办公桌' };
  const prop = { key: 'book', kind: 'prop' as const, name: '笔记本', description: '蓝色封面' };
  const recorded = {
    shots: project().shots.map(shot => ({ ...shot, creativeEntityKeys: ['room', 'book'] })),
    creativeContext: { characterIds: [], entities: [room, prop], continuity: '保持蓝色服装' },
  };
  const current = { characterIds: [], entities: [{ ...room, description: '门边的办公桌' }], continuity: '保持白色服装' };
  expect(readRecordedStoryboardDraft(recorded, undefined)).toEqual(recorded);
  expect(readRecordedStoryboardDraft(recorded, current)).toEqual({ shots: recorded.shots, creativeContext: { ...current, entities: [...current.entities, prop] } });
});

it('adds authored shots and changes explicit durations without duplicating a retried save', () => {
  const baseline = editContent(project());
  const changes = inputs(baseline.shots);
  changes[0].durationUs = 1_250_000;
  const newShot: PlanningShot = { id: 'authored', title: '手填镜头', narration: '手填旁白', visualPrompt: '清晨的树林', durationUs: 3_500_000 };
  const change = { kind: 'script' as const, shots: changes, newShots: [newShot] };
  const next = applyPlanningEdit(baseline, baseline, change);
  expect(next.shots[0].durationUs).toBe(1_250_000);
  expect(next.shots[2]).toMatchObject(newShot);
  expect(applyPlanningEdit(next, baseline, change)).toEqual(next);
  expect(() => applyPlanningEdit(baseline, baseline, { ...change, newShots: [{ ...newShot, durationUs: 100_000 }] })).toThrow();
});
