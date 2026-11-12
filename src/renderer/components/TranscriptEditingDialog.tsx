import { useEffect, useMemo, useRef, useState } from 'react';
import { Headphones, LocateFixed, Volume2, VolumeX, RotateCcw, Plus, Pause, Play } from 'lucide-react';
import { preparedAudioMixSchema, silenceDetectionSchema, type AssetRecord, type PreparedAudioMix, type ProjectDocument, type Shot, type SilenceDetection } from '@video-quickly/contracts';
import type { ClipRange } from '@video-quickly/video/clip-edits';
import { PlaybackClock, usePlayback } from '../lib/playback';
import { previewTranscriptEdit, projectSilenceRanges, transcriptMixOffset, transcriptPreviewTime, transcriptRows, type TranscriptEditAction, type TranscriptSilenceOptions } from '../lib/transcript-edits';
import { Button, Dialog, Field, IconButton, Notice, formatTime } from './Primitives';
import { ScenePreview } from './ScenePreview';
import PreparedMixPreview, { type ReadAudioLevels } from './PreparedMixPreview';
import './transcript-editing.css';

export interface TranscriptEditingDialogProps {
  project: ProjectDocument;
  shot: Shot;
  assets: AssetRecord[];
  disabled?: boolean;
  onClose: () => void;
  onApply: (ranges: readonly ClipRange[], baseline: ProjectDocument, assetsBaseline: readonly AssetRecord[]) => Promise<boolean>;
  onRestore: (baseline: ProjectDocument, assetsBaseline: readonly AssetRecord[]) => Promise<boolean>;
  onDetect: (options: TranscriptSilenceOptions, baseline: ProjectDocument, signal: AbortSignal) => Promise<SilenceDetection>;
  onPreview: (candidate: ProjectDocument, signal: AbortSignal) => Promise<PreparedAudioMix>;
  onLevels: ReadAudioLevels;
}
interface RangeRow { id: string; label: string; range: ClipRange }

