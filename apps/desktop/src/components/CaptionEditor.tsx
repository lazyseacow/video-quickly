import { useEffect, useRef, useState } from 'react';
import { ArrowDownWideNarrow, LocateFixed, Plus, Scissors, Trash2 } from 'lucide-react';
import { captionTrackSchema, frameAtTime, timeAtFrame, type AssetRecord, type CaptionCue, type CaptionTrack, type FrameRate, type ModelProfile, type Shot } from '@video-quickly/contracts';
import { createEstimatedCaptionTrack, mediaSourceInUs, sourceCaptionTrack, type ClipEditContext } from '@video-quickly/video';
import { captionTrackForEditor, commitCaptionEditorTrack, localCaptionTrack } from '../lib/caption-editor-track';
import { Button, Dialog, Field, IconButton, Notice } from './Primitives';
import './caption-editor.css';

export interface CaptionEditorProps {
  shot: Shot;
  rate: FrameRate;
  models: ModelProfile[];
  audioAsset?: AssetRecord;
  disabled?: boolean;
  context?: ClipEditContext;
  onClose: () => void;
  onApply: (track: CaptionTrack) => Promise<boolean | void> | boolean | void;
  onSeek: (localTimeUs: number) => void;
  onTranscribe?: (modelId: string, signal: AbortSignal) => Promise<CaptionTrack>;
}

// The form edits clip-local times; persisted cues retain their declared source/scene coordinates.
function nextGap(cues: CaptionCue[], durationUs: number, minimumUs: number) {
  let startUs = 0;
  for (const cue of cues.toSorted((a, b) => a.startUs - b.startUs)) {
    if (!Number.isFinite(cue.startUs) || !Number.isFinite(cue.endUs)) return undefined;
    if (cue.startUs - startUs >= minimumUs) return { startUs, endUs: Math.min(cue.startUs, startUs + 1_000_000) };
    startUs = Math.max(startUs, cue.endUs);
  }
  return durationUs - startUs >= minimumUs ? { startUs, endUs: Math.min(durationUs, startUs + 1_000_000) } : undefined;
}

