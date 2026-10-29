import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { drawSceneFrame } from '@video-quickly/video';
import type { AssetRecord, ProjectDocument, Shot } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';
import { CircleAlert, LoaderCircle, RefreshCw, Upload } from 'lucide-react';
import { createPreviewVideoController, loadPreviewImage, previewAssetKey } from './preview-media';

interface ScenePreviewProps {
  project: ProjectDocument;
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
  const [mediaError, setMediaError] = useState<{ key: string; message: string }>();
  const [retry, setRetry] = useState(0);
  const imageAsset = useMemo(() => !shot.videoAssetId ? assets.find(asset => asset.id === shot.assetId) : undefined, [assets, shot.assetId, shot.videoAssetId]);
  const videoAsset = useMemo(() => assets.find(asset => asset.id === shot.videoAssetId), [assets, shot.videoAssetId]);
  const imageKey = imageAsset ? previewAssetKey(imageAsset) : `missing:${shot.assetId ?? ''}`;
  const videoKey = videoAsset ? previewAssetKey(videoAsset) : `missing:${shot.videoAssetId ?? ''}`;
  const mediaKey = `${shot.videoAssetId ? videoKey : imageKey}:${retry}`;
  const activeImage = !shot.videoAssetId && image?.key === mediaKey ? image.element : undefined;
  const activeVideo = video?.key === mediaKey ? video.element : undefined;
  const error = mediaError?.key === mediaKey ? mediaError.message : '';
  const loading = !error && (shot.videoAssetId ? !activeVideo : shot.assetId ? !activeImage : false);
  const fps = project.profile.frameRate.numerator / project.profile.frameRate.denominator;
  const profile = useMemo(() => {
    const scale = Math.min(project.profile.previewScale, (thumbnail ? 420 : 1280) / project.profile.width);
    return { ...project.profile, width: Math.max(64, Math.round(project.profile.width * scale)), height: Math.max(64, Math.round(project.profile.height * scale)) };
  }, [project.profile.width, project.profile.height, project.profile.previewScale, project.profile.fitMode, project.profile.frameRate.numerator, project.profile.frameRate.denominator, thumbnail]);

  const requestRender = useCallback(() => {
    if (pendingFrame.current !== undefined || document.hidden) return;
    pendingFrame.current = requestAnimationFrame(() => {
      pendingFrame.current = undefined;
      draw.current();
    });
  }, []);

  useEffect(() => {
    if (!shot.assetId || shot.videoAssetId) return;
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
  }, [imageKey, shot.assetId, shot.videoAssetId, retry]);

  useEffect(() => {
    if (!shot.videoAssetId) return;
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
  }, [videoKey, shot.videoAssetId, retry, thumbnail, requestRender]);

  useEffect(() => {
    videoController.current?.synchronize(timeUs, playing && !thumbnail, fps);
  }, [videoKey, video, timeUs, playing, thumbnail, fps]);

  useEffect(() => {
    draw.current = () => {
      const target = canvas.current;
      if (!target || error || loading) return;
      if (shot.videoAssetId && (!activeVideo || activeVideo.readyState < 2 || activeVideo.seeking)) return;
      if (target.width !== profile.width) target.width = profile.width;
      if (target.height !== profile.height) target.height = profile.height;
      drawSceneFrame(target, { title: shot.title, narration: shot.narration, shotIndex, profile, durationUs: shot.durationUs, animation: shot.animation, image: activeVideo && activeVideo.readyState >= 2 ? activeVideo : activeImage }, timeUs);
    };
    requestRender();
  }, [profile, shot.title, shot.narration, shot.durationUs, shot.videoAssetId, shot.animation, shotIndex, timeUs, activeImage, activeVideo, error, loading, requestRender]);

  useEffect(() => {
    document.addEventListener('visibilitychange', requestRender);
    return () => {
      document.removeEventListener('visibilitychange', requestRender);
      if (pendingFrame.current !== undefined) cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
    };
  }, [requestRender]);

  return <span className={`scene-preview ${thumbnail ? 'scene-preview--thumbnail' : ''}`} aria-busy={loading}><canvas ref={canvas} className={className} role="img" aria-label={`${shot.title} · 镜头预览`} style={error || loading ? { visibility: 'hidden' } : undefined} />{(error || loading) && <span className="scene-preview__state" role={error ? 'alert' : 'status'}>{error ? <CircleAlert size={thumbnail ? 18 : 27} /> : <LoaderCircle className="spin" size={thumbnail ? 18 : 27} />}<strong>{error || '正在读取素材…'}</strong>{error && !thumbnail && <><span>检查源文件，或为这个镜头重新导入素材。</span><span className="scene-preview__actions"><button type="button" onClick={() => setRetry(value => value + 1)}><RefreshCw size={15} />重新读取</button>{onRepair && <button type="button" onClick={onRepair}><Upload size={15} />重新导入</button>}</span></>}</span>}</span>;
});