export default function TranscriptEditingDialog({ project, shot, assets, disabled = false, onClose, onApply, onRestore, onDetect, onPreview, onLevels }: TranscriptEditingDialogProps) {
  const [baseline] = useState(() => structuredClone(project)), [target] = useState(() => structuredClone(shot)), [assetsBaseline] = useState(() => structuredClone(assets));
  const [selected, setSelected] = useState(() => new Set<string>()), [manual, setManual] = useState<RangeRow[]>([]), [silence, setSilence] = useState<RangeRow[]>([]), [visibleCues, setVisibleCues] = useState(150);
  const [start, setStart] = useState('0'), [end, setEnd] = useState('1'), [restoring, setRestoring] = useState(false), [locate, setLocate] = useState({ timeUs: 0, version: 0 });
  const [detectOptions, setDetectOptions] = useState<TranscriptSilenceOptions>({ thresholdDb: -35, minimumDurationUs: 300_000, paddingUs: 80_000 });
  const [detecting, setDetecting] = useState(false), [detected, setDetected] = useState(false), [detectFailure, setDetectFailure] = useState('');
  const [preparing, setPreparing] = useState(false), [previewFailure, setPreviewFailure] = useState(''), [prepared, setPrepared] = useState<{ input: string; mix: PreparedAudioMix }>();
  const [applying, setApplying] = useState(false), [submitted, setSubmitted] = useState<TranscriptEditAction>(), [failure, setFailure] = useState('');
  const alive = useRef(true), detectController = useRef<AbortController | undefined>(undefined), previewController = useRef<AbortController | undefined>(undefined), previewPrefix = useRef(crypto.randomUUID());
  const rows = useMemo(() => transcriptRows(baseline, target.id, assetsBaseline), [baseline, target.id, assetsBaseline]);
  const cueRows = useMemo<RangeRow[]>(() => rows.cues.map((cue, index) => ({ id: `cue:${cue.id}`, label: `${rows.granularity === 'word' ? '词语' : '句段'} ${index + 1}：${cue.text}`, range: { startUs: cue.startUs, endUs: cue.endUs } })), [rows]);
  const available = [...cueRows, ...silence, ...manual], ranges = available.filter(row => selected.has(row.id)).map(row => row.range);
  const action: TranscriptEditAction = submitted ?? (restoring ? { kind: 'restore' } : { kind: 'delete', ranges });
  const input = JSON.stringify(action), latestInput = useRef(input); latestInput.current = input;
  const candidate = useMemo(() => {
    if (action.kind === 'delete' && !action.ranges.length) return { project: undefined, error: '' };
    try { let count = 0; return { project: previewTranscriptEdit(baseline, target.id, action, assetsBaseline, kind => `${previewPrefix.current}:${kind}:${++count}`), error: '' }; }
    catch (error) { return { project: undefined, error: error instanceof Error ? error.message : String(error) }; }
  }, [baseline, target.id, assetsBaseline, input]);
  const shownProject = candidate.project ?? baseline, shownShot = shownProject.shots.find(value => value.id === target.id) ?? target;
  const mix = prepared?.input === input ? prepared.mix : undefined;
  const frozen = disabled || applying || Boolean(submitted), locked = target.locked;
  const manualStartUs = Math.round(Number(start) * 1e6), manualEndUs = Math.round(Number(end) * 1e6);
  const manualValid = start.trim() !== '' && end.trim() !== '' && Number.isFinite(manualStartUs) && Number.isFinite(manualEndUs) && manualStartUs >= 0 && manualEndUs > manualStartUs && manualEndUs <= target.durationUs;
  const detectionValid = silenceDetectionSchema.safeParse({ ...detectOptions, assetId: target.audioAssetId ?? 'missing', sourceSha256: 'a'.repeat(64), ranges: [] }).success;
  const detectInput = JSON.stringify(detectOptions);
  useEffect(() => { alive.current = true; return () => { alive.current = false; detectController.current?.abort(); previewController.current?.abort(); }; }, []);
  useEffect(() => { previewController.current?.abort(); setPreparing(false); setPreviewFailure(''); setLocate(value => ({ timeUs: 0, version: value.version + 1 })); }, [input]);
  useEffect(() => { detectController.current?.abort(); setDetecting(false); setDetectFailure(''); setSilence([]); setDetected(false); setSelected(current => new Set([...current].filter(id => !id.startsWith('silence:')))); }, [detectInput]);
  function select(id: string, checked: boolean) { setSelected(current => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; }); setFailure(''); }
  function locateRange(timeUs: number) { setLocate(value => ({ timeUs: candidate.project ? transcriptPreviewTime(baseline, candidate.project, target.id, timeUs) : timeUs, version: value.version + 1 })); }
  function addManual() { if (!manualValid) return; const id = `manual:${crypto.randomUUID()}`; setManual(current => [...current, { id, label: `手选区间 ${current.length + 1}`, range: { startUs: manualStartUs, endUs: manualEndUs } }]); select(id, true); }
  async function detect() {
    if (!target.audioAssetId || !detectionValid) return;
    detectController.current?.abort(); const operation = new AbortController(); detectController.current = operation; setDetecting(true); setDetectFailure('');
    try {
      const result = silenceDetectionSchema.parse(await onDetect(detectOptions, baseline, operation.signal));
      if (result.thresholdDb !== detectOptions.thresholdDb || result.minimumDurationUs !== detectOptions.minimumDurationUs || result.paddingUs !== detectOptions.paddingUs) throw new Error('停顿检测参数与当前设置不一致，请重新检测。');
      const ranges = projectSilenceRanges(baseline, target.id, assetsBaseline, result);
      if (alive.current && !operation.signal.aborted) { setSilence(ranges.map((range, index) => ({ id: `silence:${index}`, label: `停顿候选 ${index + 1}`, range }))); setSelected(current => new Set([...current].filter(id => !id.startsWith('silence:')))); setDetected(true); }
    } catch (error) { if (alive.current && !operation.signal.aborted) setDetectFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current && detectController.current === operation) { detectController.current = undefined; setDetecting(false); } }
  }
  async function prepare() {
    if (!candidate.project) return;
    previewController.current?.abort(); const operation = new AbortController(); previewController.current = operation; const captured = input; setPreparing(true); setPreviewFailure(''); setPrepared(undefined);
    try { const result = preparedAudioMixSchema.parse(await onPreview(candidate.project, operation.signal)); transcriptMixOffset(candidate.project, result, target.id); if (alive.current && !operation.signal.aborted && latestInput.current === captured) setPrepared({ input: captured, mix: result }); }
    catch (error) { if (alive.current && !operation.signal.aborted) setPreviewFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current && previewController.current === operation) { previewController.current = undefined; setPreparing(false); } }
  }
  async function apply() {
    if (!candidate.project || locked) return;
    previewController.current?.abort(); detectController.current?.abort(); setPreparing(false); setDetecting(false); setApplying(true); setFailure('');
    const captured = structuredClone(action);
    try { const saved = captured.kind === 'restore' ? await onRestore(baseline, assetsBaseline) : await onApply(captured.ranges, baseline, assetsBaseline); if (!alive.current) return; if (saved) onClose(); else { setSubmitted(captured); setFailure('剪辑已加入当前草稿，尚未保存。重试只保存同一份剪辑，不新增撤销步骤。'); } }
    catch (error) { if (alive.current) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setApplying(false); }
  }
  return <Dialog title="文稿剪辑与停顿清理" onClose={onClose} className="transcript-editing-dialog"><div className="dialog__body">
    <div className="transcript-editing__scope"><strong>{target.title}</strong><span>当前 {formatTime(target.durationUs)}{candidate.project ? ` → ${formatTime(shownShot.durationUs)}` : ''}</span><p>删除会同步剪掉画面、旁白与字幕，后续镜头前移；背景音乐保持项目时间。按项目帧率向外对齐，剪后至少保留 0.5 秒。</p></div>
    <div className="transcript-editing__mode" role="group" aria-label="文稿剪辑方式"><Button aria-label="删除所选片段" aria-pressed={!restoring} disabled={frozen || locked} onClick={() => setRestoring(false)}>删除所选</Button><Button aria-pressed={restoring} disabled={frozen || locked || !target.clipEdit} onClick={() => setRestoring(true)}><RotateCcw size={14} />预览恢复源窗口</Button></div>
    <div className="transcript-editing__workspace"><div className="transcript-editing__form">
      {restoring ? <Notice>只恢复当前分割或裁剪后窗口的原始音视频与字幕，保留现有标题、画面模板和样式。</Notice> : <>
        <div className="transcript-editing__provenance">{rows.staleSpeech ? <Notice kind="error">旧识别字幕与当前旁白不匹配，请重新识别。仍可手选时间区间。</Notice> : rows.granularity === 'word' ? <p>真实逐词时间戳 · 来自当前旁白</p> : <p>{rows.alignment === 'estimated' ? '当前句段按文字估时，请试听核对。' : rows.alignment === 'manual' ? '当前句段为手工时间，请试听核对。' : '当前识别只提供逐句时间。'} 仅按整段或手选区间剪辑，不推算逐词时间。</p>}</div>
        <div className="transcript-editing__cues" role="group" aria-label={rows.granularity === 'word' ? '逐词文稿选择' : '句段文稿选择'}>{cueRows.slice(0, visibleCues).map(row => <RangeChoice key={row.id} row={row} checked={selected.has(row.id)} disabled={frozen || locked || rows.staleSpeech} onChange={checked => select(row.id, checked)} onLocate={() => locateRange(row.range.startUs)} />)}{!cueRows.length && <p className="tiny-meta">尚无字幕句段，可先识别语音，或手选时间区间。</p>}</div>
        {visibleCues < cueRows.length && <Button variant="ghost" onClick={() => setVisibleCues(value => value + 150)}>显示更多文稿（剩余 {cueRows.length - visibleCues} 项）</Button>}
        <fieldset className="transcript-editing__section" disabled={frozen || locked}><legend>手选删除区间</legend><div className="field-row"><Field label="删除区间入点（秒）"><input type="number" min={0} max={target.durationUs / 1e6} step={.001} value={start} onChange={event => setStart(event.target.value)} /></Field><Field label="删除区间出点（秒）"><input type="number" min={0} max={target.durationUs / 1e6} step={.001} value={end} onChange={event => setEnd(event.target.value)} /></Field></div><Button disabled={!manualValid} onClick={addManual}><Plus size={14} />添加删除区间</Button>{manual.map(row => <RangeChoice key={row.id} row={row} checked={selected.has(row.id)} disabled={frozen || locked} onChange={checked => select(row.id, checked)} onLocate={() => locateRange(row.range.startUs)} />)}</fieldset>
        <fieldset className="transcript-editing__section" disabled={frozen || locked}><legend>检测停顿候选</legend><p className="tiny-meta">从实际音频检测低于阈值的区间；识别文字之间的间隔不代表静音。候选需勾选后才删除。</p><div className="transcript-editing__detect-fields"><Field label="停顿检测阈值（dB）"><input type="number" min={-80} max={-10} step={1} value={Number.isFinite(detectOptions.thresholdDb) ? detectOptions.thresholdDb : ''} onChange={event => setDetectOptions({ ...detectOptions, thresholdDb: event.target.valueAsNumber })} /></Field><Field label="最短停顿（毫秒）"><input type="number" min={50} max={10000} step={50} value={Number.isFinite(detectOptions.minimumDurationUs) ? detectOptions.minimumDurationUs / 1000 : ''} onChange={event => setDetectOptions({ ...detectOptions, minimumDurationUs: Math.round(event.target.valueAsNumber * 1000) })} /></Field><Field label="停顿两端保留（毫秒）"><input type="number" min={0} max={1000} step={10} value={Number.isFinite(detectOptions.paddingUs) ? detectOptions.paddingUs / 1000 : ''} onChange={event => setDetectOptions({ ...detectOptions, paddingUs: Math.round(event.target.valueAsNumber * 1000) })} /></Field></div><Button aria-label="检测停顿" busy={detecting} disabled={!target.audioAssetId || !detectionValid} onClick={() => void detect()}>检测停顿</Button>{detected && !silence.length && <p className="tiny-meta" role="status">未检测到符合条件的停顿。</p>}{silence.map(row => <RangeChoice key={row.id} row={row} checked={selected.has(row.id)} disabled={frozen || locked} onChange={checked => select(row.id, checked)} onLocate={() => locateRange(row.range.startUs)} />)}{silence.length > 1 && <Button aria-label="全选停顿" variant="ghost" onClick={() => setSelected(current => new Set([...current, ...silence.map(row => row.id)]))}>全选停顿</Button>}{detectFailure && <Notice kind="error">{detectFailure}</Notice>}</fieldset>
      </>}
    </div><div className="transcript-editing__preview"><div className="transcript-editing__preview-heading"><Headphones size={15} /><strong>{candidate.project ? restoring ? '恢复预览' : '剪后预览' : '当前镜头'}</strong></div><TranscriptPreview key={input} project={shownProject} shot={shownShot} assets={assetsBaseline} mix={mix} onLevels={onLevels} locate={locate} disabled={applying} /><Button aria-label="准备试听" busy={preparing} disabled={disabled || applying || !candidate.project} onClick={() => void prepare()}>准备试听</Button>{preparing && <p className="tiny-meta" role="status">正在准备候选画面对应的混音…</p>}{prepared && !mix && <p className="tiny-meta">选区已改变，请重新准备试听。</p>}{previewFailure && <Notice kind="error">{previewFailure}</Notice>}</div></div>
    {candidate.error && <Notice kind="error">{candidate.error}</Notice>}{locked && <Notice>当前镜头已锁定，请先解锁后剪辑或恢复。</Notice>}{failure && <Notice kind="error">{failure}</Notice>}
  </div><div className="dialog__footer"><span>{restoring ? '恢复当前源窗口' : `已选 ${ranges.length} 个删除区间`}</span><Button onClick={onClose}>{applying ? '关闭并继续保存' : submitted ? '关闭并保留草稿' : '取消'}</Button><Button aria-label={submitted ? '重试保存剪辑' : restoring ? '确认恢复源窗口' : '应用删除区间'} variant="primary" busy={applying} disabled={disabled || locked || !candidate.project} onClick={() => void apply()}>{submitted ? "重试保存" : restoring ? "确认恢复" : "应用删除"}</Button></div></Dialog>;
}

