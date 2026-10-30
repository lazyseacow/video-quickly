import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Sparkles, Square, RefreshCw, ChevronDown, Pause, Play } from 'lucide-react';
import { type AssetRecord, type ModelProfile, type ProjectDocument, type RunSummary, type Shot, type ShotCandidate, type ShotCandidateField, type ShotCandidateKind, usesVideoAudio } from '@video-quickly/contracts';
import { candidateKindLabels, candidateRunActive, readCandidateAssets, readShotCandidate, readShotCandidates, watchCandidateRun } from '../lib/shot-candidates';
import { getAssetUrl, rpc } from '../lib/client';
import { Button, Dialog, Field, Notice, Status, Select } from './Primitives';
import { ScenePreview } from './ScenePreview';
import { sourceCaptionTrack } from '@video-quickly/video/clip-edits';
import { candidatePreviewProject } from '../lib/clip-preview';
import { readAudioLevels, usePreparedProjectMix } from '../lib/audio-mix';
import { PlaybackClock, usePlayback } from '../lib/playback';
import PreparedMixPreview from './PreparedMixPreview';
import './shot-regeneration-dialog.css';

export interface ShotRegenerationDialogProps {
  project: ProjectDocument; shot: Shot; models: ModelProfile[]; assets: AssetRecord[];
  onClose: () => void;
  onGenerate: (input: { kind: ShotCandidateKind; modelId?: string; instruction?: string }) => Promise<{ id: string } | null>;
  onApply: (candidate: ShotCandidate, fields?: ShotCandidateField[]) => Promise<boolean>;
}
const fieldLabels: Record<ShotCandidateField, string> = { title: '标题', narration: '旁白', visualPrompt: '画面要求', durationUs: '时长' };
const scriptFields: ShotCandidateField[] = ['title', 'narration', 'visualPrompt', 'durationUs'];
const capabilities = { script: 'text', image: 'image', audio: 'tts', video: 'video' } as const;

