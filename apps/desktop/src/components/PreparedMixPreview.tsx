import { useEffect, useRef, useState } from 'react';
import { Pause, Play, SkipBack, Volume2, VolumeX } from 'lucide-react';
import { audioLevelWindowSchema, type AudioLevelWindow, type PreparedAudioMix } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';
import { Button, IconButton, Notice, formatTime } from './Primitives';
import AudioLevelMeter from './AudioLevelMeter';
import './audio-processing.css';

export type ReadAudioLevels = (mix: PreparedAudioMix, startUs: number, durationUs: number, signal?: AbortSignal) => Promise<AudioLevelWindow>;
export interface PreparedMixPreviewProps {
  mix: PreparedAudioMix;
  onLevels: ReadAudioLevels;
  playing?: boolean;
  timeUs?: number;
  muted?: boolean;
  controls?: boolean;
  onError?: (message: string, error?: boolean) => void;
  onReadyChange?: (ready: boolean) => void;
}

export default function PreparedMixPreview({ mix, onLevels, playing, timeUs, muted, controls = true, onError, onReadyChange }: PreparedMixPreviewProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const [localTimeUs, setLocalTimeUs] = useState(0), [localPlaying, setLocalPlaying] = useState(false), [localMuted, setLocalMuted] = useState(false);
  const [ready, setReady] = useState(false), [audioFailure, setAudioFailure] = useState(''), [audioRetry, setAudioRetry] = useState(0), [levelRetry, setLevelRetry] = useState(0);
  const [levels, setLevels] = useState<{ identity: string; startUs: number; window?: AudioLevelWindow; error?: string }>();
  const synchronize = useRef<(() => void) | undefined>(undefined), alive = useRef(true);
  const controlled = playing !== undefined && timeUs !== undefined;
  const currentTimeUs = controlled ? timeUs : localTimeUs;
  const levelTimeUs = Math.max(0, Math.min(mix.durationUs - 1, currentTimeUs));
  const windowStartUs = Math.floor(levelTimeUs / 10_000_000) * 10_000_000;
  const identity = JSON.stringify([mix.key, mix.sha256, mix.path, mix.durationUs]);
  const latest = useRef({ controlled, playing, timeUs: currentTimeUs, muted: muted ?? localMuted, onError, onLevels, onReadyChange });
  latest.current = { controlled, playing, timeUs: currentTimeUs, muted: muted ?? localMuted, onError, onLevels, onReadyChange };
  const latestIdentity = useRef(identity); latestIdentity.current = identity;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    let active = true, pendingPlay = false;
    setReady(false); latest.current.onReadyChange?.(false); setAudioFailure(''); setLocalTimeUs(0); setLocalPlaying(false);
    function fail(message: string) { if (!active) return; setAudioFailure(message); setReady(false); latest.current.onReadyChange?.(false); latest.current.onError?.(message, true); }
    function sync() {
      if (!active || !element) return;
      const state = latest.current; element.muted = state.muted;
      if (element.readyState < 1 || !Number.isFinite(element.duration)) return;
      const target = Math.min(Math.max(0, state.timeUs / 1e6), Math.max(0, element.duration - .001));
      if (Math.abs(element.currentTime - target) > (state.controlled && state.playing ? .15 : .001)) element.currentTime = target;
      if (!state.controlled) return;
      if (!state.playing) { element.pause(); return; }
      if (element.paused && !pendingPlay) {
        pendingPlay = true;
        void element.play().catch(error => { if (active && latest.current.playing && !(error instanceof Error && error.name === 'AbortError')) fail('处理后的混音暂时无法播放，请暂停后重试。'); }).finally(() => { pendingPlay = false; });
      }
    }
    const metadata = () => { if (active) { setReady(true); latest.current.onReadyChange?.(true); sync(); } };
    const updateTime = () => { if (active) setLocalTimeUs(Math.round(element.currentTime * 1e6)); };
    const updatePlaying = () => { if (active) setLocalPlaying(!element.paused && !element.ended); };
    const mediaError = () => fail('处理后的混音无法读取或解码，请重新载入试听音频。');
    element.addEventListener('loadedmetadata', metadata); element.addEventListener('timeupdate', updateTime); element.addEventListener('seeked', updateTime); element.addEventListener('play', updatePlaying); element.addEventListener('pause', updatePlaying); element.addEventListener('ended', updatePlaying); element.addEventListener('error', mediaError);
    synchronize.current = sync;
    void getAssetUrl(mix.path).then(url => { if (active) { element.src = url; element.load(); } }).catch(() => fail('处理后的混音路径无法读取，请重新载入试听音频。'));
    return () => {
      active = false; synchronize.current = undefined; latest.current.onReadyChange?.(false);
      element.removeEventListener('loadedmetadata', metadata); element.removeEventListener('timeupdate', updateTime); element.removeEventListener('seeked', updateTime); element.removeEventListener('play', updatePlaying); element.removeEventListener('pause', updatePlaying); element.removeEventListener('ended', updatePlaying); element.removeEventListener('error', mediaError);
      element.pause(); element.removeAttribute('src'); element.load();
    };
  }, [identity, audioRetry]);
  useEffect(() => { synchronize.current?.(); }, [playing, timeUs, muted, localMuted]);
  useEffect(() => {
    if (controlled || !localPlaying) return;
    let request: number;
    const update = () => { if (audio.current) setLocalTimeUs(Math.round(audio.current.currentTime * 1e6)); request = requestAnimationFrame(update); };
    request = requestAnimationFrame(update);
    return () => cancelAnimationFrame(request);
  }, [controlled, localPlaying, identity]);

  useEffect(() => {
    const controller = new AbortController();
    const durationUs = Math.min(10_000_000, mix.durationUs - windowStartUs);
    void latest.current.onLevels(mix, windowStartUs, durationUs, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const window = audioLevelWindowSchema.parse(value);
      if (window.key !== mix.key || window.startUs !== windowStartUs || !window.samples.length) throw new Error('电平数据与当前处理后的混音不匹配。');
      setLevels({ identity, startUs: windowStartUs, window });
    }).catch(error => { if (!controller.signal.aborted) setLevels({ identity, startUs: windowStartUs, error: error instanceof Error ? error.message : String(error) }); });
    return () => controller.abort();
  }, [identity, windowStartUs, levelRetry]);
  const currentLevels = levels?.identity === identity && levels.startUs === windowStartUs ? levels : undefined;
  async function toggle() {
    const element = audio.current; if (!element || !ready || controlled) return;
    if (!element.paused) { element.pause(); return; }
    if (element.ended || element.currentTime >= element.duration - .001) element.currentTime = 0;
    const captured = identity;
    try { await element.play(); } catch (error) { if (alive.current && latestIdentity.current === captured && !(error instanceof Error && error.name === 'AbortError')) { setAudioFailure('处理后的混音暂时无法播放，请重新载入后重试。'); onError?.('处理后的混音暂时无法播放，请重新载入后重试。', true); } }
  }
  function seek(valueUs: number) { if (audio.current && ready) { audio.current.currentTime = valueUs / 1e6; setLocalTimeUs(valueUs); } }
  return <div className={`prepared-mix-preview ${controls ? '' : 'prepared-mix-preview--compact'}`} data-mix-key={mix.key} data-status={audioFailure ? 'error' : ready ? 'ready' : 'loading'}>
    <audio ref={audio} preload="metadata" data-audio-role="处理后混音" hidden />
    {controls && <div className="prepared-mix-preview__controls"><IconButton label="试听回到开头" disabled={!ready} onClick={() => seek(0)}><SkipBack size={15} /></IconButton><Button disabled={!ready || controlled} onClick={() => void toggle()}>{localPlaying ? <Pause size={15} /> : <Play size={15} />}{localPlaying ? '暂停处理试听' : '播放处理试听'}</Button><input type="range" aria-label="试听播放位置" aria-valuetext={formatTime(currentTimeUs)} min={0} max={Math.ceil(mix.durationUs / 1000)} step={10} value={Math.round(currentTimeUs / 1000)} disabled={!ready || controlled} onChange={event => seek(Math.min(mix.durationUs - 1, Number(event.target.value) * 1000))} /><span>{formatTime(currentTimeUs)} / {formatTime(mix.durationUs)}</span><IconButton label={(muted ?? localMuted) ? '开启处理试听声音' : '静音处理试听'} aria-pressed={muted ?? localMuted} disabled={muted !== undefined} onClick={() => setLocalMuted(value => !value)}>{(muted ?? localMuted) ? <VolumeX size={15} /> : <Volume2 size={15} />}</IconButton></div>}
    {audioFailure ? <Notice kind="error">{audioFailure}<Button variant="ghost" onClick={() => setAudioRetry(value => value + 1)}>重新载入试听音频</Button></Notice> : !ready && <p className="tiny-meta" role="status">正在载入处理后的混音…</p>}
    <AudioLevelMeter window={currentLevels?.window} timeUs={levelTimeUs} analysis={mix.analysis} loading={!currentLevels} error={currentLevels?.error} onRetry={() => setLevelRetry(value => value + 1)} compact={!controls} />
    {mix.warnings.length > 0 && <ul className="prepared-mix-preview__warnings">{mix.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
  </div>;
}