function RangeChoice({ row, checked, disabled, onChange, onLocate }: { row: RangeRow; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void; onLocate: () => void }) {
  return <div className="transcript-range"><label><input type="checkbox" aria-label={`选择${row.label}`} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{row.label}</span><small>{(row.range.startUs / 1e6).toFixed(3)}–{(row.range.endUs / 1e6).toFixed(3)} 秒</small></label><IconButton label={`定位${row.label}`} onClick={onLocate}><LocateFixed size={14} /></IconButton></div>;
}

function TranscriptPreview({ project, shot, assets, mix, onLevels, locate, disabled }: { project: ProjectDocument; shot: Shot; assets: AssetRecord[]; mix?: PreparedAudioMix; onLevels: ReadAudioLevels; locate: {timeUs: number; version: number}; disabled: boolean }) {
  const [clock] = useState(() => new PlaybackClock(shot.durationUs, project.profile.frameRate)), [ready, setReady] = useState(false), [muted, setMuted] = useState(false);
  const { timeUs, playing } = usePlayback(clock);
  const index = project.shots.findIndex(value => value.id === shot.id), offsetUs = mix ? transcriptMixOffset(project, mix, shot.id) : 0;
  useEffect(() => () => clock.dispose(), [clock]);
  useEffect(() => { clock.configure(shot.durationUs, project.profile.frameRate); }, [clock, shot.durationUs, project.profile.frameRate]);
  useEffect(() => { clock.seek(locate.timeUs); }, [clock, locate]);
  useEffect(() => { if (!ready || disabled || !mix) clock.pause(); }, [clock, ready, disabled, mix]);
  return <div className="transcript-preview"><div className="transcript-preview__canvas" style={{ aspectRatio: `${project.profile.width}/${project.profile.height}` }}><ScenePreview project={project} shot={shot} shotIndex={Math.max(0, index)} assets={assets} timeUs={timeUs} playing={playing} /></div><div className="transcript-preview__controls"><Button aria-label={playing ? '暂停剪辑预览' : '播放剪辑预览'} disabled={!mix || !ready || disabled} onClick={clock.toggle}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "暂停" : "播放"}</Button><input type="range" aria-label="剪辑预览位置" min={0} max={Math.max(0, shot.durationUs / 1000)} step={1000 * project.profile.frameRate.denominator / project.profile.frameRate.numerator} value={timeUs / 1000} disabled={disabled} onChange={event => clock.seek(Number(event.target.value) * 1000)} /><span>{formatTime(timeUs)} / {formatTime(shot.durationUs)}</span><IconButton label={muted ? '开启剪辑预览声音' : '静音剪辑预览'} aria-pressed={muted} onClick={() => setMuted(value => !value)}>{muted ? <VolumeX size={14} /> : <Volume2 size={14} />}</IconButton></div>{mix && <PreparedMixPreview mix={mix} onLevels={onLevels} controls={false} timeUs={offsetUs + timeUs} playing={playing} muted={muted} onReadyChange={setReady} />}</div>;
}
