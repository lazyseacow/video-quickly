import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { timeAtFrame, type AssetRecord, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { createTransitionTimeline, drawSceneCaptions, sampleTransition, wipeLeftIncomingStartX } from '@video-quickly/video';
import { PlaybackClock, type PlaybackFrameGate } from '../lib/playback';
import { useAssetAvailabilityKey } from '../lib/asset-availability';
import { ScenePreview, ScenePreviewState, previewSceneFrame, type ScenePreviewFrame, type ScenePreviewProject } from './ScenePreview';
import { previewAssetKey } from './preview-media';
import { TransitionFrameBuffer } from './transition-frame-buffer';
import { useBufferingIndicator } from './use-buffering-indicator';

interface Props {
  project: ProjectDocument;
  draft?: Shot;
  assets: AssetRecord[];
  timeUs: number;
  playing: boolean;
  buffering?: boolean;
  clock: PlaybackClock;
  onRepair?: (shot: Shot) => void;
}

interface SourceProps {
  sourceKey: string;
  project: ScenePreviewProject;
  shot: Shot;
  shotIndex: number;
  assets: AssetRecord[];
  timeUs: number;
  playing: boolean;
  buffering?: boolean;
  preparation?: TransitionFrameBuffer;
  onFrame: (key: string, frame?: ScenePreviewFrame, preparation?: TransitionFrameBuffer) => void;
}

const PreviewSource = memo(function PreviewSource({ sourceKey, onFrame, preparation, ...props }: SourceProps) {
  const receive = useCallback((frame: ScenePreviewFrame) => onFrame(sourceKey, frame, preparation), [sourceKey, onFrame, preparation]);
  useEffect(() => () => onFrame(sourceKey), [sourceKey, onFrame]);
  return <ScenePreview {...props} frameSink={receive} />;
});

interface PreviewState { key: string; status: 'loading' | 'ready' | 'error'; error?: string; shot?: Shot }
interface PresentedFrame { project: ProjectDocument; shot: Shot; key: string; frame: number }

function pictureKey(projectId: string, shot: Shot | undefined, outgoing: Shot | undefined, retry: number) {
  return JSON.stringify([projectId, shot?.id, outgoing?.id, retry]);
}

/** Reuse current + preloaded next as outgoing + incoming, with at most two scene decoders. */
export const TimelinePreview = memo(function TimelinePreview({ project, draft, assets, timeUs, playing, buffering, clock, onRepair }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const frames = useRef(new Map<string, ScenePreviewFrame>());
  const presented = useRef<PresentedFrame | undefined>(undefined);
  const [retry, setRetry] = useState(0);
  const [, setPreparationVersion] = useState(0);
  const preparationTimer = useRef<{ buffer: TransitionFrameBuffer; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
  const [state, setState] = useState<PreviewState>({ key: '', status: 'loading' });
  const published = useRef(state);
  const shots = useMemo(() => project.shots.map(shot => shot.id === draft?.id ? draft : shot), [project.shots, draft]);
  const transitionTimeline = useMemo(() => createTransitionTimeline(project.shots.map(shot => shot.id === draft?.id ? { ...shot, animation: draft.animation } : shot), project.profile.frameRate), [project.shots, draft?.id, draft?.animation, project.profile.frameRate.numerator, project.profile.frameRate.denominator]);
  const sample = sampleTransition(transitionTimeline, timeUs);
  const shot = sample ? shots[sample.shotIndex] : undefined;
  const outgoing = sample?.outgoing ? shots[sample.outgoing.shotIndex] : undefined;
  const clip = transitionTimeline.clips.find(clip => clip.index === sample?.shotIndex);
  const nextClip = !outgoing && clip ? transitionTimeline.clips[transitionTimeline.clips.indexOf(clip) + 1] : undefined;
  const nextShot = nextClip ? shots[nextClip.index] : undefined;
  const preparationClip = sample?.effect ? clip : nextClip;
  const preparationShot = preparationClip ? shots[preparationClip.index] : undefined;
  const preparationAssetId = preparationShot?.sceneTemplate ? undefined : preparationShot?.videoAssetId ?? preparationShot?.assetId;
  const preparationAsset = assets.find(asset => asset.id === preparationAssetId);
  const availability = useAssetAvailabilityKey([preparationAssetId]);
  const assetKey = preparationAsset ? previewAssetKey(preparationAsset) : preparationAssetId;
  const buffer = useMemo(() => {
    if (!preparationClip || !preparationShot || preparationClip.transition === 'cut') return;
    const previous = transitionTimeline.clips[transitionTimeline.clips.indexOf(preparationClip) - 1];
    const count = Math.min(previous?.padFrames ?? 0, preparationClip.frameCount);
    if (!count) return;
    return new TransitionFrameBuffer(Array.from({ length: count }, (_, index) => {
      const frame = preparationClip.firstFrame + index;
      return { frame, timeUs: timeAtFrame(frame, transitionTimeline.rate) - preparationClip.startUs };
    }));
  }, [preparationClip, preparationShot, transitionTimeline, project.profile, project.captionStyle, project.clipEditSources, project.clipEditPlans, project.workflow.production.subtitleMode, assetKey, availability, retry]);
  const preparedTimeUs = buffer?.nextSample?.timeUs ?? (preparationClip && buffer ? timeAtFrame(Math.min(preparationClip.endFrame - 1, preparationClip.firstFrame + buffer.samples.length), transitionTimeline.rate) - preparationClip.startUs : 0);
  useLayoutEffect(() => () => {
    const pending = preparationTimer.current;
    if (pending && pending.buffer === buffer) { clearTimeout(pending.timer); preparationTimer.current = undefined; }
    buffer?.clear();
  }, [buffer]);
  // Freeze the last sample accurately before it becomes the outgoing picture.
  const sourcePlaying = playing && !sample?.effect && sample?.frame !== (clip?.endFrame ?? 0) - 1;
  const key = pictureKey(project.id, shot, outgoing, retry);
  const sourceKey = (source: Shot) => JSON.stringify([project.id, source.id, retry]);
  const latest = useRef({ project, shots, transitionTimeline, sample, shot, outgoing, key, retry, sourcePlaying, buffer, preparationShot });
  latest.current = { project, shots, transitionTimeline, sample, shot, outgoing, key, retry, sourcePlaying, buffer, preparationShot };
  const gate = useMemo<PlaybackFrameGate>(() => ({
    constrainTime(fromUs, requestedUs) {
      const { transitionTimeline } = latest.current;
      const boundary = transitionTimeline.clips.find(clip => {
        const startUs = timeAtFrame(clip.firstFrame, transitionTimeline.rate);
        return startUs > fromUs && startUs <= requestedUs;
      });
      return boundary ? timeAtFrame(boundary.firstFrame, transitionTimeline.rate) : requestedUs;
    },
    isFrameReady(timeUs) {
      const { project, shots, transitionTimeline, retry } = latest.current;
      const wanted = sampleTransition(transitionTimeline, timeUs), picture = presented.current;
      if (!wanted || !picture || published.current.status !== 'ready') return false;
      const shot = shots[wanted.shotIndex], outgoing = wanted.outgoing ? shots[wanted.outgoing.shotIndex] : undefined;
      return picture.project === project && picture.shot === shot && picture.frame === wanted.frame && picture.key === pictureKey(project.id, shot, outgoing, retry);
    },
  }), [clock, project.id]);
  useLayoutEffect(() => clock.attachFrameGate(gate), [clock, gate]);

  const paint = useCallback(() => {
    const { project, sample, shot, outgoing, key, retry, sourcePlaying, buffer, preparationShot } = latest.current;
    const target = canvas.current;
    if (!target || !sample || !shot) return;
    const live = frames.current.get(JSON.stringify([project.id, shot.id, retry]));
    const buffered = sample.effect && preparationShot === shot ? buffer?.get(sample.frame) : undefined;
    const current: ScenePreviewFrame | undefined = buffered ? { status: 'ready', canvas: buffered.canvas, shot, timeUs: sample.localTimeUs, playing: false } : live;
    const previous = outgoing ? frames.current.get(JSON.stringify([project.id, outgoing.id, retry])) : undefined;
    const publish = (status: PreviewState['status'], error?: string, failedShot?: Shot) => {
      const before = published.current;
      if (before.key === key && before.status === status && before.error === error && before.shot === failedShot) return;
      published.current = { key, status, error, shot: failedShot };
      setState(published.current);
    };
    if (live?.status === 'error') { publish('error', live.message, shot); return; }
    if (previous?.status === 'error') { publish('error', `上一镜头：${previous.message}`, outgoing); return; }
    // Commit the entire prefix before releasing the entrance frame. Playback
    // then reads immutable pictures instead of seeking and pausing each frame.
    if (sample.effect && buffer && !buffer.ready) { publish('loading'); return; }
    if (current?.status !== 'ready' || outgoing && previous?.status !== 'ready') { publish('loading'); return; }
    // Paint only a matching pair. A seek or a slow decoder must not mix a new
    // transition position with a frame left over from another timeline instant.
    if (current.shot !== shot || current.timeUs !== sample.localTimeUs || current.playing !== sourcePlaying) { publish('loading'); return; }
    if (outgoing && (previous?.status !== 'ready' || previous.shot !== outgoing || previous.timeUs !== sample.outgoing?.localTimeUs || previous.playing)) { publish('loading'); return; }
    const width = buffered?.width ?? current.canvas.width, height = buffered?.height ?? current.canvas.height;
    if (target.width !== width) target.width = width;
    if (target.height !== height) target.height = height;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    if (sample.effect && previous?.status === 'ready') {
      ctx.drawImage(previous.canvas, 0, 0, width, height);
      ctx.save();
      if (sample.effect.kind === 'fade') ctx.globalAlpha = sample.effect.progress;
      else {
        // FFmpeg's wipeleft assigns the boundary column to the outgoing image.
        const startX = wipeLeftIncomingStartX(width, sample.effect.outgoingProgress);
        ctx.beginPath(); ctx.rect(startX, 0, width - startX, height); ctx.clip();
      }
      ctx.drawImage(current.canvas, 0, 0, width, height);
      ctx.restore();
    } else ctx.drawImage(current.canvas, 0, 0, width, height);
    drawSceneCaptions(target, previewSceneFrame(project, shot, sample.shotIndex), sample.localTimeUs);
    target.dataset.renderedTimeUs = String(sample.timeUs);
    target.dataset.renderedFrame = String(sample.frame);
    target.dataset.transition = sample.effect?.kind ?? 'cut';
    target.dataset.transitionBuffered = String(Boolean(buffered));
    target.dataset.transitionCachePixels = String(buffer?.retainedPixels ?? 0);
    presented.current = { project, shot, key, frame: sample.frame };
    publish('ready');
  }, []);

  const receive = useCallback((source: string, frame?: ScenePreviewFrame, preparation?: TransitionFrameBuffer) => {
    if (frame) frames.current.set(source, frame);
    else frames.current.delete(source);
    const current = latest.current;
    if (frame?.status === 'ready' && !frame.playing && preparation && preparation === current.buffer && frame.shot === current.preparationShot && frame.timeUs === preparation.nextSample?.timeUs) {
      const next = preparation.nextSample;
      if (next && preparation.capture(next.frame, frame.canvas) && preparationTimer.current?.buffer !== preparation) {
        if (preparationTimer.current) clearTimeout(preparationTimer.current.timer);
        const timer = setTimeout(() => {
          preparationTimer.current = undefined;
          if (latest.current.buffer === preparation) setPreparationVersion(value => value + 1);
        }, 0);
        preparationTimer.current = { buffer: preparation, timer };
      }
    }
    paint();
    clock.refreshFrameGate(gate);
  }, [paint, clock, gate]);
  useLayoutEffect(() => { paint(); clock.refreshFrameGate(gate); }, [paint, clock, gate, project, draft, timeUs, key, sourcePlaying]);
  const error = state.key === key && state.status === 'error' ? state.error : undefined;
  const loading = state.key !== key || state.status === 'loading';
  const hasPicture = Boolean(presented.current);
  const initialLoading = loading && !hasPicture;
  const showBuffering = useBufferingIndicator(loading && hasPicture && !error, key);
  const repairShot = state.shot ?? shot;
  return <span className="scene-preview timeline-preview" aria-busy={loading || Boolean(buffering)}>
    <canvas ref={canvas} role="img" aria-label={`${shot?.title ?? ''} · 镜头预览`} style={error || initialLoading ? { visibility: 'hidden' } : undefined} />
    <ScenePreviewState loading={initialLoading} error={error} onRetry={() => setRetry(value => value + 1)} onRepair={repairShot && onRepair ? () => onRepair(repairShot) : undefined} />
    {showBuffering && !error && <span className="timeline-preview__buffering" role="status"><LoaderCircle className="spin" size={14} aria-hidden="true" />正在准备画面…</span>}
    {outgoing && sample?.outgoing && <PreviewSource key={sourceKey(outgoing)} sourceKey={sourceKey(outgoing)} project={project} shot={outgoing} shotIndex={sample.outgoing.shotIndex} assets={assets} timeUs={sample.outgoing.localTimeUs} playing={false} onFrame={receive} />}
    {shot && sample && <PreviewSource key={sourceKey(shot)} sourceKey={sourceKey(shot)} project={project} shot={shot} shotIndex={sample.shotIndex} assets={assets} timeUs={sample.effect && buffer ? preparedTimeUs : sample.localTimeUs} playing={sourcePlaying} buffering={buffering} preparation={sample.effect ? buffer : undefined} onFrame={receive} />}
    {nextShot && nextClip && <PreviewSource key={sourceKey(nextShot)} sourceKey={sourceKey(nextShot)} project={project} shot={nextShot} shotIndex={nextClip.index} assets={assets} timeUs={buffer ? preparedTimeUs : nextClip.phaseUs} playing={false} preparation={buffer} onFrame={receive} />}
  </span>;
});
