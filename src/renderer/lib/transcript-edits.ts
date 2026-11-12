import { silenceDetectionSchema, type AssetRecord, type CaptionCue, type PreparedAudioMix, type ProjectDocument, type Shot, type SilenceDetection } from '@video-quickly/contracts';
import { projectCaptionCues } from '@video-quickly/video';
import { clipEditPlan, clipEditSource, deleteShotRanges, resolveShotSpans, resolveShotTime, restoreShotRanges, sourceCaptionTrack, type ClipEditIdFactory, type ClipRange } from '@video-quickly/video/clip-edits';
import { sameContent, type EditContent } from './project-edits';

export type TranscriptEditAction = { kind: 'delete'; ranges: readonly ClipRange[] } | { kind: 'restore' };
export interface TranscriptSilenceOptions { thresholdDb: number; minimumDurationUs: number; paddingUs: number }
type TranscriptContext = Pick<ProjectDocument, 'shots' | 'clipEditPlans' | 'clipEditSources'>;

function findShot(content: TranscriptContext, shotId: string): Shot {
  const shot = content.shots.find(value => value.id === shotId);
  if (!shot) throw new Error('准备剪辑的镜头已移除，请重新选择。');
  return shot;
}
function inputs(content: TranscriptContext, shotId: string) {
  const shot = findShot(content, shotId);
  return { durationUs: shot.durationUs, narration: shot.narration, sourceInUs: shot.sourceInUs, audioInUs: shot.audioInUs, videoInUs: shot.videoInUs,
    sceneInUs: shot.sceneInUs, sceneDurationUs: shot.sceneDurationUs, sceneIndex: shot.sceneIndex, captionTrack: shot.captionTrack,
    assetId: shot.assetId, audioAssetId: shot.audioAssetId, videoAssetId: shot.videoAssetId, clipEdit: shot.clipEdit,
    plan: clipEditPlan(shot, content), source: clipEditSource(shot, content) };
}
export interface TranscriptSubmission { shotId: string; action: TranscriptEditAction; owned: ReturnType<typeof inputs> }

function assetIds(content: TranscriptContext, shotId: string): string[] {
  const shot = findShot(content, shotId), source = clipEditSource(shot, content);
  return [...new Set([shot.assetId, shot.audioAssetId, shot.videoAssetId, sourceCaptionTrack(shot, content)?.sourceAssetId, ...source?.assetHashes.map(value => value.assetId) ?? []].filter((id): id is string => Boolean(id)))].sort();
}
function assetInputs(ids: readonly string[], assets: readonly AssetRecord[], projectId: string) {
  const records = new Map(assets.map(asset => [asset.id, asset]));
  return ids.map(id => {
    const asset = records.get(id);
    if (!asset || !asset.active || asset.projectId !== undefined && asset.projectId !== projectId) throw new Error('剪辑关联的素材已移除或不可用，请重新读取后核对。');
    return { id, kind: asset.kind, projectId: asset.projectId, path: asset.path, sha256: asset.sha256, version: asset.version, size: asset.size, active: asset.active };
  });
}

/** Shared preflight for edits, actual silence detection and read-only candidate preparation. */
export function assertTranscriptBaseline(current: EditContent, baseline: ProjectDocument, shotId: string, assets: readonly AssetRecord[], assetsBaseline: readonly AssetRecord[], submitted?: TranscriptSubmission): void {
  const shot = findShot(current, shotId);
  if (shot.locked) throw new Error('请先解锁镜头，再修改文稿剪辑。');
  if (!sameContent(current.profile.frameRate, baseline.profile.frameRate)) throw new Error('项目帧率已变化，剪辑选择已保留，请重新打开后核对。');
  const live = inputs(current, shotId), before = inputs(baseline, shotId);
  const ids = [...new Set([...assetIds(current, shotId), ...assetIds(baseline, shotId)])].sort();
  if (!sameContent(assetInputs(ids, assets, baseline.id), assetInputs(ids, assetsBaseline, baseline.id))) throw new Error('剪辑素材的哈希或版本已变化，选择已保留，请重新打开后核对。');
  for (const source of [live.source, before.source]) for (const expected of source?.assetHashes ?? []) if (assets.find(asset => asset.id === expected.assetId)?.sha256 !== expected.sha256) throw new Error('原始剪辑素材的校验值已变化，请先重新核对来源。');
  if (!sameContent(live, before) && !(submitted?.shotId === shotId && sameContent(live, submitted.owned))) throw new Error('镜头的时间、媒体、字幕或剪辑计划已在其他视图更新，选择已保留，请重新打开后核对。');
}

