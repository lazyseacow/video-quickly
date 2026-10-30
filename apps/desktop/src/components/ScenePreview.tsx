import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { citationOverlayForShot, createCitationManifest, drawSceneFrame } from '@video-quickly/video';
import { resolveShotSpans, resolveShotTime } from '@video-quickly/video/clip-edits';
import { effectiveCaptionStyle, type AssetRecord, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';
import { CircleAlert, LoaderCircle, RefreshCw, Upload } from 'lucide-react';
import { createPreviewVideoController, loadPreviewImage, previewAssetKey } from './preview-media';
import { Button } from './Primitives';
import { videoThumbnails, type ThumbnailFrame } from './preview-thumbnails';
import { useThumbnailVisibility } from './thumbnail-visibility';

interface ScenePreviewProps {
  project: Pick<ProjectDocument, 'profile'> & Partial<Pick<ProjectDocument, 'claims' | 'researchSources' | 'referenceDisplay' | 'shots' | 'captionStyle' | 'clipEditSources' | 'clipEditPlans'>>;
  shot: Shot;
  shotIndex: number;
  timeUs?: number;
  className?: string;
  thumbnail?: boolean;
  assets?: AssetRecord[];
  playing?: boolean;
  onRepair?: () => void;
}

const NO_ASSETS: AssetRecord[] = [];

export const ScenePreview = memo(function ScenePreview({ project, shot, shotIndex, timeUs = 0, className = '', thumbnail = false, assets = NO_ASSETS, playing = false, onRepair }: ScenePreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
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
  const imageKey = imageAsset ? previewAssetKey(imageAsset) : `missing:${shot.assetId ?? ''}`;
  const videoKey = videoAsset ? previewAssetKey(videoAsset) : `missing:${shot.videoAssetId ?? ''}`;
  const mediaKey = `${templateActive ? 'template' : hasVideo ? videoKey : imageKey}:${retry}`;
  const activeImage = hasImage && image?.key === mediaKey ? image.element : undefined;
  const activeVideo = hasVideo && video?.key === mediaKey ? video.element : undefined;
  const fps = project.profile.frameRate.numerator / project.profile.frameRate.denominator;
  let resolutionError = '', resolvedTime = { videoUs: 0, discontinuityKey: 'invalid', spanIndex: 0 };
  try { resolvedTime = resolveShotTime(shot, project, timeUs); }
  catch (failure) { resolutionError = failure instanceof Error ? failure.message : String(failure); }
  const discontinuityKey = JSON.stringify([shot.id, shot.sourceInUs, shot.videoInUs, resolvedTime.discontinuityKey]);
  const videoSpans = useMemo(() => {
    if (!shot.clipEdit) return [];
    try { return resolveShotSpans(shot, project); } catch { return []; }
  }, [shot.clipEdit, shot.durationUs, project.clipEditSources, project.clipEditPlans]);
  const videoSpan = videoSpans.find(span => span.spanIndex === resolvedTime.spanIndex);
  const videoRange = videoSpan ? { startUs: videoSpan.videoInUs, endUs: videoSpan.videoInUs + videoSpan.durationUs } : undefined;
  const citation = useMemo(() => project.referenceDisplay === 'numbers' ? citationOverlayForShot(createCitationManifest({ claims: project.claims ?? [], researchSources: project.researchSources, referenceDisplay: project.referenceDisplay, shots: [shot] }), shot.id) : undefined, [project.claims, project.researchSources, project.referenceDisplay, shot.id, shot.claimIds]);
  const referenceFooter = project.referenceDisplay === 'numbers' && (project.shots ?? [shot]).some(shot => shot.claimIds.length > 0);
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

  const requestRender = useCallback(() => {
    if (pendingFrame.current !== undefined || document.hidden) return;
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = undefined;
      draw.current();
    });
  }, []);

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

  useEffect(() => {
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
      if (active) { element.src = url; element.load(); }
    }).catch(() => { if (active) setMediaError({ key: mediaKey, message: '视频素材无法读取' }); });
    return () => {
      active = false;
      controller.dispose();
      if (videoController.current === controller) videoController.current = undefined;
    };
  }, [videoKey, shot.videoAssetId, hasVideo, retry, thumbnail, requestRender]);

  useEffect(() => {
    videoController.current?.synchronize(resolvedTime.videoUs, playing && !thumbnail && !resolutionError, fps, discontinuityKey, videoRange);
  }, [videoKey, video, resolvedTime.videoUs, discontinuityKey, videoRange?.startUs, videoRange?.endUs, resolutionError, playing, thumbnail, fps]);

  useEffect(() => {
    draw.current = () => {
      const target = canvas.current;
      if (!target) return;
      if (!visible) { target.width = target.height = 1; return; }
      if (error || loading) return;
      if (hasVideo && !thumbnail && (!activeVideo || activeVideo.readyState < 2 || activeVideo.seeking)) return;
      const videoFrame = thumbnail ? activeStill?.image : activeVideo ? videoController.current?.frameForPaint(videoRange) : undefined;
      if (hasVideo && !videoFrame) return;
      if (target.width !== profile.width) target.width = profile.width;
      if (target.height !== profile.height) target.height = profile.height;
      drawSceneFrame(target, { title: shot.title, narration: shot.narration, sceneTemplate: shot.sceneTemplate, captionTrack: shot.captionTrack, clipEdit: shot.clipEdit, clipEditContext: project, sourceInUs: shot.sourceInUs, audioInUs: shot.audioInUs, videoInUs: shot.videoInUs, shotIndex, sceneIndex: shot.sceneIndex, profile, durationUs: shot.durationUs, sceneInUs: shot.sceneInUs, sceneDurationUs: shot.sceneDurationUs, animation: shot.animation, image: videoFrame ?? activeImage, citation, referenceFooter, captionStyle }, timeUs);
    };
    requestRender();
  }, [profile, shot.title, shot.narration, shot.sceneTemplate, shot.captionTrack, shot.clipEdit, project.clipEditSources, project.clipEditPlans, shot.sourceInUs, shot.audioInUs, shot.videoInUs, shot.durationUs, shot.sceneInUs, shot.sceneDurationUs, hasVideo, shot.animation, shotIndex, shot.sceneIndex, timeUs, activeImage, activeVideo, activeStill, thumbnail, visible, videoRange?.startUs, videoRange?.endUs, error, loading, citation, referenceFooter, captionStyle, requestRender]);

  useEffect(() => {
    document.addEventListener('visibilitychange', requestRender);
    return () => {
      document.removeEventListener('visibilitychange', requestRender);
      if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
    };
  }, [requestRender]);

  return <span ref={container} className={`scene-preview ${thumbnail ? 'scene-preview--thumbnail' : ''}`} aria-busy={loading}><canvas ref={canvas} className={className} role="img" aria-label={`${shot.title} · 镜头预览`} style={error || loading ? { visibility: 'hidden' } : undefined} />{(error || loading) && <span className="scene-preview__state" role={error ? 'alert' : 'status'}>{error ? <CircleAlert size={thumbnail ? 18 : 27} /> : <LoaderCircle className="spin" size={thumbnail ? 18 : 27} />}<strong>{error || '正在读取素材…'}</strong>{error && !thumbnail && <><span>检查源文件，或为这个镜头重新导入素材。</span><span className="scene-preview__actions"><Button onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />重新读取</Button>{onRepair && <Button onClick={onRepair}><Upload size={14} />重新导入</Button>}</span></>}</span>}</span>;
});
