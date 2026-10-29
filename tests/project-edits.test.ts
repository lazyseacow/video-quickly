import { describe, expect, it } from 'vitest';
import { applyShotCandidate, createHistoryWorkflow, createSceneTemplate, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, DEFAULT_VIDEO_PROFILE, projectSchema, shotCandidateSchema } from '@video-quickly/contracts';
import { editContent, mergeEdits, ProjectEditSession, savedEditsSchema, sameContent } from '../apps/desktop/src/lib/project-edits';
import { deleteShotRanges } from '../packages/video/src/clip-edits';

const project = () => projectSchema.parse({ id: 'p', title: '项目', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, workflow: createHistoryWorkflow(), createdAt: '2026-10-29', updatedAt: '2026-10-29', shots: [1, 2].map(id => ({ id: `shot-${id}`, title: `镜头 ${id}`, narration: '', visualPrompt: '', durationUs: 1_000_000 })) });

describe('unified project edit commands', () => {
  it('persists source and plan record deltas atomically with mixing and shot DSP through undo and redo', () => {
    const original = project(); original.shots[0] = { ...original.shots[0], durationUs: 3_000_000, sourceInUs: 0, audioAssetId: 'voice' };
    let id = 0; const nextId = (kind: string) => `${kind}-${++id}`;
    const edited = deleteShotRanges(original, 'shot-1', [{ startUs: 1_000_000, endUs: 1_500_000 }], original.profile.frameRate, [{ id: 'voice', sha256: 'a'.repeat(64) }], nextId);
    const session = new ProjectEditSession(original);
    session.edit({ ...editContent(edited), audioMix: DEFAULT_AUDIO_MIX_SETTINGS }, '删除停顿并设置混音');
    expect(session.state.undo[0].after.clipEditSources?.put).toHaveLength(1); expect(session.state.undo[0].after.clipEditPlans?.put).toHaveLength(1);
    session.edit({ ...session.state.present, shots: session.state.present.shots.map((shot, index) => index ? shot : { ...shot, audioProcessing: { ...DEFAULT_AUDIO_PROCESSING, gainDb: -3 } }) }, '镜头声音处理');
    expect(session.state.undo[1].after.clipEditSources).toBeUndefined(); expect(session.state.undo[1].after.clipEditPlans).toBeUndefined();
    const saved = projectSchema.parse({ ...original, ...session.state.present, revision: 2 }); session.saved(saved);
    const restored = new ProjectEditSession(saved, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
    restored.undo(); expect(restored.state.present.shots[0].audioProcessing).toBeUndefined(); expect(restored.state.present.clipEditPlans).toHaveLength(1);
    restored.undo(); expect(restored.state.present).toEqual(editContent(original));
    restored.redo(); restored.redo(); expect(restored.state.present).toEqual(editContent(saved));
    restored.edit({ ...restored.state.present, title: '只改名称' }, '名称');
    const reloaded = new ProjectEditSession(saved, savedEditsSchema.parse(JSON.parse(JSON.stringify(restored.state)))); reloaded.undo();
    expect(reloaded.state.present.clipEditSources).toEqual(edited.clipEditSources); expect(reloaded.state.present.clipEditPlans).toEqual(edited.clipEditPlans); expect(reloaded.state.present.audioMix).toEqual(DEFAULT_AUDIO_MIX_SETTINGS);
  });

  it('keeps ten thousand original words in one shared source instead of copying them into each edit command', () => {
    const original = project(), marker = 'only-original-cue-8192';
    original.shots[0] = { ...original.shots[0], durationUs: 3_000_000, sourceInUs: 0, audioAssetId: 'voice', captionTrack: { timeBase: 'source', alignment: 'speech', granularity: 'word', sourceAssetId: 'voice', sourceSha256: 'a'.repeat(64), cues: Array.from({ length: 10_000 }, (_, index) => ({ id: `word-${index}`, startUs: index * 200, endUs: (index + 1) * 200, text: index === 8192 ? marker : `词${index}` })) } };
    const session = new ProjectEditSession(original); let count = 0;
    const assets = [{ id: 'voice', sha256: 'a'.repeat(64) }], id = (kind: string) => `${kind}-${++count}`;
    session.edit(deleteShotRanges(session.state.present, 'shot-1', [{ startUs: 1_000_000, endUs: 1_500_000 }], original.profile.frameRate, assets, id), '首次文稿剪辑');
    for (let index = 0; index < 8; index++) session.edit(deleteShotRanges(session.state.present, 'shot-1', [{ startUs: 100_000, endUs: 200_000 }], original.profile.frameRate, assets, id), '继续剪辑');
    expect(session.state.present.clipEditSources).toHaveLength(1); expect(session.state.present.clipEditSources[0].original.captionTrack?.cues).toHaveLength(10_000);
    expect(session.state.present.shots[0].captionTrack).toBeUndefined();
    expect(session.state.undo[0].after.clipEditSources?.put[0].original.captionTrack?.cues).toHaveLength(10_000);
    expect(session.state.undo.slice(1).every(command => command.before.clipEditSources === undefined && command.after.clipEditSources === undefined)).toBe(true);
    expect(JSON.stringify(session.state.undo.slice(1))).not.toContain(marker);
    expect(JSON.stringify(session.state.present).split(marker)).toHaveLength(2);
    const restored = new ProjectEditSession(original, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
    for (let index = 0; index < 9; index++) restored.undo(); expect(restored.state.present).toEqual(editContent(original));
    for (let index = 0; index < 9; index++) restored.redo(); expect(restored.state.present).toEqual(session.state.present);
  });

  it('merges independent source and plan additions by record ID while retaining their shot bindings', () => {
    const original = project(), span = { id: 'span', durationUs: 1_000_000, originInUs: 0, sourceInUs: 0, audioInUs: 0, videoInUs: 0, sceneInUs: 0 };
    const source = (id: string) => ({ id, original: { durationUs: 1_000_000 }, assetHashes: [] });
    const plan = (id: string, sourceId: string) => ({ id, sourceId, spans: [span] });
    const baseline = projectSchema.parse({ ...original, clipEditSources: [source('source-a'), source('source-b')], clipEditPlans: [plan('plan-a', 'source-a'), plan('plan-b', 'source-b')], shots: original.shots.map((shot, index) => ({ ...shot, clipEdit: { planId: index ? 'plan-b' : 'plan-a', inUs: 0, restoreInUs: 0, restoreDurationUs: 1_000_000 } })) });
    const local = editContent({ ...baseline, title: '本地名称', clipEditSources: [...baseline.clipEditSources!, source('source-c')], clipEditPlans: [...baseline.clipEditPlans!, plan('plan-c', 'source-c')], shots: baseline.shots.map((shot, index) => index ? shot : { ...shot, clipEdit: { ...shot.clipEdit!, planId: 'plan-c' } }) });
    const remote = editContent({ ...baseline, audioMix: DEFAULT_AUDIO_MIX_SETTINGS, clipEditSources: [...baseline.clipEditSources!, source('source-d')], clipEditPlans: [...baseline.clipEditPlans!, plan('plan-d', 'source-d')], shots: baseline.shots.map((shot, index) => index ? { ...shot, clipEdit: { ...shot.clipEdit!, planId: 'plan-d' } } : shot) });
    const merged = mergeEdits(editContent(baseline), local, remote);
    expect(merged.conflicts).toEqual([]); expect(merged.content.title).toBe('本地名称'); expect(merged.content.audioMix).toEqual(DEFAULT_AUDIO_MIX_SETTINGS);
    expect(merged.content.clipEditSources.map(value => value.id)).toEqual(['source-a', 'source-b', 'source-c', 'source-d']);
    expect(merged.content.clipEditPlans.map(value => value.id)).toEqual(['plan-a', 'plan-b', 'plan-c', 'plan-d']);
    expect(merged.content.shots.map(shot => shot.clipEdit?.planId)).toEqual(['plan-c', 'plan-d']);
    const base = editContent(baseline), shared = plan('shared-new-plan', 'source-a');
    const left = { ...base, clipEditPlans: [...base.clipEditPlans, shared] }, right = { ...base, clipEditPlans: [...base.clipEditPlans, { ...shared, spans: [{ ...span, audioInUs: 100_000 }] }] };
    expect(mergeEdits(base, left, right).conflicts.map(value => value.path)).toEqual(['clipEditPlans.shared-new-plan']);
    const choice = mergeEdits(base, left, right, { 'clipEditPlans.shared-new-plan': 'remote' });
    expect(choice.content.clipEditPlans.at(-1)?.spans[0].audioInUs).toBe(100_000); expect(choice.content.clipEditSources).toEqual(base.clipEditSources);
  });
  it('restores first-time mix settings and their removal through persisted undo and redo', () => {
    const original = project(), session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, audioMix: DEFAULT_AUDIO_MIX_SETTINGS }, '项目混音');
    const saved = projectSchema.parse({ ...original, ...session.state.present, revision: 2 }); session.saved(saved);
    const persisted = savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state)));
    const recovered = new ProjectEditSession(saved, persisted);
    recovered.undo(); expect(recovered.state.present.audioMix).toBeNull();
    recovered.redo(); expect(recovered.state.present.audioMix).toEqual(DEFAULT_AUDIO_MIX_SETTINGS);
    recovered.edit({ ...recovered.state.present, title: '无关名称' }, '项目名称');
    const reloaded = new ProjectEditSession(saved, savedEditsSchema.parse(JSON.parse(JSON.stringify(recovered.state))));
    reloaded.undo(); expect(reloaded.state.present.audioMix).toEqual(DEFAULT_AUDIO_MIX_SETTINGS);
  });
  it('does not inject snapshot defaults into a persisted shot-only command with authored claims and series style', () => {
    const original = projectSchema.parse({ ...project(), brief: '人工简报', style: '人工系列风格', claims: [{ id: 'claim', text: '人工资料', source: '来源正文' }], shots: project().shots.map(shot => ({ ...shot, claimIds: ['claim'] })) });
    const session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, shots: session.state.present.shots.map(shot => ({ ...shot, durationUs: 3_000_000 })) }, '批量修改镜头');
    const saved = projectSchema.parse({ ...original, ...session.state.present, revision: 2 }); session.saved(saved);
    const persisted = savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state)));
    expect(Object.keys(persisted.undo[0].before)).toEqual(['shots']); expect(Object.keys(persisted.undo[0].after)).toEqual(['shots']);
    const restored = new ProjectEditSession(saved, persisted);
    restored.undo(); expect(restored.state.present).toEqual(editContent(original));
    restored.redo(); expect(restored.state.present).toEqual(editContent(saved));
  });
  it('repairs equal default fields written by an earlier history parser while retaining actual style commands', () => {
    const original = projectSchema.parse({ ...project(), style: '人工风格', claims: [{ id: 'claim', text: '保留资料', source: '原文' }] }), session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, title: '新标题' }, '标题');
    const legacy = JSON.parse(JSON.stringify(session.state));
    for (const side of ['before', 'after']) { legacy.undo[0][side].style = project().style; legacy.undo[0][side].claims = []; }
    const restored = new ProjectEditSession(original, savedEditsSchema.parse(legacy)); restored.undo(); expect(restored.state.present).toEqual(editContent(original));
    restored.redo(); restored.edit({ ...restored.state.present, style: '另一个风格' }, '风格');
    const roundTrip = new ProjectEditSession(original, savedEditsSchema.parse(JSON.parse(JSON.stringify(restored.state))));
    roundTrip.undo(); expect(roundTrip.state.present.style).toBe('人工风格'); roundTrip.redo(); expect(roundTrip.state.present.style).toBe('另一个风格');
  });
  it('keeps unfinished template input and redo through draft restoration', () => {
    const original = project(), session = new ProjectEditSession(original);
    const example = createSceneTemplate('bar-chart');
    if (example.kind !== 'bar-chart') throw new Error('条形图夹具类型错误');
    const unfinished = { ...example, heading: '', bars: example.bars.map((bar, index) => index ? bar : { label: '', value: -3 }) };
    session.edit({ ...session.state.present, shots: session.state.present.shots.map((shot, index) => index ? shot : { ...shot, sceneTemplate: unfinished }) }, '编辑科普模板');
    const restored = new ProjectEditSession(original, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
    expect(restored.state.present.shots[0].sceneTemplate).toEqual(unfinished);
    expect(projectSchema.safeParse({ ...original, ...restored.state.present }).success).toBe(false);
    restored.undo(); expect(restored.state.present.shots[0].sceneTemplate).toBeUndefined();
    restored.redo(); expect(restored.state.present.shots[0].sceneTemplate).toEqual(unfinished);
  });
  it('saves template whitespace unchanged and retains template undo after reload', () => {
    const original = project(), session = new ProjectEditSession(original);
    const template = { ...createSceneTemplate('process'), heading: '  保留输入空格  ' };
    session.edit({ ...session.state.present, shots: session.state.present.shots.map((shot, index) => index ? shot : { ...shot, sceneTemplate: template }) }, '应用科普模板');
    const saved = projectSchema.parse({ ...original, ...session.state.present, revision: 2 });
    session.saved(saved); expect(session.dirty).toBe(false);
    const restored = new ProjectEditSession(saved, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
    expect(restored.state.present.shots[0].sceneTemplate?.heading).toBe('  保留输入空格  ');
    restored.undo(); expect(restored.state.present.shots[0].sceneTemplate).toBeUndefined();
  });
  it('restores a selected audio candidate and independent offsets through persisted undo and redo', () => {
    const original = project();
    original.shots[0] = { ...original.shots[0], sourceInUs: 1_000_000, videoAssetId: 'original-video', audioAssetId: 'original-audio' };
    const session = new ProjectEditSession(original);
    const baseline = original.shots[0];
    const candidate = shotCandidateSchema.parse({ id: 'candidate', projectId: original.id, shotId: baseline.id, kind: 'audio', runId: 'run', nodeId: 'regenerate', createdAt: '2026-10-30', baseline, shot: { ...baseline, audioAssetId: 'new-audio', audioInUs: 0 }, assetIds: ['new-audio'] });
    const selected = applyShotCandidate(baseline, candidate);
    const applied = projectSchema.parse({ ...original, revision: 2, shots: [selected, original.shots[1]] });
    session.beginSave(); session.receive(applied); session.applySaved(applied, '应用镜头候选'); session.endSave();
    const restored = new ProjectEditSession(applied, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
    restored.undo(); expect(restored.state.present.shots[0]).toEqual(baseline);
    restored.redo(); expect(restored.state.present.shots[0]).toEqual(selected);
    expect(restored.state.present.shots[0].sourceInUs).toBe(1_000_000);
    expect(restored.state.present.shots[0].audioInUs).toBe(0);
    expect(restored.state.present.shots[1]).toEqual(original.shots[1]);
  });
  it('restores music added to an old project through saved undo and redo after reload', () => {
    const original = project(); const session = new ProjectEditSession(original);
    const clip = { id: 'music', assetId: 'audio', startUs: 500_000, sourceInUs: 250_000, durationUs: 2_000_000, gainDb: -18, fadeInUs: 200_000, fadeOutUs: 300_000, loop: true };
    session.edit({ ...session.state.present, musicClips: [clip] }, '背景音乐');
    const saved = projectSchema.parse({ ...original, ...session.state.present, revision: 2 });
    session.saved(saved);
    const restored = new ProjectEditSession(saved, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
    expect(restored.dirty).toBe(false);
    restored.undo(); expect(restored.state.present.musicClips).toEqual([]);
    restored.redo(); expect(restored.state.present.musicClips).toEqual([clip]);
    const legacyDraft = JSON.parse(JSON.stringify(restored.state));
    delete legacyDraft.base.musicClips; delete legacyDraft.present.musicClips;
    expect(savedEditsSchema.parse(legacyDraft).present.musicClips).toEqual([]);
  });
  it('keeps music when a persisted command only changes another project field', () => {
    const clip = { id: 'music', assetId: 'audio', startUs: 0, sourceInUs: 0, durationUs: 2_000_000, gainDb: -18, fadeInUs: 0, fadeOutUs: 0, loop: true };
    const original = projectSchema.parse({ ...project(), musicClips: [clip] });
    const session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, title: '新标题' }, '项目名称');
    const restored = new ProjectEditSession(original, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
    restored.undo();
    expect(restored.state.present.musicClips).toEqual([clip]);
    restored.redo();
    expect(restored.state.present.musicClips).toEqual([clip]);
  });
  it('recognizes saved optional clip fields regardless of JSON key order', () => {
    const original = project(); const session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, shots: session.state.present.shots.map(shot => ({ ...shot, sourceInUs: 0, sceneInUs: 0, sceneDurationUs: shot.durationUs, sceneIndex: 0 })) }, '裁剪');
    const saved = projectSchema.parse({ ...original, ...session.state.present, revision: 2 });
    session.saved(saved);
    expect(session.dirty).toBe(false);
    expect(sameContent({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    session.undo(); expect(session.dirty).toBe(true);
  });
  it('groups continuous input and one drag, restores ordering/deletion, and clears a branched redo', () => {
    const session = new ProjectEditSession(project());
    for (const title of ['新', '新标题']) session.edit({ ...session.state.present, title }, '修改名称', 'title');
    session.endGroup();
    for (const zoom of [1.1, 1.2, 1.3]) session.edit({ ...session.state.present, shots: session.state.present.shots.map((shot, index) => index ? shot : { ...shot, animation: { ...shot.animation, zoom } }) }, '调整运镜', 'zoom');
    expect(session.state.undo).toHaveLength(2);
    session.undo(); expect(session.state.present.shots[0].animation.zoom).toBe(1.05);
    session.undo(); expect(session.state.present.title).toBe('项目');
    session.redo(); session.redo();
    session.edit({ ...session.state.present, shots: session.state.present.shots.toReversed() }, '排序');
    session.edit({ ...session.state.present, shots: session.state.present.shots.slice(1) }, '移除');
    session.undo(); expect(session.state.present.shots.map(shot => shot.id)).toEqual(['shot-2', 'shot-1']);
    session.undo(); expect(session.state.present.shots.map(shot => shot.id)).toEqual(['shot-1', 'shot-2']);
    session.edit({ ...session.state.present, brief: '新的编辑分支' }, '修改简报');
    expect(session.state.redo).toEqual([]);
  });

  it('persists a delta history and an unfinished field, including redo across reload', () => {
    const original = project(); const session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, profile: { ...session.state.present.profile, width: 0 }, shots: session.state.present.shots.map((shot, index) => index ? shot : { ...shot, title: '', durationUs: 1_000_000_000, narration: '字'.repeat(10001) }) }, '编辑标题');
    session.edit({ ...session.state.present, brief: '未保存内容' }, '编辑简报'); session.undo();
    const serialized = savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state)));
    const recovered = new ProjectEditSession(original, serialized);
    expect(recovered.state.recovered).toBe(true);
    expect(recovered.state.present.shots[0].title).toBe('');
    expect(recovered.state.present.profile.width).toBe(0);
    expect(recovered.state.present.shots[0].narration).toHaveLength(10001);
    expect(projectSchema.safeParse({ ...original, ...recovered.state.present }).success).toBe(false);
    recovered.redo(); expect(recovered.state.present.brief).toBe('未保存内容');
    recovered.undo(); recovered.undo(); expect(recovered.state.present).toEqual(editContent(original));
    expect(serialized.undo[0].after.shots?.put).toHaveLength(1);
    expect(serialized.undo[0].after.shots?.order).toBeUndefined();
  });

  it('keeps input made during a save, and makes generated output undoable at the new revision', () => {
    const original = project(); const session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, title: '已提交' }, '标题');
    session.beginSave();
    const saved = { ...original, ...session.state.present, revision: 2 };
    session.edit({ ...session.state.present, brief: '保存期间新输入' }, '简报');
    session.receive(saved); session.saved(saved); session.endSave();
    expect(session.dirty).toBe(true); expect(session.state.present.brief).toBe('保存期间新输入');
    expect(session.state.revision).toBe(2); expect(session.state.conflict).toBeUndefined();
    const latest = { ...saved, ...session.state.present, revision: 3 }; session.saved(latest);
    session.beginSave(); const output = { ...latest, revision: 4, shots: [] };
    session.receive(output); session.applySaved(output, '应用产物'); session.endSave();
    session.undo(); expect(session.state.present.shots).toHaveLength(2); expect(session.state.revision).toBe(4);
    session.saved({ ...output, ...session.state.present, revision: 5 });
    session.redo(); expect(session.state.present.shots).toEqual([]); expect(session.state.revision).toBe(5);
  });

  it('recognizes a save that committed before the client received its reply and retains redo', () => {
    const original = project(); const session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, title: '已编辑' }, '标题');
    session.saved({ ...original, ...session.state.present, revision: 2 });
    session.undo(); session.beginSave();
    const disk = savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state)));
    const committed = { ...original, revision: 3 };
    const recovered = new ProjectEditSession(committed, disk);
    expect(recovered.state.conflict).toBeUndefined(); expect(recovered.dirty).toBe(false);
    expect(recovered.state.revision).toBe(3); expect(recovered.state.redo).toHaveLength(1);
    recovered.redo(); expect(recovered.state.present.title).toBe('已编辑');
  });

  it('preserves the base revision on conflicts and merges independent shot fields and remote additions', () => {
    const original = project(); const session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, shots: session.state.present.shots.map((shot, index) => index ? shot : { ...shot, title: '我的标题', narration: '我的旁白' }) }, '镜头');
    const remote = { ...original, revision: 2, shots: [...original.shots.map((shot, index) => index ? shot : { ...shot, title: '外部标题', visualPrompt: '外部画面' }), { ...original.shots[1], id: 'shot-3' }] };
    session.receive(remote);
    expect(session.state.revision).toBe(1); expect(session.state.conflict?.revision).toBe(2);
    const comparison = mergeEdits(session.state.base, session.state.present, editContent(remote));
    expect(comparison.conflicts.map(item => item.path)).toEqual(['shots.shot-1.title']);
    session.resolve({ 'shots.shot-1.title': 'remote' });
    expect(session.state.present.shots[0]).toMatchObject({ title: '外部标题', narration: '我的旁白', visualPrompt: '外部画面' });
    expect(session.state.present.shots).toHaveLength(3); expect(session.state.revision).toBe(2);
    session.undo(); expect(session.state.present).toEqual(editContent(remote));
  });

  it('treats deletion versus editing as a conflict and rebases workflow-only updates', () => {
    const original = project(); const session = new ProjectEditSession(original);
    session.edit({ ...session.state.present, shots: [{ ...original.shots[0], title: '草稿标题' }, original.shots[1]] }, '镜头');
    session.receive({ ...original, revision: 2, workflow: { ...original.workflow, version: 2 } });
    expect(session.state.revision).toBe(2); expect(session.state.conflict).toBeUndefined();
    session.receive({ ...original, revision: 3, shots: [original.shots[1]] });
    expect(mergeEdits(session.state.base, session.state.present, editContent(session.state.conflict!)).conflicts[0].path).toBe('shots.shot-1');
    session.resolve({ 'shots.shot-1': 'local' }); expect(session.state.present.shots).toHaveLength(2);
  });
});