/** One accepted operation is one command; retrying the same submitted result only saves it. */
export function applyTranscriptEdit(current: EditContent, baseline: ProjectDocument, shotId: string, action: TranscriptEditAction, assets: readonly AssetRecord[], assetsBaseline: readonly AssetRecord[], id: ClipEditIdFactory, submitted?: TranscriptSubmission): { content: EditContent; submission: TranscriptSubmission } {
  assertTranscriptBaseline(current, baseline, shotId, assets, assetsBaseline, submitted);
  const shot = findShot(current, shotId), live = inputs(current, shotId);
  if (submitted?.shotId === shotId && sameContent(submitted.action, action) && sameContent(live, submitted.owned)) return { content: current, submission: submitted };
  if (!sameContent(live, inputs(baseline, shotId))) throw new Error('当前剪辑已加入草稿，请先重试保存；选择新的剪辑需重新打开窗口。');
  if (action.kind === 'delete' && !action.ranges.length) throw new Error('请先选择要删除的词句或时间区间。');
  if (action.kind === 'restore' && !shot.clipEdit) throw new Error('当前镜头没有可恢复的文稿剪辑。');
  const content = action.kind === 'delete' ? deleteShotRanges(current, shotId, action.ranges, current.profile.frameRate, assets, id) : restoreShotRanges(current, shotId);
  return { content, submission: { shotId, action: structuredClone(action), owned: structuredClone(inputs(content, shotId)) } };
}

/** A preview has its own caller-supplied IDs and never writes into the opened project. */
export function previewTranscriptEdit(project: ProjectDocument, shotId: string, action: TranscriptEditAction, assets: readonly AssetRecord[], id: ClipEditIdFactory): ProjectDocument {
  const content = structuredClone(project);
  return action.kind === 'delete' ? deleteShotRanges(content, shotId, action.ranges, project.profile.frameRate, assets, id) : restoreShotRanges(content, shotId);
}

export interface TranscriptRows { cues: CaptionCue[]; granularity: 'word' | 'segment'; alignment: 'speech' | 'manual' | 'estimated'; staleSpeech: boolean }
export function transcriptRows(project: TranscriptContext, shotId: string, assets: readonly AssetRecord[]): TranscriptRows {
  const shot = findShot(project, shotId), track = sourceCaptionTrack(shot, project), audio = assets.find(asset => asset.id === shot.audioAssetId && asset.kind === 'audio' && asset.active);
  const staleSpeech = track?.alignment === 'speech' && (track.timeBase !== 'source' || !audio || track.sourceAssetId !== audio.id || track.sourceSha256 !== audio.sha256);
  const word = track?.alignment === 'speech' && track.granularity === 'word' && track.timeBase === 'source' && !staleSpeech;
  return { cues: projectCaptionCues(shot, 0, undefined, project), granularity: word ? 'word' : 'segment', alignment: track?.alignment ?? 'estimated', staleSpeech };
}

/** Locate an opened transcript position in the new kept spans; deleted positions land at the next cut. */
export function transcriptPreviewTime(project: TranscriptContext, candidate: TranscriptContext, shotId: string, localUs: number): number {
  const before = findShot(project, shotId), after = findShot(candidate, shotId), originUs = resolveShotTime(before, project, localUs).originUs;
  const spans = resolveShotSpans(after, candidate);
  for (const span of spans) if (originUs >= span.originInUs && originUs < span.originInUs + span.durationUs) return span.outputStartUs + originUs - span.originInUs;
  return spans.find(span => span.originInUs >= originUs)?.outputStartUs ?? Math.max(0, after.durationUs - 1);
}

export function transcriptMixOffset(project: Pick<ProjectDocument, 'shots'>, mix: Pick<PreparedAudioMix, 'shotDurations'>, shotId: string): number {
  const shot = project.shots.find(value => value.id === shotId);
  if (!shot) throw new Error('试听目标镜头已移除，请重新准备。');
  if (!mix.shotDurations) throw new Error('试听混音缺少镜头顺序，请重新准备。');
  let offsetUs = 0;
  for (const item of mix.shotDurations) {
    if (item.shotId === shotId) {
      if (item.durationUs !== shot.durationUs) throw new Error('试听混音的目标镜头时长不一致，请重新准备。');
      return offsetUs;
    }
    offsetUs += item.durationUs;
  }
  throw new Error('试听混音缺少目标镜头，请重新准备。');
}

/** Actual detected source intervals are projected through each surviving audio span, not ASR gaps. */
export function projectSilenceRanges(project: TranscriptContext, shotId: string, assets: readonly AssetRecord[], result: SilenceDetection): ClipRange[] {
  const detection = silenceDetectionSchema.parse(result), shot = findShot(project, shotId), audio = assets.find(asset => asset.id === shot.audioAssetId && asset.kind === 'audio' && asset.active);
  if (!audio || detection.assetId !== audio.id || detection.sourceSha256 !== audio.sha256) throw new Error('停顿检测结果与当前旁白不匹配，请重新检测。');
  const ranges = resolveShotSpans(shot, project).flatMap(span => detection.ranges.flatMap(range => {
    const startUs = Math.max(range.startUs, span.audioInUs), endUs = Math.min(range.endUs, span.audioInUs + span.durationUs);
    return endUs > startUs ? [{ startUs: span.outputStartUs + startUs - span.audioInUs, endUs: span.outputStartUs + endUs - span.audioInUs }] : [];
  })).sort((a, b) => a.startUs - b.startUs);
  const merged: ClipRange[] = [];
  for (const range of ranges) { const previous = merged.at(-1); if (previous && range.startUs <= previous.endUs) previous.endUs = Math.max(previous.endUs, range.endUs); else merged.push({ ...range }); }
  return merged;
}
