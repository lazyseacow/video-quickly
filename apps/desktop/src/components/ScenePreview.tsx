import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { drawSceneFrame, type SceneFrame } from '@video-quickly/video';
import { resolveShotSpans, resolveShotTime } from '@video-quickly/video/clip-edits';
import { captionsEnabled, effectiveCaptionStyle, type AssetRecord, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';
import { CircleAlert, LoaderCircle, RefreshCw, Upload } from 'lucide-react';
import { createPreviewVideoController, loadPreviewImage, previewAssetKey } from './preview-media';
import { Button } from './Primitives';
import { videoThumbnails, type ThumbnailFrame } from './preview-thumbnails';
import { useThumbnailVisibility } from './thumbnail-visibility';
import { assetAvailabilityUrl, useAssetAvailabilityKey } from '../lib/asset-availability';

export type ScenePreviewProject = Pick<ProjectDocument, 'profile'> & Partial<Pick<ProjectDocument, 'captionStyle' | 'clipEditSources' | 'clipEditPlans'>> & { workflow?: Pick<ProjectDocument['workflow'], 'production'> };

export type ScenePreviewFrame =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; canvas: HTMLCanvasElement; shot: Shot; timeUs: number; playing: boolean };

export function previewSceneFrame(project: ScenePreviewProject, shot: Shot, shotIndex: number, profile = project.profile, image?: CanvasImageSource): SceneFrame {
  return { title: shot.title, narration: shot.narration, sceneTemplate: shot.sceneTemplate, captionTrack: captionsEnabled(project) ? shot.captionTrack : { timeBase: 'scene', alignment: 'manual', cues: [] }, clipEdit: shot.clipEdit, clipEditContext: project, sourceInUs: shot.sourceInUs, audioInUs: shot.audioInUs, videoInUs: shot.videoInUs, shotIndex, sceneIndex: shot.sceneIndex, profile, durationUs: shot.durationUs, sceneInUs: shot.sceneInUs, sceneDurationUs: shot.sceneDurationUs, animation: shot.animation, image, captionStyle: effectiveCaptionStyle(project, shot) };
}

interface ScenePreviewProps {
  project: ScenePreviewProject;
  shot: Shot;
  shotIndex: number;
  timeUs?: number;
  className?: string;
  thumbnail?: boolean;
  assets?: AssetRecord[];
  playing?: boolean;
  buffering?: boolean;
  onRepair?: () => void;
  /** Supplies caption-free, detached frames to the timeline compositor. */
  frameSink?: (frame: ScenePreviewFrame) => void;
}

const NO_ASSETS: AssetRecord[] = [];

export function ScenePreviewState({ error, loading, thumbnail = false, onRetry, onRepair }: { error?: string; loading: boolean; thumbnail?: boolean; onRetry: () => void; onRepair?: () => void }) {
  if (!error && !loading) return null;
  return <span className="scene-preview__state" role={error ? 'alert' : 'status'}>{error ? <CircleAlert size={thumbnail ? 18 : 27} /> : <LoaderCircle className="spin" size={thumbnail ? 18 : 27} />}<strong>{error || '正在读取素材…'}</strong>{error && !thumbnail && <><span>检查源文件，或为这个镜头重新导入素材。</span><span className="scene-preview__actions"><Button onClick={onRetry}><RefreshCw size={14} />重新读取</Button>{onRepair && <Button onClick={onRepair}><Upload size={14} />重新导入</Button>}</span></>}</span>;
}

type PreviewPropKey = Exclude<keyof ScenePreviewProps, 'project'>;
type PreviewProjectKey = keyof ScenePreviewProps['project'];
const previewPropKeys = Object.keys({
  shot: true, shotIndex: true, timeUs: true, className: true, thumbnail: true, assets: true, playing: true, buffering: true, onRepair: true, frameSink: true,
} satisfies Record<PreviewPropKey, true>) as PreviewPropKey[];
const previewProjectKeys = Object.keys({
  profile: true, captionStyle: true, clipEditSources: true, clipEditPlans: true, workflow: true,
} satisfies Record<PreviewProjectKey, true>) as PreviewProjectKey[];

function samePreviewProps(previous: ScenePreviewProps, next: ScenePreviewProps) {
  for (const key of previewPropKeys) if (!Object.is(previous[key], next[key])) return false;
  if (previous.project === next.project) return true;
  for (const key of previewProjectKeys) {
    if (!Object.is(previous.project[key], next.project[key])) return false;
  }
  return true;
}

