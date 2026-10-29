import { expect, it } from 'vitest';
import { captionStyleSchema, createHistoryWorkflow, createSceneTemplate, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, effectiveCaptionStyle, projectSchema, seriesTemplateSchema } from '@video-quickly/contracts';
import { editContent, ProjectEditSession, savedEditsSchema } from '../apps/desktop/src/lib/project-edits';
import { applySeriesSettings, DEFAULT_SERIES_APPLY_OPTIONS, seriesSettingsFromProject } from '../apps/desktop/src/lib/series-templates';
import { applyCaptionStyleEdit, applySeriesEdit, rememberSeriesSubmission } from '../apps/desktop/src/lib/style-edits';

function project() { return projectSchema.parse({ id: 'project', title: '独立题目', brief: '项目内容', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), claims: [{ id: 'claim', text: '人工核验内容', source: '原文' }], shots: [{ id: 'shot', title: '镜头事实', narration: '保留旁白', visualPrompt: '保留画面', durationUs: 1_000_000, claimIds: ['claim'], assetId: 'actual-image', captionTrack: { timeBase: 'scene', alignment: 'manual', cues: [{ id: 'cue', startUs: 0, endUs: 1_000_000, text: '真实字幕内容' }] }, sceneTemplate: { ...createSceneTemplate('bar-chart'), heading: '人工数据', bars: [{ label: '史料A', value: 123 }, { label: '史料B', value: 456 }] } }], createdAt: '', updatedAt: '' }); }
const alternative = { ...DEFAULT_CAPTION_STYLE, fontId: 'serif' as const, textColor: '#FFEECC', backgroundOpacity: 0, position: 'top' as const };

it('keeps old projects on the legacy style and applies whole-shot overrides with an explicit inherit value', () => {
  const original = project(); expect(original.captionStyle).toBeUndefined(); expect(effectiveCaptionStyle(original, original.shots[0])).toBeUndefined();
  expect(effectiveCaptionStyle({ captionStyle: DEFAULT_CAPTION_STYLE }, { captionStyle: alternative })).toEqual(alternative);
  expect(effectiveCaptionStyle({ captionStyle: DEFAULT_CAPTION_STYLE }, { captionStyle: null })).toEqual(DEFAULT_CAPTION_STYLE);
  expect(captionStyleSchema.parse(alternative).backgroundOpacity).toBe(0);
  for (const invalid of [{ fontSizeRatio: .001 }, { fontSizeRatio: Infinity }, { textColor: 'red' }, { backgroundColor: '#ffffff;bad' }, { maxLines: 4 }, { fontWeight: 500 }, { fontId: '/tmp/font.ttf' }]) expect(captionStyleSchema.safeParse({ ...DEFAULT_CAPTION_STYLE, ...invalid }).success).toBe(false);
});

it('copies series appearance without copying another topic, claims, media or authored chart values', () => {
  const original = project(), content = editContent(original), settings = { style: '新的系列风格', captionStyle: structuredClone(alternative), scenePreset: { kind: 'comparison' as const, palette: 'blue' as const, motion: 'none' as const } };
  const next = applySeriesSettings(content, settings, { ...DEFAULT_SERIES_APPLY_OPTIONS, updateExistingSceneLook: true });
  expect(next).toMatchObject({ title: original.title, brief: original.brief, claims: original.claims, style: settings.style, captionStyle: alternative, scenePreset: settings.scenePreset });
  expect(next.shots[0]).toEqual({ ...original.shots[0], sceneTemplate: { ...original.shots[0].sceneTemplate, palette: 'blue', motion: 'none' } });
  settings.captionStyle.textColor = '#000000'; expect(next.captionStyle?.textColor).toBe('#FFEECC');
  const template = seriesTemplateSchema.parse({ id: 'template', name: '  系列模板  ', description: '', revision: 1, createdAt: '', updatedAt: '', settings });
  expect(template.name).toBe('系列模板'); expect(Object.keys(template.settings).sort()).toEqual(['captionStyle', 'scenePreset', 'style']);
});

it('respects application scope and locked shot overrides', () => {
  const original = project(), first = { ...original.shots[0], captionStyle: alternative }, locked = { ...first, id: 'locked', locked: true };
  const content = editContent({ ...original, shots: [first, locked] }), settings = seriesSettingsFromProject({ ...original, captionStyle: DEFAULT_CAPTION_STYLE });
  const next = applySeriesSettings(content, settings, { style: false, captionStyle: false, scenePreset: false, clearShotCaptionStyles: true, updateExistingSceneLook: false });
  expect(next.style).toBe(content.style); expect(next.captionStyle).toBeNull(); expect(next.shots[0].captionStyle).toBeNull(); expect(next.shots[1]).toEqual(locked);
});

