import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { Film, Maximize, Minimize, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX, Plus } from 'lucide-react';
import { frameAtTime, timeAtFrame, type AssetRecord, type PreparedAudioMix, type ProjectDocument, type Shot, usesVideoAudio } from '@video-quickly/contracts';
import { type TimelineClip } from '@video-quickly/video';
import { PlaybackClock, usePlayback } from '../lib/playback';
import { desktopBridge } from '../lib/desktop';
import { beginGuideAction } from '../lib/guide-actions';
import { Button, EmptyState, IconButton, Notice, Select, formatTime } from './Primitives';
import { TimelinePreview } from './TimelinePreview';
import PreparedMixPreview, { type ReadAudioLevels } from './PreparedMixPreview';
import './playback-preview.css';

interface Props {
  project: ProjectDocument; draft?: Shot; assets: AssetRecord[]; timeline: TimelineClip[];
  audioMix: { status: 'idle' | 'pending' | 'ready' | 'error'; mix?: PreparedAudioMix; error?: string; retry: () => void };
  onLevels: ReadAudioLevels; onPlayableChange: (ready: boolean) => void;
  clock: PlaybackClock; onRepair?: (shot: Shot) => void;
  onSelect: (id: string) => void | Promise<void>; onAdd: () => Promise<void>; onError: (message: string, error?: boolean) => void;
  productionView?: { active: boolean; toggle: () => void };
}