export const ScenePreview = memo(function ScenePreview({ project, shot, shotIndex, timeUs = 0, className = '', thumbnail = false, assets = NO_ASSETS, playing = false, buffering = false, onRepair, frameSink }: ScenePreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const detachedCanvas = useRef<HTMLCanvasElement | undefined>(undefined);
  const pendingFrame = useRef<number | undefined>(undefined);
  const draw = useRef(() => {});
  const videoController = useRef<ReturnType<typeof createPreviewVideoController> | undefined>(undefined);
  const previousImageRetry = useRef(0);
  const [image, setImage] = useState<{ key: string; element: HTMLImageElement }>();
  const [video, setVideo] = useState<{ key: string; element: HTMLVideoElement }>();
  const [still, setStill] = useState<{ key: string; frame: ThumbnailFrame }>();
  const { container, visible } = useThumbnailVisibility(thumbnail);
  const [mediaError, setMediaError] = useState<{ key: string; message: string }>();
  const [retry, setRetry] = useState(0);
  const templateActive = Boolean(shot.sceneTemplate);
  const hasVideo = !templateActive && Boolean(shot.videoAssetId);
  const hasImage = !templateActive && !hasVideo && Boolean(shot.assetId);
  const imageAsset = useMemo(() => hasImage ? assets.find(asset => asset.id === shot.assetId) : undefined, [assets, shot.assetId, hasImage]);
  const videoAsset = useMemo(() => hasVideo ? assets.find(asset => asset.id === shot.videoAssetId) : undefined, [assets, shot.videoAssetId, hasVideo]);
  useAssetAvailabilityKey([imageAsset?.id, videoAsset?.id]);
  const imageKey = imageAsset ? previewAssetKey(imageAsset) : `missing:${shot.assetId ?? ''}`;
  const videoKey = videoAsset ? previewAssetKey(videoAsset) : `missing:${shot.videoAssetId ?? ''}`;
  const mediaKey = `${templateActive ? 'template' : hasVideo ? videoKey : imageKey}:${retry}`;
  const activeImage = hasImage && image?.key === mediaKey ? image.element : undefined;
  const activeVideo = hasVideo && video?.key === mediaKey ? video.element : undefined;
  const fps = project.profile.frameRate.numerator / project.profile.frameRate.denominator;
  let resolutionError = '', resolvedTime = { videoUs: 0, discontinuityKey: 'invalid', spanIndex: 0 };
  try { resolvedTime = resolveShotTime(shot, project, timeUs); }
  catch (failure) { resolutionError = failure instanceof Error ? failure.message : String(failure); }
  // Re-anchor the decoder when handing a sampled transition back to native playback.
  const discontinuityKey = JSON.stringify([shot.id, shot.sourceInUs, shot.videoInUs, resolvedTime.discontinuityKey, frameSink ? playing : undefined]);
  const videoSpans = useMemo(() => {
    if (!shot.clipEdit) return [];
    try { return resolveShotSpans(shot, project); } catch { return []; }
  }, [shot.clipEdit, shot.durationUs, project.clipEditSources, project.clipEditPlans]);
  const videoSpan = videoSpans.find(span => span.spanIndex === resolvedTime.spanIndex);
  const videoRange = videoSpan ? { startUs: videoSpan.videoInUs, endUs: videoSpan.videoInUs + videoSpan.durationUs } : undefined;
  const captionStyle = effectiveCaptionStyle(project, shot);
  const profile = useMemo(() => {
    const scale = Math.min(project.profile.previewScale, (thumbnail ? 420 : 1280) / project.profile.width);
    return { ...project.profile, width: Math.max(64, Math.round(project.profile.width * scale)), height: Math.max(64, Math.round(project.profile.height * scale)) };
  }, [project.profile.width, project.profile.height, project.profile.previewScale, project.profile.fitMode, project.profile.frameRate.numerator, project.profile.frameRate.denominator, thumbnail]);
  const thumbnailKey = JSON.stringify([mediaKey, resolvedTime.videoUs, profile.width, profile.height]);
  const activeStill = still?.key === thumbnailKey ? still.frame : undefined;
  const mediaErrorKey = thumbnail && hasVideo ? thumbnailKey : mediaKey;
  const error = visible ? resolutionError || (!templateActive && mediaError?.key === mediaErrorKey ? mediaError.message : '') : '';
  const loading = visible && !error && (hasVideo ? thumbnail ? !activeStill : !activeVideo : hasImage ? !activeImage : false);
  const frameSize = useRef({ width: profile.width, height: profile.height }); frameSize.current = profile;
  const frameSource = Boolean(frameSink);

  const requestRender = useCallback(() => {
    if (document.hidden) return;
    if (frameSource) { draw.current(); return; }
    if (pendingFrame.current !== undefined || document.hidden) return;
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = undefined;
      draw.current();
    });
  }, [frameSource]);

  useEffect(() => {
    if (!visible) { setImage(undefined); return; }
    if (!hasImage) return;
    if (!imageAsset) { setMediaError({ key: mediaKey, message: '未找到镜头图片素材' }); return; }
    let active = true;
    setMediaError(undefined);
    const refresh = previousImageRetry.current !== retry;
    previousImageRetry.current = retry;
    void loadPreviewImage(imageAsset, refresh).then(element => {
      if (active) setImage({ key: mediaKey, element });
    }).catch(() => {
      if (active) setMediaError({ key: mediaKey, message: '图片素材无法读取或解码' });
    });
    return () => { active = false; };
  }, [imageKey, shot.assetId, hasImage, retry, visible]);

  useEffect(() => {
    if (!thumbnail || !hasVideo) return;
    if (!visible) { setStill(undefined); return; }
    if (!videoAsset) { setMediaError({ key: mediaErrorKey, message: '未找到镜头视频素材' }); return; }
    if (resolutionError) return;
    const controller = new AbortController(); setMediaError(undefined);
    void videoThumbnails.read({ asset: videoAsset, timeUs: resolvedTime.videoUs, width: profile.width, height: profile.height }, controller.signal)
      .then(frame => { if (!controller.signal.aborted) setStill({ key: thumbnailKey, frame }); })
      .catch(error => { if (!controller.signal.aborted) setMediaError({ key: mediaErrorKey, message: error instanceof Error ? error.message : '视频缩略图无法读取' }); });
    return () => controller.abort();
  }, [thumbnail, visible, hasVideo, videoKey, resolvedTime.videoUs, profile.width, profile.height, thumbnailKey, resolutionError]);

  useLayoutEffect(() => {
    if (!hasVideo || thumbnail) return;
    if (!videoAsset) { setMediaError({ key: mediaKey, message: '未找到镜头视频素材' }); return; }
    let active = true;
    setMediaError(undefined);
    const element = document.createElement('video');
    element.muted = true;
    element.playsInline = true;
    element.preload = thumbnail ? 'metadata' : 'auto';
    const controller = createPreviewVideoController(element, {
      onReady: () => { if (active) setVideo({ key: mediaKey, element }); },
      onFrame: requestRender,
      onError: message => { if (active) setMediaError({ key: mediaKey, message }); },
      frameSize: () => frameSize.current,
    });
    videoController.current = controller;
    void getAssetUrl(videoAsset.path).then(url => {
      if (active) { element.src = assetAvailabilityUrl(url, videoAsset.id); element.load(); }
    }).catch(() => { if (active) setMediaError({ key: mediaKey, message: '视频素材无法读取' }); });
    return () => {
      active = false;
      controller.dispose();
      if (videoController.current === controller) videoController.current = undefined;
    };
  }, [videoKey, shot.videoAssetId, hasVideo, retry, thumbnail, requestRender]);

  useLayoutEffect(() => {
    videoController.current?.synchronize(resolvedTime.videoUs, playing && !buffering && !thumbnail && !resolutionError, fps, discontinuityKey, videoRange);
  }, [videoKey, video, resolvedTime.videoUs, discontinuityKey, videoRange?.startUs, videoRange?.endUs, resolutionError, playing, buffering, thumbnail, fps]);

  useLayoutEffect(() => {
    if (error) frameSink?.({ status: 'error', message: error });
    else if (loading) frameSink?.({ status: 'loading' });
  }, [frameSink, error, loading]);

  useLayoutEffect(() => {
    draw.current = () => {
      const target = frameSink ? detachedCanvas.current ??= document.createElement('canvas') : canvas.current;
      if (!target) return;
      if (!visible) { target.width = target.height = 1; return; }
      if (error || loading) return;
      if (hasVideo && !thumbnail && (!activeVideo || activeVideo.readyState < 2 || activeVideo.seeking)) return;
      const videoFrame = thumbnail ? activeStill?.image : activeVideo ? videoController.current?.frameForPaint(videoRange) : undefined;
      if (hasVideo && !videoFrame) return;
      if (target.width !== profile.width) target.width = profile.width;
      if (target.height !== profile.height) target.height = profile.height;
      drawSceneFrame(target, previewSceneFrame(project, shot, shotIndex, profile, videoFrame ?? activeImage), timeUs, { captions: !frameSink, mediaOnly: hasVideo && !shot.animation.keyframes?.length });
      frameSink?.({ status: 'ready', canvas: target, shot, timeUs, playing });
    };
    requestRender();
  }, [profile, shot, project.workflow?.production?.subtitleMode, project.clipEditSources, project.clipEditPlans, hasVideo, shotIndex, timeUs, activeImage, activeVideo, activeStill, thumbnail, visible, videoRange?.startUs, videoRange?.endUs, error, loading, captionStyle, requestRender, frameSink, buffering, playing]);

  useEffect(() => {
    document.addEventListener('visibilitychange', requestRender);
    return () => {
      document.removeEventListener('visibilitychange', requestRender);
      if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
      if (detachedCanvas.current) detachedCanvas.current.width = detachedCanvas.current.height = 0;
    };
  }, [requestRender]);

  if (frameSink) return null;
  return <span ref={container} className={`scene-preview ${thumbnail ? 'scene-preview--thumbnail' : ''}`} aria-busy={loading}><canvas ref={canvas} className={className} role="img" aria-label={`${shot.title} · 镜头预览`} style={error || loading ? { visibility: 'hidden' } : undefined} /><ScenePreviewState error={error} loading={loading} thumbnail={thumbnail} onRetry={() => setRetry(value => value + 1)} onRepair={onRepair} /></span>;
}, samePreviewProps);