it('preserves live media and cue edits while protecting conflicting style changes and failed-save retries', () => {
  const original = project(), content = editContent(original), target = { mode: 'shot' as const, shotId: 'shot' };
  const live = { ...content, title: '外部标题', shots: content.shots.map(shot => ({ ...shot, videoAssetId: 'new-video' })) };
  const pending = applyCaptionStyleEdit(live, original, target, alternative);
  expect(pending.shots[0]).toMatchObject({ videoAssetId: 'new-video', captionStyle: alternative, captionTrack: original.shots[0].captionTrack });
  expect(applyCaptionStyleEdit(pending, original, target, null, alternative).shots[0].captionStyle).toBeNull();
  expect(() => applyCaptionStyleEdit(pending, original, target, DEFAULT_CAPTION_STYLE)).toThrow('其他视图');
  expect(() => applyCaptionStyleEdit({ ...live, shots: [] }, original, target, alternative)).toThrow('移除');
  const settings = { style: '新系列', captionStyle: alternative, scenePreset: null };
  expect(() => applySeriesEdit({ ...content, style: '外部系列' }, original, settings, DEFAULT_SERIES_APPLY_OPTIONS)).toThrow('其他视图');
  const first = applySeriesEdit(content, original, settings, DEFAULT_SERIES_APPLY_OPTIONS);
  const submitted = rememberSeriesSubmission(undefined, first, DEFAULT_SERIES_APPLY_OPTIONS, original.shots.map(shot => shot.id));
  expect(applySeriesEdit(first, original, seriesSettingsFromProject(original), DEFAULT_SERIES_APPLY_OPTIONS, submitted).style).toBe(original.style);
});