export default memo(function PlaybackPreview({ project, draft, assets, timeline, audioMix, onLevels, onPlayableChange, clock, onRepair, onSelect, onAdd, onError, productionView }: Props) {
  const { playing, timeUs, buffering } = usePlayback(clock);
  const player = useRef<HTMLElement>(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const pendingFullscreenExit = useRef<symbol | undefined>(undefined);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideControls = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoveringControls = useRef(false);
  const scrubbing = useRef<{ pointerId: number; resume: boolean } | undefined>(undefined);
  const [quality, setQuality] = useState<number | undefined>(() => {
    const stored = Number(localStorage.getItem('vq-preview-scale'));
    return [.25, .5, 1].includes(stored) ? stored : undefined;
  });
  const previewScale = quality ?? project.profile.previewScale;
  const previewProject = useMemo(() => ({ ...project, profile: { ...project.profile, previewScale } }), [project, previewScale]);
  const [readyKey, setReadyKey] = useState('');
  const mix = audioMix.status === 'ready' ? audioMix.mix : undefined;
  const live = Boolean(productionView?.active);
  const mixPlayable = Boolean(mix && readyKey === mix.key);
  const playable = live || audioMix.status === 'idle' || mixPlayable;
  const mixReady = useCallback((ready: boolean) => setReadyKey(ready && mix ? mix.key : ''), [mix?.key]);
  const mixFailure = useCallback((message: string, error?: boolean) => { if (!live) clock.pause(); onError(message, error); }, [clock, onError, live]);
  function togglePlayback() {
    if (!playable || !project.shots.length) return;
    const completed = beginGuideAction('preview-played');
    clock.toggle();
    if (clock.getSnapshot().playing) completed();
  }
  function revealControls() {
    clearTimeout(hideControls.current);
    setControlsVisible(true);
    if (clock.getSnapshot().playing && !hoveringControls.current) hideControls.current = setTimeout(() => setControlsVisible(false), 2200);
  }
  useEffect(() => { revealControls(); return () => clearTimeout(hideControls.current); }, [playing]);
  useEffect(() => {
    const update = () => {
      const ownsFullscreen = Boolean(player.current && document.fullscreenElement === player.current);
      if (!ownsFullscreen) pendingFullscreenExit.current = undefined;
      setFullscreen(ownsFullscreen);
    };
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  async function toggleFullscreen(exiting = document.fullscreenElement === player.current) {
    const element = player.current;
    if (!element || pendingFullscreenExit.current || exiting !== (document.fullscreenElement === element)) return;
    const exit = exiting ? Symbol() : undefined;
    if (exit) pendingFullscreenExit.current = exit;
    const isCurrentExit = () => pendingFullscreenExit.current === exit && player.current === element && document.fullscreenElement === element;
    try {
      if (!exit) {
        await element.requestFullscreen();
        return;
      }
      const waitForNativeEntry = desktopBridge()?.waitForNativeFullscreenEntry;
      if (waitForNativeEntry) await waitForNativeEntry();
      if (isCurrentExit()) await document.exitFullscreen();
    } catch {
      if (exit ? isCurrentExit() : player.current === element) onError('无法切换全屏预览，请重试。', true);
    } finally {
      if (exit && pendingFullscreenExit.current === exit) pendingFullscreenExit.current = undefined;
    }
  }
  function toggleMuted() {
    if (!volume) { setVolume(1); setMuted(false); }
    else setMuted(value => !value);
  }
  function clickPicture(event: MouseEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest('button, input, select, a')) return;
    player.current?.focus({ preventScroll: true });
    togglePlayback();
  }
  function seekFrame(frame: number) {
    const resume = clock.getSnapshot().playing;
    clock.seek(timeAtFrame(frame, project.profile.frameRate));
    if (resume && playable) clock.toggle();
  }
  function startScrubbing(event: PointerEvent<HTMLInputElement>) {
    scrubbing.current = { pointerId: event.pointerId, resume: clock.getSnapshot().playing };
    clock.pause();
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function finishScrubbing(event: PointerEvent<HTMLInputElement>) {
    if (scrubbing.current?.pointerId !== event.pointerId) return;
    const { resume } = scrubbing.current;
    scrubbing.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (resume && playable && !clock.getSnapshot().playing) clock.toggle();
  }
  useEffect(() => { if (!playable) clock.pause(); onPlayableChange(playable); }, [playable, clock, onPlayableChange]);
  const clip = timeline.find(item => timeUs >= item.startUs && timeUs < item.endUs) ?? timeline.at(-1);
  const source = clip ? project.shots[clip.index] : project.shots[0];
  const shot = draft?.id === source?.id ? draft : source;
  const { profile } = project;
  const totalUs = timeline.at(-1)?.endUs ?? 0;
  const lastFrame = frameAtTime(clock.lastTimeUs, profile.frameRate);
  const frame = frameAtTime(timeUs, profile.frameRate);
  const progressStyle: CSSProperties & { '--preview-progress': string } = { '--preview-progress': `${lastFrame ? frame / lastFrame * 100 : 0}%` };
  const silent = muted || !volume;
  const includesVideoAudio = project.shots.some(usesVideoAudio);
  useEffect(() => {
    const pauseWhenHidden = () => { if (document.hidden) clock.pause(); };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, [clock]);
  return <section ref={player} data-guide="preview" className="preview-panel preview-player" aria-label="视频预览播放器" tabIndex={0} data-controls-visible={!playing || controlsVisible} onPointerMove={revealControls} onKeyDown={event => {
    if (event.target !== event.currentTarget || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.code === 'KeyF') { event.preventDefault(); if (!event.repeat) void toggleFullscreen(); }
    if (event.code === 'KeyM') { event.preventDefault(); if (!event.repeat) toggleMuted(); }
  }}>
    <div className="preview-surface" onClick={clickPicture}>{shot ? <div className="preview-frame" style={{ aspectRatio: `${profile.width} / ${profile.height}`, width: `min(100cqw, calc(100cqh * ${profile.width / profile.height}))` }}><TimelinePreview project={previewProject} draft={draft} assets={assets} clock={clock} playing={playing} buffering={buffering} timeUs={timeUs} onRepair={onRepair && (target => { clock.pause(); onRepair(target); })} /></div> : <EmptyState icon={<Film size={26} />} title="你的故事从第一镜开始" description="添加镜头，填写旁白和画面要求。"><Button onClick={() => void onAdd()}><Plus size={15} />添加镜头</Button></EmptyState>}</div>
    <div className="preview-toolbar preview-chrome" onPointerEnter={() => { hoveringControls.current = true; revealControls(); }} onPointerLeave={() => { hoveringControls.current = false; revealControls(); }}>
      <span>{live ? '制作预览' : '画面预览'}</span><span className="sample-chip"><span className="online-dot" />{shot?.sceneTemplate ? '科普图解' : shot?.videoAssetId ? '视频素材' : shot?.assetId ? '本地素材' : live ? '待生成' : '默认画面'}</span>
      {productionView && <Button static variant="ghost" className="preview-source-toggle" onClick={productionView.toggle}>{live ? '编辑项目' : '制作预览'}</Button>}
    </div>
    <div className="preview-audio">{mix ? <PreparedMixPreview mix={mix} onLevels={onLevels} controls={false} showLevels={false} playing={playing && !buffering && mixPlayable} timeUs={timeUs} muted={silent} volume={volume} onReadyChange={mixReady} onError={mixFailure} /> : audioMix.status === 'pending' ? <p className="tiny-meta" role="status">正在准备预览混音…</p> : audioMix.status === 'error' ? <Notice kind="error">{audioMix.error}<Button aria-label="重新准备预览混音" onClick={audioMix.retry}>重新准备</Button></Notice> : null}</div>
    <div className="preview-controls preview-chrome" onPointerEnter={() => { hoveringControls.current = true; revealControls(); }} onPointerLeave={() => { hoveringControls.current = false; revealControls(); }}>
      <input className="preview-seek" type="range" aria-label="播放器播放位置" aria-valuetext={`${formatTime(timeUs)} / ${formatTime(totalUs)}`} min={0} max={lastFrame} step={1} value={frame} disabled={!totalUs} style={progressStyle} onChange={event => seekFrame(event.target.valueAsNumber)} onPointerDown={startScrubbing} onPointerUp={finishScrubbing} onPointerCancel={finishScrubbing} onLostPointerCapture={finishScrubbing} />
      <div className="preview-controls__row">
        <IconButton label={playing ? '暂停预览' : '播放预览'} aria-pressed={playing} disabled={!project.shots.length || !playable} onClick={togglePlayback}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}</IconButton>
        <IconButton className="preview-skip" label="回到开头" disabled={!project.shots.length} onClick={() => clock.seek(0)}><SkipBack size={16} /></IconButton>
        <IconButton className="preview-skip" label="下一镜头" disabled={!project.shots.length} onClick={() => { const next = project.shots[((clip?.index ?? 0) + 1) % project.shots.length]; if (next) void onSelect(next.id); }}><SkipForward size={16} /></IconButton>
        <span className="timecode"><b>{formatTime(timeUs)}</b><span> / {formatTime(totalUs)}</span></span>
        <div className="preview-volume">
          <IconButton label={project.musicClips?.length || includesVideoAudio ? silent ? '开启预览声音' : '静音预览声音' : silent ? '开启旁白声音' : '静音旁白'} aria-pressed={silent} onClick={toggleMuted}>{silent ? <VolumeX size={17} /> : <Volume2 size={17} />}</IconButton>
          <span className="preview-volume__slider">
            <input type="range" aria-label="预览音量" aria-valuetext={`${Math.round((silent ? 0 : volume) * 100)}%`} min={0} max={1} step={0.05} value={silent ? 0 : volume} onChange={event => { setVolume(event.target.valueAsNumber); setMuted(false); }} />
          </span>
        </div>
        <label className="preview-quality-control"><span className="preview-quality-label">清晰度</span><Select className="preview-quality" aria-label="预览质量" title="预览清晰度" value={previewScale} onChange={event => { const value = Number(event.target.value); setQuality(value); localStorage.setItem('vq-preview-scale', String(value)); }}><option value="0.25">流畅</option><option value="0.5">平衡</option><option value="1">原画</option></Select></label>
        <IconButton label={fullscreen ? '退出全屏预览' : '全屏预览'} aria-pressed={fullscreen} disabled={!document.fullscreenEnabled} onClick={() => void toggleFullscreen(fullscreen)}>{fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}</IconButton>
      </div>
    </div>
  </section>;
});
