import { useEffect, useRef, useState } from 'react';
import { Headphones } from 'lucide-react';
import { audioMixSettingsSchema, audioProcessingSchema, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, DEFAULT_VIDEO_AUDIO, preparedAudioMixSchema, type AudioMixSettings, type AudioProcessing, type PreparedAudioMix, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { Button, Dialog, Field, Notice } from './Primitives';
import type { AudioProcessingValue } from '../lib/audio-edits';
import PreparedMixPreview, { type ReadAudioLevels } from './PreparedMixPreview';
import './audio-processing.css';

export type { AudioProcessingValue } from '../lib/audio-edits';
export interface AudioProcessingDialogProps {
  project: ProjectDocument;
  shot?: Shot;
  disabled?: boolean;
  onClose: () => void;
  onApply: (value: AudioProcessingValue, baseline: ProjectDocument) => Promise<boolean>;
  onPreview: (value: AudioProcessingValue, baseline: ProjectDocument, signal: AbortSignal) => Promise<PreparedAudioMix>;
  onLevels: ReadAudioLevels;
}

export default function AudioProcessingDialog({ project, shot, disabled = false, onClose, onApply, onPreview, onLevels }: AudioProcessingDialogProps) {
  const [baseline] = useState(() => structuredClone(project)), [target] = useState(() => shot ? structuredClone(shot) : undefined);
  const [mix, setMix] = useState(() => audioMixSettingsSchema.parse(project.audioMix ?? DEFAULT_AUDIO_MIX_SETTINGS));
  const [processing, setProcessing] = useState(() => audioProcessingSchema.parse(shot?.audioProcessing ?? DEFAULT_AUDIO_PROCESSING));
  const videoAudio = processing.version === 2 ? processing.videoAudio : DEFAULT_VIDEO_AUDIO;
  const [gainEnabled, setGainEnabled] = useState(processing.gainDb !== 0);
  const [applying, setApplying] = useState(false), [preparing, setPreparing] = useState(false), [failure, setFailure] = useState(''), [previewFailure, setPreviewFailure] = useState('');
  const [preview, setPreview] = useState<{ input: string; mix: PreparedAudioMix }>();
  const alive = useRef(true), controller = useRef<AbortController | undefined>(undefined);
  const value: AudioProcessingValue = target ? { scope: 'shot', shot: { id: target.id, processing: { ...processing, gainDb: gainEnabled ? processing.gainDb : 0 } } } : { scope: 'project', mix };
  const input = JSON.stringify(value), latestInput = useRef(input); latestInput.current = input;
  const parsed = target ? audioProcessingSchema.safeParse(value.scope === 'shot' ? value.shot.processing : processing) : audioMixSettingsSchema.safeParse(mix);
  const currentPreview = preview?.input === input ? preview.mix : undefined;
  const frozen = disabled || applying;
  const locked = Boolean(target?.locked);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { controller.current?.abort(); setPreparing(false); setPreviewFailure(''); }, [input]);

  function changeMix(next: AudioMixSettings) { setMix(next); setFailure(''); }
  function changeProcessing(next: AudioProcessing) { setProcessing(next); setFailure(''); }
  async function prepare() {
    if (!parsed.success) return;
    controller.current?.abort(); const operation = new AbortController(); controller.current = operation;
    const captured = input; setPreparing(true); setPreviewFailure(''); setPreview(undefined);
    try {
      const result = preparedAudioMixSchema.parse(await onPreview(value, baseline, operation.signal));
      if (alive.current && !operation.signal.aborted && latestInput.current === captured) setPreview({ input: captured, mix: result });
    } catch (error) { if (alive.current && !operation.signal.aborted) setPreviewFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current && controller.current === operation) { controller.current = undefined; setPreparing(false); } }
  }
  async function apply() {
    if (!parsed.success || locked) return;
    controller.current?.abort(); setPreparing(false); setApplying(true); setFailure('');
    try { if (await onApply(value, baseline)) { if (alive.current) onClose(); } else if (alive.current) setFailure('声音设置尚未保存，当前输入已保留，可重试。'); }
    catch (error) { if (alive.current) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setApplying(false); }
  }
  return <Dialog title={target ? '镜头声音处理' : '项目混音设置'} className="audio-processing-dialog" onClose={onClose}>
    <div className="dialog__body"><p className="audio-processing-dialog__scope">{target ? `${target.title}：调整这一镜头的旁白与视频原声。` : '调整整段项目的混音。'} 试听与成片使用相同处理，应用为一步撤销。</p>
      <div className="audio-processing-dialog__workspace"><fieldset className="audio-processing-fields" disabled={frozen}>
        {target ? <>
          <label className="field-inline"><input type="checkbox" checked={gainEnabled} onChange={event => { setGainEnabled(event.target.checked); setFailure(''); }} />调整旁白增益</label>
          <Field label="旁白增益（dB）" hint="关闭后保持原音量（0 dB）。"><input type="number" min={-60} max={18} step={.5} value={Number.isFinite(processing.gainDb) ? processing.gainDb : ''} disabled={!gainEnabled} onChange={event => changeProcessing({ ...processing, gainDb: event.target.valueAsNumber })} /></Field>
          <label className="field-inline"><input type="checkbox" checked={processing.denoise} onChange={event => changeProcessing({ ...processing, denoise: event.target.checked })} />启用旁白降噪</label>
          <Field label="降噪量（dB）"><input type="number" min={3} max={40} step={1} value={Number.isFinite(processing.noiseReductionDb) ? processing.noiseReductionDb : ''} disabled={!processing.denoise} onChange={event => changeProcessing({ ...processing, noiseReductionDb: event.target.valueAsNumber })} /></Field>
          {!target.audioAssetId && <p className="tiny-meta">当前镜头尚未关联旁白音频；设置会在添加配音后生效。</p>}
          <label className="field-inline"><input type="checkbox" checked={videoAudio.enabled} onChange={event => changeProcessing({ ...processing, version: 2, videoAudio: { ...videoAudio, enabled: event.target.checked } })} />启用视频原声</label>
          <Field label="视频原声增益（dB）" hint="使用首条音轨，跟随视频入点与剪辑范围。"><input type="number" min={-60} max={18} step={.5} value={Number.isFinite(videoAudio.gainDb) ? videoAudio.gainDb : ''} disabled={!videoAudio.enabled} onChange={event => changeProcessing({ ...processing, version: 2, videoAudio: { ...videoAudio, gainDb: event.target.valueAsNumber } })} /></Field>
          {!target.videoAssetId && <p className="tiny-meta">当前镜头尚未关联视频；原声设置会在添加视频后生效。</p>}
        </> : <>
          <label className="field-inline"><input type="checkbox" checked={mix.loudness.enabled} onChange={event => changeMix({ ...mix, loudness: { ...mix.loudness, enabled: event.target.checked } })} />统一混音响度</label>
          <div className="audio-processing-fields__row"><Field label="目标响度（LUFS）"><input type="number" min={-30} max={-9} step={.5} value={Number.isFinite(mix.loudness.targetLufs) ? mix.loudness.targetLufs : ''} disabled={!mix.loudness.enabled} onChange={event => changeMix({ ...mix, loudness: { ...mix.loudness, targetLufs: event.target.valueAsNumber } })} /></Field><Field label="真峰值上限（dBTP）"><input type="number" min={-6} max={-.1} step={.1} value={Number.isFinite(mix.loudness.truePeakDb) ? mix.loudness.truePeakDb : ''} disabled={!mix.loudness.enabled} onChange={event => changeMix({ ...mix, loudness: { ...mix.loudness, truePeakDb: event.target.valueAsNumber } })} /></Field></div>
          <label className="field-inline"><input type="checkbox" checked={mix.ducking.enabled} onChange={event => changeMix({ ...mix, ducking: { ...mix.ducking, enabled: event.target.checked } })} />旁白出现时压低背景音乐</label>
          <div className="audio-processing-fields__row">{([{ key: 'thresholdDb', label: '压低触发阈值（dB）', min: -60, max: -6, step: 1 }, { key: 'ratio', label: '压低比例', min: 1, max: 20, step: .5 }, { key: 'attackMs', label: '起效时间（毫秒）', min: 1, max: 200, step: 1 }, { key: 'releaseMs', label: '恢复时间（毫秒）', min: 20, max: 2000, step: 10 }] as const).map(field => <Field label={field.label} key={field.key}><input type="number" min={field.min} max={field.max} step={field.step} value={Number.isFinite(mix.ducking[field.key]) ? mix.ducking[field.key] : ''} disabled={!mix.ducking.enabled} onChange={event => changeMix({ ...mix, ducking: { ...mix.ducking, [field.key]: event.target.valueAsNumber } })} /></Field>)}</div>
          <p className="tiny-meta">压低音乐需要项目中同时存在旁白和背景音乐。</p>
        </>}
        <Button aria-label="恢复默认声音设置" variant="ghost" disabled={frozen} onClick={() => { if (target) { setProcessing(structuredClone(DEFAULT_AUDIO_PROCESSING)); setGainEnabled(false); } else setMix(structuredClone(DEFAULT_AUDIO_MIX_SETTINGS)); setFailure(''); }}>恢复默认</Button>
      </fieldset><div className="audio-processing-audition"><div className="audio-processing-audition__heading"><Headphones size={16} /><strong>处理后试听</strong></div><p className="tiny-meta">先准备实际混音，再使用播放器试听。试听不修改项目。</p><Button aria-label="试听处理" busy={preparing} disabled={frozen || !parsed.success} onClick={() => void prepare()}>试听</Button>{preparing && <p className="tiny-meta" role="status">正在准备处理后的混音…关闭窗口会停止等待。</p>}{preview && !currentPreview && <p className="tiny-meta">设置已改变，请重新试听处理。</p>}{previewFailure && <Notice kind="error">{previewFailure}</Notice>}{currentPreview && <PreparedMixPreview mix={currentPreview} onLevels={onLevels} />}</div></div>
      {!parsed.success && <Notice kind="error">{parsed.error.issues[0]?.message ?? '声音参数无效，请核对输入。'}</Notice>}{locked && <Notice>当前镜头已锁定，请先解锁后应用声音设置。</Notice>}{failure && <Notice kind="error">{failure}</Notice>}
    </div><div className="dialog__footer"><Button onClick={onClose}>{applying ? '关闭并继续保存' : '取消'}</Button><Button aria-label="应用声音设置" variant="primary" busy={applying} disabled={disabled || !parsed.success || locked} onClick={() => void apply()}>应用</Button></div>
  </Dialog>;
}