it('restores caption styles and series defaults through persisted undo and does not clear them in unrelated commands', () => {
  const original = project(), session = new ProjectEditSession(original);
  session.edit({ ...session.state.present, captionStyle: alternative, scenePreset: { kind: 'process', palette: 'amber', motion: 'reveal' } }, '应用系列默认');
  session.edit({ ...session.state.present, title: '改标题' }, '标题');
  const restored = new ProjectEditSession(original, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
  restored.undo(); expect(restored.state.present.captionStyle).toEqual(alternative); expect(restored.state.present.scenePreset?.palette).toBe('amber');
  restored.undo(); expect(restored.state.present.captionStyle).toBeNull(); expect(restored.state.present.scenePreset).toBeNull();
  restored.redo(); expect(restored.state.present.captionStyle).toEqual(alternative);
});

it('keeps a newly added shot outside the opened series synchronization scope', () => {
  const original = project(), content = editContent(original), newShot = { ...content.shots[0], id: 'new-shot', captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#00ff00' } };
  const current = { ...content, shots: [...content.shots, newShot] };
  const next = applySeriesEdit(current, original, { style: '新系列', captionStyle: alternative, scenePreset: { kind: 'process', palette: 'blue', motion: 'none' } }, { ...DEFAULT_SERIES_APPLY_OPTIONS, clearShotCaptionStyles: true, updateExistingSceneLook: true });
  expect(next.shots[1]).toEqual(newShot);
  expect(next.shots[0].captionStyle).toBeNull(); expect(next.shots[0].sceneTemplate?.palette).toBe('blue');
});

it('keeps ownership through two failed applications with a project scope off then on', () => {
  const original = project(), settings = { style: '本次系列', captionStyle: alternative, scenePreset: null };
  const first = applySeriesEdit(editContent(original), original, settings, DEFAULT_SERIES_APPLY_OPTIONS);
  const submitted = rememberSeriesSubmission(undefined, first, DEFAULT_SERIES_APPLY_OPTIONS, original.shots.map(shot => shot.id));
  const unchecked = { ...DEFAULT_SERIES_APPLY_OPTIONS, captionStyle: false };
  const second = applySeriesEdit(first, original, settings, unchecked, submitted);
  const retry = rememberSeriesSubmission(submitted, second, unchecked, original.shots.map(shot => shot.id));
  expect(() => applySeriesEdit(second, original, settings, DEFAULT_SERIES_APPLY_OPTIONS, retry)).not.toThrow();
});

it('does not claim an external project style observed while its scope is off', () => {
  const original = project(), settings = { style: '本次系列', captionStyle: alternative, scenePreset: null };
  const first = applySeriesEdit(editContent(original), original, settings, DEFAULT_SERIES_APPLY_OPTIONS);
  const submitted = rememberSeriesSubmission(undefined, first, DEFAULT_SERIES_APPLY_OPTIONS, original.shots.map(shot => shot.id));
  const external = { ...first, captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#0000ff' } };
  const unchecked = { ...DEFAULT_SERIES_APPLY_OPTIONS, captionStyle: false };
  const second = applySeriesEdit(external, original, settings, unchecked, submitted);
  const retry = rememberSeriesSubmission(submitted, second, unchecked, original.shots.map(shot => shot.id));
  expect(retry.content.captionStyle).toEqual(alternative);
  expect(() => applySeriesEdit(second, original, settings, DEFAULT_SERIES_APPLY_OPTIONS, retry)).toThrow('其他视图');
});

it('does not claim locked shot caption or scene changes from an earlier application', () => {
  const base = project(), original = { ...base, shots: [{ ...base.shots[0], locked: true, captionStyle: DEFAULT_CAPTION_STYLE }] };
  const settings = { style: '', captionStyle: null, scenePreset: { kind: 'process' as const, palette: 'amber' as const, motion: 'none' as const } };
  for (const scope of ['clearShotCaptionStyles', 'updateExistingSceneLook'] as const) {
    const options = { style: false, captionStyle: false, scenePreset: false, clearShotCaptionStyles: false, updateExistingSceneLook: false, [scope]: true };
    const external = editContent({ ...original, shots: [{ ...original.shots[0], captionStyle: alternative, sceneTemplate: { ...original.shots[0].sceneTemplate!, palette: 'blue', motion: 'none' } }] });
    const first = applySeriesEdit(external, original, settings, options);
    const submitted = rememberSeriesSubmission(undefined, first, options, original.shots.map(shot => shot.id));
    expect(submitted.shotIds[scope]).toEqual([]);
    const unlocked = { ...first, shots: first.shots.map(shot => ({ ...shot, locked: false })) };
    expect(() => applySeriesEdit(unlocked, original, settings, options, submitted)).toThrow('其他视图');
  }
});

it('retains explicit inherit values while project scopes are temporarily unchecked', () => {
  const base = project(), original = { ...base, captionStyle: alternative, scenePreset: { kind: 'process' as const, palette: 'blue' as const, motion: 'none' as const } };
  const settings = { style: '本次系列', captionStyle: null, scenePreset: null }, ids = original.shots.map(shot => shot.id);
  const first = applySeriesEdit(editContent(original), original, settings, DEFAULT_SERIES_APPLY_OPTIONS);
  const submitted = rememberSeriesSubmission(undefined, first, DEFAULT_SERIES_APPLY_OPTIONS, ids);
  const unchecked = { ...DEFAULT_SERIES_APPLY_OPTIONS, captionStyle: false, scenePreset: false };
  const second = applySeriesEdit(first, original, settings, unchecked, submitted);
  const retry = rememberSeriesSubmission(submitted, second, unchecked, ids);
  expect(retry.content.captionStyle).toBeNull(); expect(retry.content.scenePreset).toBeNull();
  expect(applySeriesEdit(second, original, seriesSettingsFromProject(original), DEFAULT_SERIES_APPLY_OPTIONS, retry)).toMatchObject({ captionStyle: alternative, scenePreset: original.scenePreset });
});

it('retains independent caption and look ownership across alternating shot scopes', () => {
  const base = project(), original = { ...base, shots: [{ ...base.shots[0], captionStyle: alternative }] }, ids = original.shots.map(shot => shot.id);
  const settings = { style: '', captionStyle: null, scenePreset: { kind: 'process' as const, palette: 'amber' as const, motion: 'none' as const } };
  const options = { style: false, captionStyle: false, scenePreset: false, clearShotCaptionStyles: true, updateExistingSceneLook: true };
  const first = applySeriesEdit(editContent(original), original, settings, options), submitted = rememberSeriesSubmission(undefined, first, options, ids);
  for (const scope of ['clearShotCaptionStyles', 'updateExistingSceneLook'] as const) {
    const unchecked = { ...options, [scope]: false }, second = applySeriesEdit(first, original, settings, unchecked, submitted);
    const retry = rememberSeriesSubmission(submitted, second, unchecked, ids);
    expect(() => applySeriesEdit(second, original, settings, options, retry)).not.toThrow();
    const external = { ...first, shots: first.shots.map(shot => scope === 'clearShotCaptionStyles' ? { ...shot, captionStyle: { ...DEFAULT_CAPTION_STYLE, textColor: '#0000ff' } } : { ...shot, sceneTemplate: { ...shot.sceneTemplate!, palette: 'blue' as const } }) };
    const withExternal = applySeriesEdit(external, original, settings, unchecked, submitted);
    const unrelatedSubmission = rememberSeriesSubmission(submitted, withExternal, unchecked, ids);
    expect(() => applySeriesEdit(withExternal, original, settings, options, unrelatedSubmission)).toThrow('其他视图');
  }
  expect(submitted.content.shots[0].captionStyle).toBeNull();
  expect(submitted.content.shots[0].sceneTemplate?.palette).toBe('amber');
});
