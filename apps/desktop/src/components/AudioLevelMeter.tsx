import type { AudioLevelWindow, PreparedAudioMix } from '@video-quickly/contracts';
import { Button } from './Primitives';
import './audio-processing.css';

export interface AudioLevelMeterProps {
  window?: AudioLevelWindow;
  timeUs: number;
  analysis?: PreparedAudioMix['analysis'];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  compact?: boolean;
}

function decibels(amplitude: number) { return amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity; }
function levelText(value: number | undefined) { return value === undefined ? '—' : value === -Infinity ? '−∞' : value.toFixed(1); }

export default function AudioLevelMeter({ window, timeUs, analysis, loading = false, error, onRetry, compact = false }: AudioLevelMeterProps) {
  const index = window ? Math.floor((timeUs - window.startUs) / window.periodUs) : -1;
  const sample = window?.samples[index];
  const channels = [{ id: 'left', label: '左声道', short: 'L', peak: sample ? decibels(sample.peakLeft) : undefined, rms: sample ? decibels(sample.rmsLeft) : undefined }, { id: 'right', label: '右声道', short: 'R', peak: sample ? decibels(sample.peakRight) : undefined, rms: sample ? decibels(sample.rmsRight) : undefined }];
  return <div className={`audio-level-meter ${compact ? 'audio-level-meter--compact' : ''}`} aria-label="节目电平（静音前）" data-status={error ? 'error' : loading || !sample ? 'loading' : 'ready'}>
    <div className="audio-level-meter__heading"><strong>节目电平（静音前）</strong><span>峰值 / RMS · dBFS</span></div>
    {error ? <div className="audio-level-meter__error" role="status"><span>{error}</span>{onRetry && <Button variant="ghost" onClick={onRetry}>重新读取电平</Button>}</div> : <>
      {channels.map(channel => <div className="audio-level-meter__channel" key={channel.id}><span aria-label={channel.label}>{channel.short}</span><meter aria-label={`${channel.label}峰值（dBFS）`} aria-valuetext={sample ? `${levelText(channel.peak)} dBFS` : '电平尚未读取'} min={-60} max={6} low={-12} high={0} optimum={-18} value={channel.peak === undefined ? -60 : Math.max(-60, Math.min(6, channel.peak))} /><output aria-label={`${channel.label}峰值与RMS`} className={channel.peak !== undefined && channel.peak > 0 ? 'audio-level-meter__over' : ''}>{levelText(channel.peak)} / {levelText(channel.rms)}</output></div>)}
      {(loading || !sample) && <span className="audio-level-meter__pending" role="status">正在读取实际电平…</span>}
    </>}
    {analysis && <p className="audio-level-meter__analysis">整段实测响度 <output aria-label="整段实测响度">{analysis.integratedLufs === undefined ? '未测得' : `${analysis.integratedLufs.toFixed(1)} LUFS`}</output><span>真峰值 {analysis.truePeakDb === undefined ? '未测得' : `${analysis.truePeakDb.toFixed(1)} dBTP`}</span></p>}
  </div>;
}
