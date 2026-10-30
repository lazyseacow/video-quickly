import { memo, useCallback, useEffect, useState } from 'react';
import { Film, Maximize2, Pause, Play, Settings2, SkipBack, SkipForward, Volume2, VolumeX, Plus } from 'lucide-react';
import { frameAtTime, type AssetRecord, type PreparedAudioMix, type ProjectDocument, type Shot, usesVideoAudio } from '@video-quickly/contracts';
import { type TimelineClip } from '@video-quickly/video';
import { PlaybackClock, usePlayback } from '../lib/playback';
import { Button, EmptyState, IconButton, Notice, formatTime } from './Primitives';
import { ScenePreview } from './ScenePreview';
import PreparedMixPreview, { type ReadAudioLevels } from './PreparedMixPreview';

interface Props {
  project: ProjectDocument; draft?: Shot; assets: AssetRecord[]; timeline: TimelineClip[];
  audioMix: { status: 'idle' | 'pending' | 'ready' | 'error'; mix?: PreparedAudioMix; error?: string; retry: () => void };
  onLevels: ReadAudioLevels; onPlayableChange: (ready: boolean) => void;
  clock: PlaybackClock; onSettings: () => void; onRepair: (shot: Shot) => void;
  onSelect: (id: string) => Promise<void>; onAdd: () => Promise<void>; onError: (message: string, error?: boolean) => void;
}

export default memo(function PlaybackPreview({ project, draft, assets, timeline, audioMix, onLevels, onPlayableChange, clock, onSettings, onRepair, onSelect, onAdd, onError }: Props) {
  const { playing, timeUs } = usePlayback(clock);
  const [muted, setMuted] = useState(false);
  const [readyKey, setReadyKey] = useState('');
  const mix = audioMix.status === 'ready' ? audioMix.mix : undefined;
  const playable = audioMix.status === 'idle' || Boolean(mix && readyKey === mix.key);
  const mixReady = useCallback((ready: boolean) => setReadyKey(ready && mix ? mix.key : ''), [mix?.key]);
  const mixFailure = useCallback((message: string, error?: boolean) => { clock.pause(); onError(message, error); }, [clock, onError]);
  useEffect(() => { if (!playable) clock.pause(); onPlayableChange(playable); }, [playable, clock, onPlayableChange]);
  const clip = timeline.find(item => timeUs >= item.startUs && timeUs < item.endUs) ?? timeline.at(-1);
  const source = clip ? project.shots[clip.index] : project.shots[0];
  const shot = draft?.id === source?.id ? draft : source;
  const localTimeUs = Math.max(0, timeUs - (clip?.startUs ?? 0));
  const { profile } = project;
  const includesVideoAudio = project.shots.some(usesVideoAudio);
  useEffect(() => {
    const pauseWhenHidden = () => { if (document.hidden) clock.pause(); };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, [clock]);
  return <section className="preview-panel">
    <div className="preview-toolbar"><span>画面预览</span><span className="sample-chip"><span className="online-dot" />{shot?.sceneTemplate ? '科普图解' : shot?.videoAssetId ? '视频素材' : shot?.assetId ? '本地素材' : '本地示例'}</span><IconButton label="编辑视频规格" onClick={onSettings}><Maximize2 size={14} /></IconButton></div>
    <div className="preview-surface">{shot ? <div className="preview-frame" style={{ aspectRatio: `${profile.width} / ${profile.height}`, width: `min(100cqw, calc(100cqh * ${profile.width / profile.height}))` }}><ScenePreview project={project} shot={shot} shotIndex={clip?.index ?? 0} assets={assets} playing={playing} timeUs={localTimeUs} onRepair={() => { clock.pause(); onRepair(shot); }} /></div> : <EmptyState icon={<Film size={26} />} title="你的故事从第一镜开始" description="添加镜头，填写旁白和画面要求。"><Button onClick={() => void onAdd()}><Plus size={15} />添加镜头</Button></EmptyState>}</div>
    <div className="preview-audio">{mix ? <PreparedMixPreview mix={mix} onLevels={onLevels} controls={false} playing={playing && playable} timeUs={timeUs} muted={muted} onReadyChange={mixReady} onError={mixFailure} /> : audioMix.status === 'pending' ? <p className="tiny-meta" role="status">正在准备预览混音…</p> : audioMix.status === 'error' ? <Notice kind="error">{audioMix.error}<Button aria-label="重新准备预览混音" onClick={audioMix.retry}>重新准备</Button></Notice> : null}</div>
    <div className="preview-controls"><IconButton label="回到开头" onClick={() => clock.seek(0)}><SkipBack size={15} /></IconButton><IconButton label={playing ? '暂停预览' : '播放预览'} aria-pressed={playing} disabled={!project.shots.length || !playable} onClick={clock.toggle}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}</IconButton><IconButton label="下一镜头" disabled={!project.shots.length} onClick={() => { const next = project.shots[((clip?.index ?? 0) + 1) % project.shots.length]; if (next) void onSelect(next.id); }}><SkipForward size={15} /></IconButton><span className="timecode"><b>{formatTime(timeUs)}</b> / {formatTime(timeline.at(-1)?.endUs ?? 0)}<small>第 {frameAtTime(timeUs, profile.frameRate) + 1} 帧</small></span><IconButton label={project.musicClips?.length || includesVideoAudio ? muted ? '开启预览声音' : '静音预览声音' : muted ? '开启旁白声音' : '静音旁白'} aria-pressed={muted} onClick={() => setMuted(value => !value)}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</IconButton><span className="preview-settings">预览 {Math.round(profile.previewScale * 100)}%</span><IconButton label="预览设置" onClick={onSettings}><Settings2 size={14} /></IconButton></div>
  </section>;
});