export default function CaptionEditor({ shot, rate, models, audioAsset, disabled = false, context = {}, onClose, onApply, onSeek, onTranscribe }: CaptionEditorProps) {
  const originalTrack = sourceCaptionTrack(shot, context);
  const [fullTrack, setFullTrack] = useState(() => captionTrackForEditor(shot, context));
  const [draft, setDraft] = useState(() => localCaptionTrack(shot, fullTrack, context));
  const [captionsOff, setCaptionsOff] = useState(false);
  const [initial] = useState(() => ({ draft, fullTrack }));
  const asrModels = models.filter(model => model.enabled && model.provider === 'openai-compatible' && model.capabilities.includes('asr'));
  const [modelId, setModelId] = useState(asrModels[0]?.id ?? '');
  const [candidate, setCandidate] = useState<CaptionTrack>();
  const [transcribing, setTranscribing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const active = useRef(true);
  const carets = useRef(new Map<string, number>());
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; controller.current?.abort(); };
  }, []);
  const minimumUs = timeAtFrame(1, rate);
  const offsetUs = shot.clipEdit ? shot.clipEdit.inUs : draft.timeBase === 'source' ? mediaSourceInUs(shot, 'audio', context) : shot.sceneInUs ?? 0;
  const staleSpeech = draft.alignment === 'speech' && (!audioAsset?.active || draft.sourceAssetId !== audioAsset.id || draft.sourceSha256 !== audioAsset.sha256);
  const gap = nextGap(draft.cues, shot.durationUs, minimumUs);
  let error = '';
  for (const [index, cue] of draft.cues.entries()) {
    if (!cue.text.trim()) { error = `字幕 ${index + 1} 需要文字。`; break; }
    if (!Number.isFinite(cue.startUs) || !Number.isFinite(cue.endUs) || cue.startUs < 0 || cue.endUs <= cue.startUs || cue.endUs > shot.durationUs) { error = `字幕 ${index + 1} 的时间须在当前镜头范围内，出点应晚于入点。`; break; }
    if (index > 0 && cue.startUs < draft.cues[index - 1].endUs) { error = '字幕时间存在重叠或顺序不正确，请调整时间或按时间排序。'; break; }
  }
  const parsed = captionTrackSchema.safeParse({
    ...draft,
    ...(shot.clipEdit ? { timeBase: 'clip' as const, alignment: 'manual' as const } : {}),
    cues: draft.cues.map(cue => ({ ...cue, text: cue.text.trim(), startUs: cue.startUs + offsetUs, endUs: cue.endUs + offsetUs })),
  });
  if (!error && !parsed.success) error = parsed.error.issues[0]?.message ?? '字幕时间或文字无效。';
  const changed = !originalTrack || captionsOff || JSON.stringify({ draft, fullTrack }) !== JSON.stringify(initial);
  const busy = disabled || applying;

  function edit(cues: CaptionCue[]) {
    setFailure('');
    setCaptionsOff(false);
    setDraft(current => ({ ...current, cues, alignment: 'manual' }));
  }
  function useTrack(track: CaptionTrack) {
    setFullTrack(track); setDraft(localCaptionTrack(shot, track, context)); setCaptionsOff(false); setFailure('');
  }
  function updateCue(id: string, patch: Partial<CaptionCue>) {
    edit(draft.cues.map(cue => cue.id === id ? { ...cue, ...patch } : cue));
  }
  function splitCue(cue: CaptionCue) {
    const characters = Array.from(cue.text);
    const caret = carets.current.get(cue.id);
    const selected = caret === undefined ? 0 : Array.from(cue.text.slice(0, caret)).length;
    const position = selected > 0 && selected < characters.length ? selected : Math.ceil(characters.length / 2);
    const cut = Math.max(1, Math.min(characters.length - 1, position));
    const firstFrame = frameAtTime(cue.startUs, rate), lastFrame = frameAtTime(cue.endUs, rate);
    const frame = Math.max(firstFrame + 1, Math.min(lastFrame - 1, Math.round(firstFrame + (lastFrame - firstFrame) * cut / characters.length)));
    const middleUs = timeAtFrame(frame, rate);
    edit(draft.cues.flatMap(item => item.id === cue.id ? [
      { ...cue, text: characters.slice(0, cut).join(''), endUs: middleUs },
      { ...cue, id: crypto.randomUUID(), text: characters.slice(cut).join(''), startUs: middleUs },
    ] : [item]));
  }
  function locate(id: string) {
    if (!parsed.success) return;
    const cue = draft.cues.find(item => item.id === id);
    if (cue) onSeek(cue.startUs);
  }
  async function transcribe() {
    if (!onTranscribe || !audioAsset || !modelId) return;
    controller.current?.abort();
    const operation = new AbortController(); controller.current = operation;
    setFailure(''); setCandidate(undefined); setTranscribing(true);
    try {
      const track = captionTrackSchema.parse(await onTranscribe(modelId, operation.signal));
      if (track.alignment !== 'speech' || track.timeBase !== 'source' || track.sourceAssetId !== audioAsset.id || track.sourceSha256 !== audioAsset.sha256) throw new Error('识别结果与当前音频不匹配，请重新识别。');
      if (active.current && !operation.signal.aborted) setCandidate(track);
    } catch (error) {
      if (active.current && !operation.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (active.current && controller.current === operation) { setTranscribing(false); controller.current = undefined; }
    }
  }
  async function apply() {
    if (error || staleSpeech || !parsed.success) return;
    setApplying(true); setFailure('');
    try {
      const track = commitCaptionEditorTrack(shot, fullTrack, draft, context, captionsOff);
      const saved = await onApply(track);
      if (active.current) {
        if (saved === false) setFailure('字幕修改尚未保存，草稿已保留，可重试。');
        else onClose();
      }
    }
    catch (error) { if (active.current) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (active.current) setApplying(false); }
  }
  function close() { controller.current?.abort(); onClose(); }

  return <Dialog title="编辑字幕" onClose={close} className="dialog--wide caption-editor">
    <div className="dialog__body">
      <div className="caption-editor__summary"><strong>{shot.title}</strong><span>{draft.cues.length} 句 · 时间以当前镜头起点为 0 秒</span></div>
      {draft.alignment === 'estimated' && <Notice>当前字幕按旁白文字估时，尚未按语音对齐。</Notice>}
      {draft.alignment === 'speech' && !staleSpeech && <p className="tiny-meta">已按当前音频识别对齐 · {draft.granularity === 'word' ? '逐词时间' : '逐句时间'}</p>}
      {staleSpeech && <Notice kind="error">音频已更换，旧语音字幕需要重新识别或手工校准。</Notice>}
      {draft.cues.some(cue => Array.from(cue.text).length > 60) && <p className="tiny-meta">较长字幕会在预览与导出时自动分页，页内切换按阅读量估时；需要精确到词时，请拆句校准或使用逐词对齐。</p>}
      <div className="caption-editor__actions">
        <Button disabled={busy || !shot.narration.trim()} onClick={() => useTrack(createEstimatedCaptionTrack(shot))}>从旁白初始化估时</Button>
        <Button disabled={busy || draft.cues.length < 2} onClick={() => edit(draft.cues.toSorted((a, b) => a.startUs - b.startUs || a.endUs - b.endUs))}><ArrowDownWideNarrow size={14} />按时间排序</Button>
        <Button disabled={busy || !fullTrack.cues.length && !draft.cues.length} onClick={() => { edit([]); setCaptionsOff(true); }}>关闭此镜头字幕</Button>
      </div>
      <div className="caption-editor__cues" aria-label="字幕句段">
        {draft.cues.map((cue, index) => <section className="caption-editor__cue" aria-label={`字幕 ${index + 1}`} key={cue.id}>
          <div className="caption-editor__cue-heading"><span>{String(index + 1).padStart(2, '0')}</span><div>
            <IconButton label={`定位字幕 ${index + 1}`} disabled={busy || Boolean(error)} onClick={() => locate(cue.id)}><LocateFixed size={15} /></IconButton>
            <IconButton label={`拆分字幕 ${index + 1}`} disabled={busy || Boolean(error) || Array.from(cue.text).length < 2 || cue.endUs - cue.startUs < minimumUs * 2} onClick={() => splitCue(cue)}><Scissors size={15} /></IconButton>
            <IconButton label={`删除字幕 ${index + 1}`} disabled={busy} onClick={() => edit(draft.cues.filter(item => item.id !== cue.id))}><Trash2 size={15} /></IconButton>
          </div></div>
          <Field label={`字幕 ${index + 1} 文字`}><textarea value={cue.text} disabled={busy} rows={2} onChange={event => updateCue(cue.id, { text: event.target.value })} onSelect={event => carets.current.set(cue.id, event.currentTarget.selectionStart)} /></Field>
          <div className="field-row"><Field label={`字幕 ${index + 1} 入点（秒）`}><input type="number" min="0" max={shot.durationUs / 1e6} step="0.001" value={Number.isFinite(cue.startUs) ? cue.startUs / 1e6 : ''} disabled={busy} onChange={event => updateCue(cue.id, { startUs: Math.round(event.target.valueAsNumber * 1e6) })} /></Field><Field label={`字幕 ${index + 1} 出点（秒）`}><input type="number" min="0" max={shot.durationUs / 1e6} step="0.001" value={Number.isFinite(cue.endUs) ? cue.endUs / 1e6 : ''} disabled={busy} onChange={event => updateCue(cue.id, { endUs: Math.round(event.target.valueAsNumber * 1e6) })} /></Field></div>
        </section>)}
        {!draft.cues.length && <p className="caption-editor__empty">{captionsOff ? '当前镜头字幕已关闭。' : fullTrack.cues.length ? '当前区间没有字幕，区间外句段仍保留。' : '当前区间没有字幕。'}可添加句段或从旁白初始化。</p>}
      </div>
      <Button disabled={busy || !gap} title={!gap ? '请先缩短或拆分已有句段，为新字幕留出时间' : undefined} onClick={() => { if (gap) edit([...draft.cues, { id: crypto.randomUUID(), ...gap, text: '' }].toSorted((a, b) => a.startUs - b.startUs)); }}><Plus size={14} />添加字幕</Button>
      <section className="caption-editor__recognition" aria-label="语音识别">
        <div className="caption-editor__recognition-controls"><Field label="语音识别模型"><select value={modelId} disabled={busy || transcribing} onChange={event => setModelId(event.target.value)}><option value="" disabled>选择语音识别模型</option>{asrModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</select></Field><Button busy={transcribing} disabled={busy || !audioAsset || !modelId || !onTranscribe} onClick={() => void transcribe()}>识别音频并对齐</Button></div>
        {!audioAsset ? <p className="tiny-meta">先为当前镜头关联旁白音频，再进行语音识别。</p> : !asrModels.length ? <p className="tiny-meta">请在模型连接中添加具备语音识别能力的模型。</p> : null}
        {transcribing && <p className="tiny-meta" role="status">正在识别音频，完成后会提供候选字幕。</p>}
        {candidate && <div className="caption-editor__candidate"><p>识别候选 · {candidate.cues.length} 句</p><p>{candidate.cues.slice(0, 2).map(cue => cue.text).join(' ') || '当前音频未识别到语音。'}</p><Button disabled={busy} onClick={() => { useTrack(candidate); setCandidate(undefined); }}>使用识别候选</Button></div>}
      </section>
      {(failure || error) && <Notice kind="error">{failure || error}</Notice>}
    </div>
    <div className="dialog__footer"><Button onClick={close}>取消</Button><Button variant="primary" busy={applying} disabled={disabled || transcribing || !changed || Boolean(error) || staleSpeech} onClick={() => void apply()}>应用字幕</Button></div>
  </Dialog>;
}