export default function ShotRegenerationDialog({ project, shot, models, assets, onClose, onGenerate, onApply }: ShotRegenerationDialogProps) {
  const [kind, setKind] = useState<ShotCandidateKind>('script');
  const [modelId, setModelId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [items, setItems] = useState<ShotCandidate[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [candidate, setCandidate] = useState<ShotCandidate>();
  const [fields, setFields] = useState<ShotCandidateField[]>([]);
  const [extraAssets, setExtraAssets] = useState<AssetRecord[]>([]);
  const [run, setRun] = useState<RunSummary>();
  const [runId, setRunId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [applying, setApplying] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [listError, setListError] = useState('');
  const [progressError, setProgressError] = useState('');
  const [progressRefresh, setProgressRefresh] = useState(0);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const availableModels = models.filter(model => model.enabled && model.capabilities.includes(capabilities[kind]));
  const selectedModelId = availableModels.some(model => model.id === modelId) ? modelId : availableModels[0]?.id ?? '';
  const running = Boolean(runId && (!run || run.id !== runId || candidateRunActive(run)));
  const resumable = run?.status === 'queued' && Boolean(run.error);
  const allAssets = useMemo(() => [...new Map([...extraAssets, ...assets].map(asset => [asset.id, asset])).values()], [extraAssets, assets]);
  const preview = useMemo(() => {
    if (!candidate || candidate.kind === 'script' || !candidate.baseline.clipEdit) return undefined;
    try { return { project: candidatePreviewProject(project, candidate, allAssets), error: undefined }; }
    catch (failure) { return { project: undefined, error: failure instanceof Error ? failure.message : String(failure) }; }
  }, [candidate, project, allAssets]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; listRequest.current++; detailRequest.current++; };
  }, []);
  const load = useCallback(async (offset = 0, selectRunId?: string) => {
    const request = ++listRequest.current; setLoading(true); setListError('');
    try {
      const page = await readShotCandidates(project.id, shot.id, offset);
      if (!alive.current || request !== listRequest.current) return;
      setTotal(page.total);
      setNextOffset(offset + page.items.length);
      setItems(previous => offset ? [...previous, ...page.items.filter(item => !previous.some(value => value.id === item.id))] : page.items);
      setSelectedId(current => page.items.find(item => item.runId === selectRunId)?.id ?? current ?? page.items[0]?.id);
      // Only the server can identify an unfinished task belonging to this exact shot.
      const restored = page.activeRun;
      if (restored && candidateRunActive(restored)) { setRun(restored); setRunId(restored.id); }
    } catch (error) { if (alive.current && request === listRequest.current) setListError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current && request === listRequest.current) setLoading(false); }
  }, [project.id, shot.id]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!selectedId) return;
    const request = ++detailRequest.current; setReading(true); setCandidate(undefined); setError('');
    void readShotCandidate(project.id, shot.id, selectedId).then(value => {
      if (!alive.current || request !== detailRequest.current) return;
      setCandidate(value);
      setFields(scriptFields.filter(field => field !== 'durationUs' && value.shot[field] !== shot[field]));
    }).catch(error => { if (alive.current && request === detailRequest.current) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (alive.current && request === detailRequest.current) setReading(false); });
    return () => { detailRequest.current++; };
  }, [selectedId, project.id, shot.id]);

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    setProgressError('');
    void watchCandidateRun(runId, value => { if (alive.current) setRun(value); }, controller.signal).then(async completed => {
      if (controller.signal.aborted || !alive.current) return;
      if (completed.status === 'succeeded') {
        await Promise.all([
          load(0, completed.id),
          readCandidateAssets(project.id).then(values => { if (alive.current && !controller.signal.aborted) setExtraAssets(values); }),
        ]);
      } else if (completed.status !== 'canceled') setError(completed.error ?? '生成需要核对，请在制作记录中查看任务。');
    }).catch(error => { if (alive.current && !controller.signal.aborted) setProgressError(error instanceof Error ? error.message : String(error)); });
    return () => controller.abort();
  }, [runId, project.id, load, progressRefresh]);

  async function generate() {
    if (!selectedModelId) return;
    setGenerating(true); setError('');
    try {
      const started = await onGenerate({ kind, modelId: selectedModelId, ...(instruction.trim() ? { instruction: instruction.trim() } : {}) });
      if (!alive.current) return;
      if (!started) { setError('生成未开始，请核对保存状态和模型连接。'); return; }
      setRun(undefined); setRunId(started.id);
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setGenerating(false); }
  }
  async function cancel() {
    if (!runId) return;
    setCanceling(true); setError('');
    try { await rpc('run.cancel', { runId }); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setCanceling(false); }
  }
  async function resume() {
    if (!runId) return;
    setResuming(true); setError('');
    try { await rpc('run.resume', { runId }); if (alive.current) setProgressRefresh(value => value + 1); }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setResuming(false); }
  }
  async function apply() {
    if (!candidate) return;
    setApplying(true); setError('');
    try {
      if (await onApply(candidate, candidate.kind === 'script' ? fields : undefined)) { if (alive.current) onClose(); }
      else if (alive.current) setError('候选尚未应用，当前内容已保留。请核对提示后重试。');
    } catch (error) { if (alive.current) setError(error instanceof Error ? error.message : String(error)); }
    finally { if (alive.current) setApplying(false); }
  }
  const currentAsset = candidate?.kind === 'audio' ? allAssets.find(asset => asset.id === shot.audioAssetId) : shot.sceneTemplate ? undefined : allAssets.find(asset => asset.id === (shot.videoAssetId ?? shot.assetId));
  const candidateAsset = candidate?.kind === 'audio' ? allAssets.find(asset => asset.id === candidate.shot.audioAssetId) : candidate?.kind === 'video' ? allAssets.find(asset => asset.id === candidate.shot.videoAssetId) : allAssets.find(asset => asset.id === candidate?.shot.assetId);

  return <Dialog title="镜头候选" onClose={onClose} className="shot-regeneration-dialog">
    <div className="dialog__body">
      <p className="shot-regeneration__target">{shot.title}</p>
      <div className="shot-regeneration__form"><Field label="生成内容"><Select value={kind} disabled={generating || applying || running} onChange={event => setKind(event.target.value as ShotCandidateKind)}>{Object.entries(candidateKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field><Field label="生成模型"><Select value={selectedModelId} disabled={generating || applying || running} onChange={event => setModelId(event.target.value)}><option value="" disabled>选择模型</option>{availableModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</Select></Field></div>
      <Field label="本次调整要求"><textarea value={instruction} maxLength={10000} disabled={generating || applying || running} onChange={event => setInstruction(event.target.value)} placeholder="说明这个镜头希望如何修改…" /></Field>
      {!availableModels.length && <p className="tiny-meta">请先在模型连接中添加具备{candidateKindLabels[kind]}能力的模型。</p>}
      {shot.locked && <Notice>请先解锁当前镜头，再生成或应用候选。</Notice>}
      <div className="shot-regeneration__generate"><Button variant="primary" busy={generating} disabled={applying || running || !selectedModelId || shot.locked} onClick={() => void generate()}><Sparkles size={14} />生成候选</Button><span className="tiny-meta">生成结果会先保留为候选，应用前不会替换当前镜头。</span></div>
      {runId && <div className="shot-regeneration__run" role="status"><Status value={run?.status ?? 'queued'} /><span>{resumable ? run?.error : running ? '生成在后台继续；关闭后可重新打开或查看制作记录。' : run?.status === 'succeeded' ? '候选已保存，可比较后选择应用。' : run?.status === 'canceled' ? '已请求停止，已提交的远端任务请在制作记录中核对。' : run?.error}</span>{resumable && <Button aria-label="继续生成" busy={resuming} disabled={canceling} onClick={() => void resume()}>继续</Button>}{running && <Button aria-label="停止生成" busy={canceling} disabled={resuming} onClick={() => void cancel()}><Square size={13} />停止</Button>}</div>}
      {progressError && <Notice kind="error">{progressError}<Button aria-label="重试生成进度" onClick={() => setProgressRefresh(value => value + 1)}>重试</Button></Notice>}
      <div className="shot-regeneration__workspace">
        <aside className="shot-regeneration__history" aria-label="候选历史"><div className="shot-regeneration__history-heading"><h3>候选历史 <span>{total}</span></h3><Button aria-label="刷新候选" variant="ghost" disabled={loading || applying} onClick={() => void load()}><RefreshCw size={13} />刷新</Button></div>
          {listError && <Notice kind="error">{listError}</Notice>}
          {items.map((item, index) => <button type="button" className={`shot-regeneration__history-item ${item.id === selectedId ? 'is-selected' : ''}`} aria-pressed={item.id === selectedId} aria-label={`选择候选 ${index + 1}：${candidateKindLabels[item.kind]}`} key={item.id} disabled={applying} onClick={() => setSelectedId(item.id)}><strong>{candidateKindLabels[item.kind]}</strong><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></button>)}
          {!items.length && <p className="tiny-meta">{loading ? '正在读取候选…' : '还没有生成候选。'}</p>}
          {nextOffset < total && <Button aria-label="加载更多候选" busy={loading} disabled={applying} onClick={() => void load(nextOffset)}><ChevronDown size={14} />加载更多</Button>}
        </aside>
        <section className="shot-regeneration__comparison" aria-label="当前与候选对比">
          {reading ? <p className="tiny-meta" role="status">正在读取候选内容…</p> : candidate?.kind === 'script' ? <div className="shot-regeneration__fields">{scriptFields.map(field => <section className="shot-regeneration__field" key={field}><label><input type="checkbox" checked={fields.includes(field)} disabled={applying || candidate.shot[field] === shot[field]} aria-label={`应用候选${fieldLabels[field]}`} onChange={event => setFields(current => event.target.checked ? [...current, field] : current.filter(value => value !== field))} />{fieldLabels[field]}</label><div><section><span>当前</span><p>{field === 'durationUs' ? `${shot[field] / 1e6} 秒` : shot[field] || '（空）'}</p></section><section><span>候选</span><p>{field === 'durationUs' ? `${candidate.shot[field] / 1e6} 秒` : candidate.shot[field] || '（空）'}</p></section></div></section>)}</div> : candidate ? <>
            <div className="shot-regeneration__media">{shot.clipEdit ? <CandidateClipPreview label="当前" project={project} shot={shot} assets={allAssets} audioOnly={candidate.kind === 'audio'} /> : <CandidateMedia label="当前" asset={currentAsset} sourceInUs={candidate.kind === 'audio' ? shot.audioInUs ?? shot.sourceInUs ?? 0 : shot.videoInUs ?? shot.sourceInUs ?? 0} durationUs={shot.durationUs} fallback={candidate.kind !== 'audio' ? <span className="shot-regeneration__scene" style={{ aspectRatio: `${project.profile.width}/${project.profile.height}` }}><ScenePreview project={project} shot={shot} shotIndex={Math.max(0, project.shots.findIndex(value => value.id === shot.id))} assets={allAssets} /></span> : undefined} />}{preview?.project ? <CandidateClipPreview label="候选" project={preview.project} shot={preview.project.shots.find(value => value.id === candidate.shotId)!} assets={allAssets} audioOnly={candidate.kind === 'audio'} /> : preview?.error ? <figure><figcaption>候选</figcaption><Notice kind="error">{preview.error}</Notice></figure> : <CandidateMedia label="候选" asset={candidateAsset} sourceInUs={0} durationUs={candidate.shot.durationUs} />}</div>
            {candidate.kind === 'audio' && sourceCaptionTrack(shot, project) && <Notice>应用候选旁白后需重新对齐字幕，现有字幕会保留。</Notice>}{shot.sceneTemplate && ['image', 'video'].includes(candidate.kind) && <Notice>应用此候选将替换当前模板画面。</Notice>}
          </> : <p className="shot-regeneration__empty">选择一个候选，与当前镜头比较。</p>}
        </section>
      </div>
      {error && <Notice kind="error">{error}</Notice>}
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>关闭</Button><Button aria-label="应用所选候选" variant="primary" busy={applying} disabled={!candidate || reading || generating || running || shot.locked || candidate.kind === 'script' && !fields.length} onClick={() => void apply()}>应用</Button></div>
  </Dialog>;
}

function CandidateClipPreview({ label, project, shot, assets, audioOnly }: { label: string; project: ProjectDocument; shot: Shot; assets: AssetRecord[]; audioOnly: boolean }) {
  const solo = useMemo(() => ({ ...project, shots: [shot], musicClips: [] }), [project, shot]);
  const [clock] = useState(() => new PlaybackClock(shot.durationUs, project.profile.frameRate));
  const { timeUs, playing } = usePlayback(clock);
  const [audioReady, setAudioReady] = useState(false), [failure, setFailure] = useState('');
  const hasAudio = Boolean(shot.audioAssetId) || usesVideoAudio(shot), mix = usePreparedProjectMix(solo, assets, hasAudio);
  useEffect(() => { clock.configure(shot.durationUs, project.profile.frameRate); clock.seek(0); setFailure(''); }, [clock, shot.durationUs, shot.clipEdit?.planId, shot.audioAssetId, shot.videoAssetId, project.profile.frameRate.numerator, project.profile.frameRate.denominator]);
  useEffect(() => () => clock.dispose(), [clock]);
  useEffect(() => { if (document.hidden) clock.pause(); const pause = () => { if (document.hidden) clock.pause(); }; document.addEventListener('visibilitychange', pause); return () => document.removeEventListener('visibilitychange', pause); }, [clock]);
  return <figure aria-label={`${label}剪后片段`}><figcaption>{label}</figcaption>{!audioOnly && <span className="shot-regeneration__scene" style={{ aspectRatio: `${project.profile.width}/${project.profile.height}` }}><ScenePreview project={solo} shot={shot} shotIndex={Math.max(0, project.shots.findIndex(value => value.id === shot.id))} assets={assets} timeUs={timeUs} playing={playing} /></span>}
    {hasAudio && mix.status === 'pending' && <p className="tiny-meta" role="status">正在准备{label}剪后试听…</p>}
    {mix.mix && <PreparedMixPreview mix={mix.mix} onLevels={readAudioLevels} playing={playing} timeUs={timeUs} controls={false} onReadyChange={setAudioReady} onError={message => { clock.pause(); setFailure(message); }} />}
    {(failure || mix.error) && <Notice kind="error">{failure || mix.error}<Button aria-label="重试片段试听" onClick={() => { setFailure(''); mix.retry(); }}>重试</Button></Notice>}
    <Button disabled={audioOnly && !hasAudio || hasAudio && (mix.status !== 'ready' || !audioReady)} onClick={clock.toggle}>{playing ? <Pause size={13} /> : <Play size={13} />}{playing ? `暂停${label}片段` : `播放${label}片段`}</Button>
    <input type="range" aria-label={`${label}剪后播放位置`} min={0} max={shot.durationUs / 1000} value={Math.round(timeUs / 1000)} step={1} onChange={event => clock.seek(Number(event.target.value) * 1000)} />
    <p className="tiny-meta">剪后 {(shot.durationUs / 1e6).toFixed(3)} 秒 · 保留各源区间</p>
  </figure>;
}

function CandidateMedia({ label, asset, sourceInUs, durationUs, fallback }: { label: string; asset?: AssetRecord; sourceInUs: number; durationUs: number; fallback?: ReactNode }) {
  const [loaded, setLoaded] = useState<{ key: string; url?: string; error?: string }>();
  const media = useRef<HTMLMediaElement | null>(null);
  const key = asset ? `${asset.id}:${asset.sha256}:${asset.path}` : '';
  useEffect(() => {
    if (!asset) return;
    let active = true;
    void getAssetUrl(asset.path).then(url => { if (active) setLoaded({ key, url }); }).catch(error => { if (active) setLoaded({ key, error: error instanceof Error ? error.message : String(error) }); });
    return () => { active = false; };
  }, [key]);
  const current = loaded?.key === key ? loaded : undefined;
  useEffect(() => {
    const element = media.current;
    if (!element) return;
    return () => { element.pause(); element.removeAttribute('src'); element.load(); };
  }, [current?.url, key, sourceInUs, durationUs]);
  const fail = () => setLoaded({ key, error: '素材无法读取或解码，请检查原文件。' });
  function window(element: HTMLMediaElement) { return { start: sourceInUs / 1e6, end: Math.min(element.duration, (sourceInUs + durationUs) / 1e6) }; }
  function position(element: HTMLMediaElement) {
    if (!Number.isFinite(element.duration)) return;
    const range = window(element);
    if (range.start >= range.end) { setLoaded({ key, error: '素材入点超出实际时长，无法预览此片段。' }); return; }
    element.currentTime = range.start;
  }
  function constrain(element: HTMLMediaElement, playing = false) {
    if (!Number.isFinite(element.duration)) return;
    const range = window(element);
    if (playing && element.currentTime >= range.end - .005) { element.currentTime = range.start; return; }
    const next = Math.max(range.start, Math.min(range.end - .001, element.currentTime));
    if (Math.abs(next - element.currentTime) > .0005) element.currentTime = next;
  }
  function timeUpdate(element: HTMLMediaElement) {
    const range = window(element);
    if (element.currentTime >= range.end) { element.pause(); element.currentTime = Math.max(range.start, range.end - .001); }
  }
  const previewKey = `${key}:${sourceInUs}:${durationUs}`;
  return <figure><figcaption>{label}</figcaption>{!asset ? fallback ?? <p className="tiny-meta">尚未关联素材</p> : current?.error ? <Notice kind="error">{current.error}</Notice> : !current?.url ? <p className="tiny-meta" role="status">正在读取素材…</p> : asset.kind === 'image' ? <img src={current.url} alt={`${label}画面`} onError={fail} /> : asset.kind === 'audio' ? <audio key={previewKey} ref={element => { media.current = element; }} src={current.url} controls preload="metadata" aria-label={`${label}旁白`} onLoadedMetadata={event => position(event.currentTarget)} onSeeking={event => constrain(event.currentTarget)} onPlay={event => constrain(event.currentTarget, true)} onTimeUpdate={event => timeUpdate(event.currentTarget)} onError={fail} /> : <video key={previewKey} ref={element => { media.current = element; }} src={current.url} controls preload="metadata" playsInline aria-label={`${label}视频`} onLoadedMetadata={event => position(event.currentTarget)} onSeeking={event => constrain(event.currentTarget)} onPlay={event => constrain(event.currentTarget, true)} onTimeUpdate={event => timeUpdate(event.currentTarget)} onError={fail} />}{asset && <p className="tiny-meta">{asset.name}</p>}</figure>;
}
