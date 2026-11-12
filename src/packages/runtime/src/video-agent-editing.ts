import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { captionCueSchema, frameAtTime, motionKeyframesSchema, musicClipSchema, type AssetRecord, type CaptionCue, type MotionKeyframe, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { createEstimatedCaptionTrack, createRenderSchedule, keyframePreviewWindow, motionSceneTimeUs, projectCaptionCues, replaceVisibleCaptionCues, sourceCaptionTrack } from '@video-quickly/video';
import { audioAsset, musicSourceRangeError, usesFullAudioSource } from '@video-quickly/video/audio';
import { probeAudioDurationUs, resolveAudioProject, type PrepareAudioMixOptions } from '@video-quickly/video/audio-mix';
import { reorderShotGroup, requireEditableShots, splitShotInContext } from '@video-quickly/video/editing';
import type { AgentTransitionEdit } from './agent.js';
import { applyAgentTransitions } from './video-agent.js';

const identifier = z.string().min(1);
const timeUs = z.number().int().nonnegative();
const { startUs, endUs, text } = captionCueSchema.shape;
const { panX, panY, zoom, easing, curve } = motionKeyframesSchema.element.shape;
const musicFields = musicClipSchema.shape;
const musicClipEdit = z.strictObject({
  id: identifier.optional().describe('编辑已有片段时填写其 ID，省略字段沿用原值。新增时省略 id。'),
  assetId: musicFields.assetId.optional().describe('新增片段时必填。'),
  durationUs: musicFields.durationUs.optional().describe('新增片段时必填。'),
  startUs: musicFields.startUs.removeDefault().optional(), sourceInUs: musicFields.sourceInUs.removeDefault().optional(),
  gainDb: musicFields.gainDb.removeDefault().optional(), loop: musicFields.loop.removeDefault().optional(),
  fadeInUs: musicFields.fadeInUs.removeDefault().optional(), fadeOutUs: musicFields.fadeOutUs.removeDefault().optional(),
});

export const agentTimelineEditSchema = z.strictObject({
  splits: z.array(z.strictObject({ shotId: identifier, atUs: timeUs.describe('拆分位置，以镜头起点为 0，单位微秒') })).optional(),
  reorder: z.strictObject({ shotIds: z.array(identifier).min(1), targetIndex: z.number().int().nonnegative().describe('移出所选镜头后，在剩余列表中的插入位置，从 0 开始，组内沿用当前顺序') }).optional(),
  music: z.strictObject({
    upsert: z.array(musicClipEdit).optional(),
    removeIds: z.array(identifier).optional(),
  }).optional().describe('背景音乐片段。startUs 为全片时间，sourceInUs 为音频素材时间，单位微秒。通过 list_audio_assets 获取 assetId。'),
  captions: z.array(z.strictObject({ shotId: identifier, cues: z.array(z.strictObject({ startUs, endUs, text })).max(10000) })).optional()
    .describe('替换每个目标镜头可见区间内的字幕，时间以镜头起点为 0，单位微秒。空 cues 清空可见字幕。'),
  subtitleMode: z.enum(['off', 'script']).optional().describe('成片字幕开关。script 在成片显示字幕，off 关闭。省略时沿用项目设置。'),
  keyframes: z.array(z.strictObject({ shotId: identifier, frames: z.array(z.strictObject({ atUs: timeUs, panX, panY, zoom, easing, curve })).max(200) })).optional()
    .describe('替换目标镜头的运镜关键帧。atUs 为镜头内微秒，panX、panY 为画面宽高的比例，zoom 为倍率。空 frames 关闭关键帧运镜。'),
});

export type AgentTimelineEdit = z.infer<typeof agentTimelineEditSchema>;
type TimelineMedia = Pick<PrepareAudioMixOptions, 'assets' | 'ffmpegPath' | 'signal'> & { getMusicAsset(id: string): AssetRecord | undefined };

async function editMusic(project: ProjectDocument, edit: NonNullable<AgentTimelineEdit['music']>, durationUs: number, media: TimelineMedia) {
  const original = project.musicClips ?? [];
  const clips = new Map(original.map(clip => [clip.id, clip]));
  if (clips.size !== original.length) throw new Error('背景音乐片段编号重复，请先修复项目。');
  const removedIds = edit.removeIds ?? [];
  for (const id of removedIds) {
    if (!clips.delete(id)) throw new Error(`请选择存在且只指定一次的背景音乐片段（${id}）。`);
  }
  const updated = new Set<string>(), durations = new Map<string, number>();
  const upserted = [];
  for (const draft of edit.upsert ?? []) {
    const existing = draft.id === undefined ? undefined : clips.get(draft.id);
    if (draft.id !== undefined && (!existing || updated.has(draft.id))) throw new Error(`请选择存在且只指定一次的背景音乐片段（${draft.id}）。`);
    const clip = musicClipSchema.parse({ ...existing, ...draft, id: draft.id ?? randomUUID() });
    const record = media.getMusicAsset(clip.assetId);
    const asset = audioAsset(clip.assetId, project.id, record ? [record] : [], '背景音乐');
    const sourceDurationUs = durations.get(asset.id) ?? await probeAudioDurationUs(asset, media);
    durations.set(asset.id, sourceDurationUs);
    const error = musicSourceRangeError(clip, sourceDurationUs);
    if (error) throw new Error(`音频「${asset.name}」时长 ${sourceDurationUs} 微秒。${error}`);
    clips.set(clip.id, clip);
    updated.add(clip.id);
    upserted.push({ ...clip, sourceDurationUs, audibleDurationUs: Math.max(0, Math.min(clip.durationUs, durationUs - clip.startUs)) });
  }
  return { clips: [...clips.values()], upserted, removedIds };
}

type AppliedKeyframe = MotionKeyframe & { atUs: number; frame: number };

function editMotion(shot: Shot, frames: NonNullable<AgentTimelineEdit['keyframes']>[number]['frames'],
  project: ProjectDocument, timing: ReturnType<typeof createRenderSchedule>[number]) {
  if (!frames.length) return { keyframes: undefined, applied: [] as AppliedKeyframe[] };
  if (!timing.frameCount) throw new Error(`镜头「${shot.title}」没有输出帧，请先调整时长或帧率。`);
  const window = keyframePreviewWindow(project, shot.id);
  const aligned = frames.map(({ atUs, ...pose }) => {
    if (atUs > shot.durationUs) throw new Error(`镜头「${shot.title}」的关键帧时间须位于当前镜头内。`);
    const localUs = window.align(atUs);
    return { ...pose, id: randomUUID(), timeUs: motionSceneTimeUs(shot, project, localUs), atUs: localUs,
      frame: frameAtTime(timing.startUs + localUs, project.profile.frameRate) };
  }).sort((left, right) => left.timeUs - right.timeUs);
  const keyframes = motionKeyframesSchema.parse(aligned);
  const applied = keyframes.map((frame, index) => ({ ...frame, atUs: aligned[index].atUs, frame: aligned[index].frame }));
  return { keyframes, applied };
}

async function applyTimeline(project: ProjectDocument, edit: AgentTimelineEdit, resolvedDurations: ReadonlyMap<string, number>, media: TimelineMedia) {
  const rate = project.profile.frameRate;
  const splits = edit.splits ?? [];
  if (splits.length) requireEditableShots(project.shots, splits.map(split => split.shotId));
  const timed = (shot: Shot) => {
    const durationUs = usesFullAudioSource(shot) ? resolvedDurations.get(shot.id) : undefined;
    return durationUs === undefined || durationUs === shot.durationUs ? shot : { ...shot, durationUs };
  };
  let edited = project;
  const splitIds = [];
  for (const { shotId, atUs } of splits) {
    const rightId = randomUUID();
    const input = { ...edited, shots: edited.shots.map(shot => shot.id === shotId ? timed(shot) : shot) };
    edited = splitShotInContext(input, shotId, atUs, rate, rightId);
    splitIds.push({ leftShotId: shotId, rightShotId: rightId });
  }
  if (edit.reorder) edited = { ...edited, shots: reorderShotGroup(edited.shots, edit.reorder.shotIds, edit.reorder.targetIndex) };

  const presentation = { ...edited, shots: edited.shots.map(timed) };
  const schedule = createRenderSchedule(presentation.shots, rate);
  const positions = schedule.map(({ index, startUs, endUs, firstFrame, endFrame }) => ({ shotId: edited.shots[index].id, index, startUs,
    durationUs: endUs - startUs, startFrame: firstFrame, endFrameExclusive: endFrame }));
  const positionById = new Map(positions.map(position => [position.shotId, position]));
  const appliedSplits = splitIds.map(({ leftShotId, rightShotId }) => ({ left: positionById.get(leftShotId)!, right: positionById.get(rightShotId)! }));

  const captions = new Map((edit.captions ?? []).map(change => [change.shotId, change.cues]));
  const motion = new Map((edit.keyframes ?? []).map(change => [change.shotId, change.frames]));
  if (edit.captions?.length) requireEditableShots(edited.shots, edit.captions.map(change => change.shotId));
  if (edit.keyframes?.length) requireEditableShots(edited.shots, edit.keyframes.map(change => change.shotId));
  const appliedCaptions: Array<{ shotId: string; projectStartUs: number; cues: CaptionCue[] }> = [];
  const appliedKeyframes: Array<{ shotId: string; frames: AppliedKeyframe[] }> = [];
  const shots = edited.shots.map((shot, index) => {
    const playback = presentation.shots[index];
    const cues = captions.get(shot.id), frames = motion.get(shot.id);
    let next = shot;
    if (cues) {
      const source = sourceCaptionTrack(shot, edited) ?? createEstimatedCaptionTrack(playback);
      const captionTrack = replaceVisibleCaptionCues(playback, source, cues.map(cue => ({ ...cue, id: randomUUID(), text: cue.text.trim() })).sort((a, b) => a.startUs - b.startUs), edited);
      next = { ...next, captionTrack };
      appliedCaptions.push({ shotId: shot.id, projectStartUs: schedule[index].startUs, cues: projectCaptionCues({ ...playback, captionTrack }, 0, undefined, edited) });
    }
    if (frames) {
      const { keyframes, applied } = editMotion(playback, frames, presentation, schedule[index]);
      next = { ...next, animation: { ...next.animation, keyframes } };
      appliedKeyframes.push({ shotId: shot.id, frames: applied });
    }
    return next;
  });
  const music = edit.music && (edit.music.upsert?.length || edit.music.removeIds?.length)
    ? await editMusic(edited, edit.music, schedule.at(-1)?.endUs ?? 0, media) : undefined;
  const workflow = edit.subtitleMode === undefined ? edited.workflow
    : { ...edited.workflow, production: { ...edited.workflow.production, subtitleMode: edit.subtitleMode } };
  const editedProject = { ...edited, shots, workflow, ...(music ? { musicClips: music.clips } : {}) };
  return { editedProject, durations: new Map(positions.map(position => [position.shotId, position.durationUs])), appliedEdits: {
    ...(appliedSplits.length ? { splits: appliedSplits } : {}),
    ...(edit.reorder ? { shotOrder: positions } : {}),
    ...(music ? { music: { upserted: music.upserted, removedIds: music.removedIds } } : {}),
    ...(appliedCaptions.length ? { captions: appliedCaptions } : {}),
    ...(appliedCaptions.length || edit.subtitleMode !== undefined ? { subtitleMode: workflow.production.subtitleMode } : {}),
    ...(appliedKeyframes.length ? { keyframes: appliedKeyframes } : {}),
  } };
}

export async function applyAgentTimelineEdits(project: ProjectDocument, edit: AgentTimelineEdit | undefined, transitions: readonly AgentTransitionEdit[] | undefined, media: TimelineMedia) {
  const resolved = await resolveAudioProject({ ...media, project });
  const resolvedDurations = new Map(resolved.shots.map(shot => [shot.id, shot.durationUs]));
  const timeline = edit ? await applyTimeline(project, edit, resolvedDurations, media) : undefined;
  const editedProject = timeline?.editedProject ?? project;
  const result = transitions?.length ? applyAgentTransitions(editedProject, transitions, timeline?.durations ?? resolvedDurations) : { editedProject };
  return { ...result, ...(timeline ? { appliedEdits: timeline.appliedEdits } : {}) };
}
