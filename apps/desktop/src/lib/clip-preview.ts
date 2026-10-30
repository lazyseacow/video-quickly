import type { AssetRecord, FrameRate, ProjectDocument, Shot, ShotCandidate } from '@video-quickly/contracts';
import { replaceShotMedia, resolveShotSpans, type ClipEditContext, type ClipEditIdFactory } from '@video-quickly/video/clip-edits';
import { trimShotInContext } from '@video-quickly/video/editing';
import type { WaveformSpan } from './waveform-peaks';

export function previewClipIds(context: ClipEditContext, prefix = 'clip-preview'): ClipEditIdFactory {
  const used = new Set([...context.clipEditPlans ?? [], ...context.clipEditSources ?? []].map(record => record.id)); let counter = 0;
  return kind => { let id: string; do { id = `${prefix}-${kind}-${++counter}`; } while (used.has(id)); used.add(id); return id; };
}

export function shotWaveformSpans(shot: Shot, context: ClipEditContext, range?: { inUs: number; outUs: number; rate: FrameRate; sourceDurationUs?: number }, kind: 'audio' | 'video' = 'audio'): WaveformSpan[] {
  const document = range ? trimShotInContext({ ...context, shots: [shot] }, shot.id, range, range.rate, range.sourceDurationUs, previewClipIds(context, 'waveform-preview')) : { ...context, shots: [shot] };
  return resolveShotSpans(document.shots[0], document).map(span => ({ outputStartUs: span.outputStartUs, durationUs: span.durationUs, sourceInUs: kind === 'video' ? span.videoInUs : span.audioInUs }));
}

/** Media preview uses a private plan and the candidate baseline; it never mutates the live draft. */
export function candidatePreviewProject(project: ProjectDocument, candidate: ShotCandidate, assets: readonly AssetRecord[]): ProjectDocument {
  if (candidate.projectId !== project.id) throw new Error('候选与当前项目不匹配。');
  let document = { ...project, shots: project.shots.map(shot => shot.id === candidate.shotId ? candidate.baseline : shot) };
  if (!document.shots.some(shot => shot.id === candidate.shotId)) throw new Error('候选对应的镜头已移除。');
  if (candidate.kind === 'audio' || candidate.kind === 'video') {
    const kind = candidate.kind, id = kind === 'audio' ? candidate.shot.audioAssetId : candidate.shot.videoAssetId;
    const asset = assets.find(asset => asset.id === id);
    if (!asset?.active || asset.kind !== kind || !candidate.assetIds.includes(asset.id)) throw new Error('候选素材尚未读取或已移除。');
    document = replaceShotMedia(document, candidate.shotId, kind, asset, previewClipIds(document, `candidate-preview-${candidate.id}`));
  } else if (candidate.kind === 'image') document = { ...document, shots: document.shots.map(shot => shot.id === candidate.shotId ? { ...shot, assetId: candidate.shot.assetId, videoAssetId: undefined, videoInUs: undefined, sceneTemplate: undefined } : shot) };
  return document;
}
