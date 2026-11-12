import { useEffect, useId, useMemo, useRef, useState, type ComponentType } from 'react';
import { Check, ChevronLeft, ChevronRight, Clapperboard, Clock3, Download, FileJson, FolderOpen, Image, LoaderCircle, Music2, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import { assetSchema, captionTrackSchema, creativeContextSchema, creativeEntityLabels, formatFrameRate, isJsonDocument, planningDocumentSchemas, planningDocumentSections, shotSchema, videoProfileSchema, workflowProposalSchema, workflowProposalChanges, workflowSchema, type AssetRecord, type GenerationShotProgress, type JsonValue, type ProjectDocument, type RunStepPayload, type RunStepProgressDetail, type RunStepSummary, type Shot, type VideoProfile, type WorkflowNode } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';
import { assetAvailabilityUrl, useAssetAvailability } from '../lib/asset-availability';
import { nativeDesktop, revealFile } from '../lib/desktop';
import { Button, IconButton, Notice, formatTime } from './Primitives';
import AssetJsonPreviewDialog from './AssetJsonPreviewDialog';
import { videoThumbnails } from './preview-thumbnails';
import { useThumbnailVisibility } from './thumbnail-visibility';
import ResultDocument, { VideoProfileResult } from './ResultDocument';
import StepProgress, { ProgressIcon } from './StepProgress';
import { generationShotLabels, runningStep } from '../lib/run-progress';
import { resolveWorkbenchStages } from '../lib/workbench-stages';
import './step-result-view.css';

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
const copy = (value: JsonValue | undefined) => typeof value === 'string' ? value : '';
const duration = (value: JsonValue | undefined) => typeof value === 'number' && value > 0 ? value : 0;

function storyboardShots(value: JsonValue | undefined) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const shot = record(item);
    return shot ? [shot] : [];
  });
}

export default function StepResultView({ value, kind, mediaShots, mediaGeneration, progress, step, onRegenerate, showOriginalText }: { value: JsonValue; kind: WorkflowNode['kind']; mediaShots?: RunStepPayload['mediaShots']; mediaGeneration?: RunStepPayload['mediaGeneration']; progress?: RunStepProgressDetail; step?: RunStepSummary; onRegenerate?: (shotId: string, kind: 'image' | 'video') => void; showOriginalText?: boolean }) {
  const object = record(value);
  const shots = storyboardShots(object?.shots);
  const [previewId, setPreviewId] = useState<string>();
  const { assets, jsonFiles } = useMemo(() => {
    const values = record(value)?.assets;
    const files = Array.isArray(values) ? values.flatMap(value => {
      const parsed = assetSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }) : [];
    return { assets: files.filter(asset => ['image', 'audio', 'video'].includes(asset.kind)), jsonFiles: files.filter(isJsonDocument) };
  }, [value]);
  const previewFile = jsonFiles.find(file => file.id === previewId);
  const captions = captionTrackSchema.safeParse(object?.captionTrack);
  const creative = creativeContextSchema.safeParse(object?.creativeContext);
  const proposal = workflowProposalSchema.safeParse(object?.proposal);
  const proposalError = copy(object?.proposalError);
  const claims = Array.isArray(object?.claims) ? object.claims.flatMap(value => { const claim = record(value); return claim ? [claim] : []; }) : [];
  const text = typeof value === 'string' ? value : copy(object?.text) || copy(object?.style) || copy(object?.brief);
  const outline = kind === 'script' ? copy(object?.outline) : '';
  const storyboardProfile = kind === 'script' ? videoProfileSchema.safeParse(object?.profile).data : undefined;
  const fields = useMemo(() => {
    if (kind !== 'brief' && kind !== 'style') return undefined;
    const parsed = planningDocumentSchemas[kind].safeParse(object?.fields);
    return parsed.success ? planningDocumentSections(kind, parsed.data) : undefined;
  }, [kind, object?.fields]);
  const exportPath = kind === 'export' ? copy(object?.videoPath) || copy(object?.outputPath) || copy(object?.path) : '';
  const localCount = [object?.referenceAssetIds, object?.assetIds, object?.audioAssetIds].find(Array.isArray)?.filter(Boolean).length;
  const preparedShots = kind === 'animation' && typeof object?.shots === 'number' ? object.shots : undefined;
  const editedProject = kind === 'animation' ? record(object?.editedProject) : undefined;
  const specialized = shots.length || assets.length || jsonFiles.length || progress?.shots.length || captions.success || claims.length || text || outline || exportPath || localCount !== undefined || preparedShots !== undefined || proposal.success || proposalError;

  return <div className="step-result" aria-label="制作结果">
    {outline && <ResultDocument text={outline} title="全片大纲" label="全片大纲" showOriginalText={showOriginalText} />}
    {shots.length > 0 && <StoryboardResult shots={shots} profile={storyboardProfile} view={kind === 'animation' ? 'animation' : 'storyboard'} />}
    {creative.success && (creative.data.entities.length > 0 || creative.data.characterIds.length > 0 || creative.data.continuity) && <section className="step-result__document" aria-label="本次创作设定"><h3>创作设定</h3>{creative.data.characterIds.length > 0 && <p>{creative.data.characterIds.length} 个参考角色</p>}{creative.data.continuity && <p><strong>连续性要求</strong><br />{creative.data.continuity}</p>}{creative.data.entities.map(entity => <p key={entity.key}><strong>{creativeEntityLabels[entity.kind]}：{entity.name}</strong><br />{entity.description}</p>)}</section>}
    {(assets.length > 0 || Boolean(progress?.shots.length)) && <MediaGallery assets={assets} shots={mediaShots} exported={kind === 'export'} nodeKind={kind} progress={progress} step={step} mediaGeneration={mediaGeneration} onRegenerate={onRegenerate} />}
    {exportPath && !assets.some(asset => asset.kind === 'video') && <figure className="step-result__media"><ResultMedia path={exportPath} kind="video" name="导出成片" exported /></figure>}
    {jsonFiles.length > 0 && <div className="step-result__file-action">{jsonFiles.map(file => <Button static key={file.id} title={file.name}
      onClick={() => setPreviewId(file.id)}><FileJson size={16} aria-hidden="true" /><span>查看 {file.name}</span></Button>)}</div>}
    {previewFile && <AssetJsonPreviewDialog key={previewFile.id} asset={previewFile} onClose={() => setPreviewId(undefined)} />}
    {captions.success && <CaptionResult track={captions.data} />}
    {claims.length > 0 && <section className="step-result__claims" aria-label="资料主张"><div className="step-result__summary">{claims.length} 条主张</div>{claims.map((claim, index) => <article key={copy(claim.id) || index}><header><strong>主张 {index + 1}</strong><span>{claim.status === 'verified' && object?.readonly === true ? '已核验' : claim.status === 'disputed' ? '存在争议' : '待核验'}</span></header><p>{copy(claim.text)}</p>{copy(claim.evidence) && <blockquote>{copy(claim.evidence)}</blockquote>}</article>)}</section>}
    {(proposal.success || proposalError) && <section className="step-result__document" aria-label="任务修改建议">{proposal.success && <><h3>{proposal.data.summary}</h3><dl className="step-result__fields">{workflowProposalChanges(proposal.data).map(change => <div key={change.field}><dt>{change.label}</dt><dd><p>当前内容：{change.before || '未设置'}</p><p>建议内容：{change.after || '未设置'}</p></dd></div>)}</dl></>}{proposalError && <Notice kind="error">{proposalError}</Notice>}<p>在对应任务的“更多操作”中打开“对话修改任务”，核对已保存的建议后应用到草稿。</p>{text && <details><summary>原始模型结果</summary><pre>{text}</pre></details>}</section>}
    {text && !shots.length && !captions.success && !claims.length && !proposal.success && !proposalError && <ResultDocument text={text} fields={fields} title={copy(object?.title)} label={kind === 'style' ? '视觉风格' : kind === 'brief' ? '创作简报' : '创作内容'} showOriginalText={showOriginalText} />}
    {localCount !== undefined && !assets.length && <div className="step-result__checkpoint"><Check size={20} /><strong>{localCount ? `已沿用 ${localCount} 份素材` : '本步骤未添加参考素材'}</strong></div>}
    {preparedShots !== undefined && <div className="step-result__checkpoint"><Check size={20} /><div><strong>{preparedShots} 个镜头已就绪</strong>{copy(object?.message) && <p>{copy(object?.message)}</p>}</div></div>}
    {!specialized && kind === 'review' ? <div className="step-result__checkpoint"><Check size={24} /><div><strong>自动检查结果</strong><p>检查完成后，流程会自动继续后续步骤。</p></div></div>
      : !specialized && kind === 'join' ? <div className="step-result__checkpoint"><Check size={24} /><strong>上游分支已汇合</strong></div>
        : !specialized && kind === 'condition' ? <div className="step-result__checkpoint"><Check size={24} /><div><strong>{object?.matched === true ? '条件成立' : '条件不成立'}</strong><p>流程将沿对应的连接继续。</p></div></div>
          : !specialized && <ResultFields value={editedProject ?? value} project={Boolean(editedProject)} />}
    {Array.isArray(object?.warnings) && object.warnings.length > 0 && <Notice>{object.warnings.map((warning, index) => <p key={index}>{copy(warning)}</p>)}</Notice>}
  </div>;
}

function visualPromptWithColors(text: string) {
  return text.split(/(?<![\w#])(#[\da-f]{8}|#[\da-f]{6}|#[\da-f]{4}|#[\da-f]{3})(?![\w#])/gi).map((part, index) => index % 2 === 0 ? part : (
    <span className="step-result__color-value" key={index}>
      <span className="step-result__color-swatch" aria-hidden="true" style={{ backgroundColor: part }} />{part}
    </span>
  ));
}

function StoryboardResult({ shots, profile, view }: { shots: Record<string, JsonValue>[]; profile?: VideoProfile; view: 'storyboard' | 'animation' | 'edited' }) {
  const [limit, setLimit] = useState(20);
  const seconds = shots.reduce((sum, shot) => sum + duration(shot.durationUs), 0) / 1_000_000;
  const label = view === 'edited' ? '剪辑后的分镜' : view === 'animation' ? '镜头动画' : '分镜预览';
  return <section aria-label={label}>
    <div className="step-result__summary"><span><Clapperboard size={16} />{shots.length} 个镜头</span>{seconds > 0 && <span><Clock3 size={15} />{seconds.toFixed(1)} 秒</span>}{profile && <span>分镜全局参数 · {profile.width} × {profile.height} · {formatFrameRate(profile.frameRate)} fps</span>}</div>
    <ol className="step-result__storyboard">{shots.slice(0, limit).map((shot, index) => {
      const durationUs = duration(shot.durationUs);
      const visualPrompt = copy(shot.visualPrompt);
      return <li key={copy(shot.id) || index}>
        <header>
          <span className="step-result__index">{String(index + 1).padStart(2, '0')}</span>
          <h4>{copy(shot.title) || `镜头 ${index + 1}`}</h4>
          {durationUs > 0 && <span>{view === 'edited' ? formatSeconds(durationUs) : (durationUs / 1_000_000).toFixed(1)} 秒</span>}
        </header>
        {visualPrompt && <div className="step-result__copy"><span>画面</span><p>{visualPromptWithColors(visualPrompt)}</p></div>}
        {copy(shot.narration) && <div className="step-result__copy"><span>旁白</span><p>{copy(shot.narration)}</p></div>}
        {copy(shot.soundPrompt) && <div className="step-result__copy"><span>声音</span><p>{copy(shot.soundPrompt)}</p></div>}
        {view === 'edited' && <EditedShotDetails shot={shot} />}
        {view === 'animation' && record(shot.animation) && <details className="step-result__animation"><summary>动画与运镜</summary><ResultFields value={shot.animation} /></details>}
      </li>;
    })}</ol>
    {shots.length > limit && <Button static onClick={() => setLimit(value => value + 20)}>显示更多镜头</Button>}
  </section>;
}

const transitionLabels = { cut: '直接切换', fade: '柔和叠化', wipe: '擦除切换' } satisfies Record<Shot['animation']['transition'], string>;
const formatSeconds = (timeUs: number) => (timeUs / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 3, useGrouping: false });

function EditedShotDetails({ shot }: { shot: Record<string, JsonValue> }) {
  const animation = shotSchema.shape.animation.safeParse(shot.animation).data;
  const clipInUs = duration(record(shot.clipEdit)?.inUs ?? shot.sourceInUs);
  return <>
    {animation && <div className="step-result__copy"><span>转场</span><p>{transitionLabels[animation.transition]}</p></div>}
    {clipInUs > 0 && <div className="step-result__copy"><span>素材入点</span><p>{formatSeconds(clipInUs)} 秒</p></div>}
    {shot.locked === true && <div className="step-result__copy"><span>锁定状态</span><p>已锁定</p></div>}
    {animation && <details className="step-result__animation"><summary>动画与运镜</summary><ResultFields value={animation.keyframes
      ? { 关键帧: `${animation.keyframes.length} 个` }
      : { 缩放倍率: animation.zoom, 水平移动: animation.panX, 垂直移动: animation.panY }} /></details>}
  </>;
}

function CaptionResult({ track }: { track: ReturnType<typeof captionTrackSchema.parse> }) {
  const [limit, setLimit] = useState(20);
  return <section aria-label="字幕预览"><div className="step-result__summary">{track.cues.length} 条字幕 · {track.alignment === 'speech' ? '语音对齐' : track.alignment === 'estimated' ? '预估时间，需核对' : '手动时间'}</div><ol className="step-result__captions">{track.cues.slice(0, limit).map(cue => <li key={cue.id}><time>{formatTime(cue.startUs)} — {formatTime(cue.endUs)}</time><p>{cue.text}</p></li>)}</ol>{track.cues.length > limit && <Button static onClick={() => setLimit(value => value + 20)}>显示更多字幕</Button>}</section>;
}

interface MediaEntry { id: string; asset?: AssetRecord; reference?: AssetRecord; status?: GenerationShotProgress['status']; shotId?: string; kind: string; title: string; index: string; durationUs?: number }
function MediaGallery({ assets, shots, exported, nodeKind, progress, step, mediaGeneration, onRegenerate }: { assets: AssetRecord[]; shots?: RunStepPayload['mediaShots']; exported: boolean; nodeKind: WorkflowNode['kind']; progress?: RunStepProgressDetail; step?: RunStepSummary; mediaGeneration?: RunStepPayload['mediaGeneration']; onRegenerate?: (shotId: string, kind: 'image' | 'video') => void }) {
  const [selectedId, setSelectedId] = useState('');
  const galleryId = useId();
  const grid = useRef<HTMLDivElement>(null);
  const knownAssets = new Map([...progress?.assets ?? [], ...assets].map(asset => [asset.id, asset]));
  const entries: MediaEntry[] = progress?.shots.length ? progress.shots.map((shot, index) => {
    const asset = assets.find(asset => asset.shotId === shot.id) ?? (shot.assetId ? knownAssets.get(shot.assetId) : undefined);
    return { id: shot.id, shotId: shot.id, asset, reference: shot.referenceAssetId ? knownAssets.get(shot.referenceAssetId) : undefined,
      status: asset ? 'completed' : shot.status, kind: nodeKind === 'assets' ? '图片' : '视频', title: shot.title, index: String(index + 1).padStart(2, '0'), durationUs: asset?.durationUs };
  }) : assets.map((asset, index) => {
    const shotIndex = shots?.findIndex(shot => shot.id === asset.shotId) ?? -1;
    const shot = shots?.[shotIndex];
    const kind = asset.kind === 'video' ? '视频' : asset.kind === 'audio' ? '音频' : '图片';
    return { id: shot?.id ?? asset.id, asset, shotId: asset.shotId, kind, title: shot?.title || (exported && asset.kind === 'video' ? '导出成片' : `${kind} ${index + 1}`), index: String((shotIndex < 0 ? index : shotIndex) + 1).padStart(2, '0'), durationUs: asset.durationUs };
  });
  const firstCompleted = entries.find(entry => entry.asset);
  const current = entries.find(entry => entry.id === selectedId) ?? (exported ? entries.find(entry => entry.asset?.kind === 'video') : firstCompleted) ?? entries[0];
  const selected = current.asset, selectedIndex = entries.indexOf(current);
  useEffect(() => {
    if (progress?.shots.length && firstCompleted) setSelectedId(value => value || firstCompleted.id);
  }, [Boolean(progress?.shots.length), firstCompleted?.id]);
  useEffect(() => {
    const list = grid.current, item = list?.children.item(selectedIndex);
    if (!selectedId || !list || !item) return;
    const bounds = list.getBoundingClientRect(), target = item.getBoundingClientRect();
    if (target.left < bounds.left) list.scrollLeft -= bounds.left - target.left;
    else if (target.right > bounds.right) list.scrollLeft += target.right - bounds.right;
    if (target.top < bounds.top) list.scrollTop -= bounds.top - target.top;
    else if (target.bottom > bounds.bottom) list.scrollTop += target.bottom - bounds.bottom;
  }, [selectedId, selectedIndex]);
  const count = entries.every(entry => entry.kind === current.kind) ? `${entries.length} ${current.kind === '图片' ? '张图片' : current.kind === '音频' ? '段音频' : '段视频'}` : `${entries.length} 份素材`;
  const showCards = Boolean(progress?.shots.length) || entries.length > 1 || !exported && Boolean(onRegenerate) && assets.some(asset => asset.shotId && ['image', 'video'].includes(asset.kind));
  const focusedShot = step && runningStep(step.status) && step.status !== 'retry_scheduled' && current.status && current.status !== 'completed'
    ? { index: current.index, status: current.status } : undefined;
  return <section aria-label="产物媒体" className="step-result__gallery" data-multiple={showCards || undefined} data-regeneration={!exported && (Boolean(onRegenerate) || Boolean(progress?.shots.length)) || undefined} data-progress={Boolean(progress?.shots.length) && !onRegenerate || undefined}>
    {step && <StepProgress step={step} progress={progress} shot={focusedShot} />}
    {showCards && <>
      <div className="step-result__gallery-summary"><strong>{count}</strong><span>选择缩略图预览</span></div>
      <div ref={grid} className="step-result__media-grid" role="group" aria-label="选择预览素材">{entries.map((entry, index) => {
        const currentEntry = entry.id === current.id;
        const state = currentEntry && focusedShot ? undefined : entry.status;
        const descriptionId = `${galleryId}-${index}`;
        return <div key={entry.id} className="step-result__media-card" data-shot-id={entry.shotId} data-selected={currentEntry} data-generation-state={entry.status}>
          <button type="button" className="step-result__media-select" data-asset-id={entry.asset?.id} aria-label={`预览${entry.title}（${entry.kind}）`} aria-describedby={descriptionId} aria-pressed={currentEntry} onClick={() => setSelectedId(entry.id)}>
            <MediaEntryThumbnail entry={entry} />
            <span className="step-result__media-card-copy"><strong title={entry.title}>{entry.title}</strong>{currentEntry && <Check size={14} aria-hidden="true" />}</span>
            <span id={descriptionId} className="step-result__media-card-meta">
              {state ? <span className="generation-state" data-state={state}><ProgressIcon status={state} size={12} />{generationShotLabels[state]}</span> : entry.kind}
              {entry.durationUs ? ` · ${(entry.durationUs / 1_000_000).toFixed(1)} 秒` : ''}
            </span>
          </button>
          {!exported && onRegenerate && entry.asset && entry.shotId && ['image', 'video'].includes(entry.asset.kind) && <IconButton
            className="step-result__regenerate"
            label={`重新生成镜头 ${entry.index}：${entry.title}`}
            disabled={!mediaGeneration || mediaGeneration.kind !== entry.asset.kind}
            title={!mediaGeneration ? '本次制作没有可用的对应生成模型' : undefined}
            onClick={() => { if (entry.shotId && entry.asset) onRegenerate(entry.shotId, entry.asset.kind === 'video' ? 'video' : 'image'); }}
          ><RefreshCw size={16} aria-hidden="true" /></IconButton>}
        </div>;
      })}</div>
    </>}
    <div className="step-result__preview">
      <div className="step-result__preview-heading"><div><h4>{current.title}</h4><p>{current.kind}{current.durationUs ? ` · ${(current.durationUs / 1_000_000).toFixed(1)} 秒` : ''}{selected?.width && selected.height ? ` · ${selected.width} × ${selected.height}` : ''}{!step && selected && <span className="generation-state" data-state="completed"><ProgressIcon status="completed" size={12} />已保存</span>}</p></div>{entries.length > 1 && <div className="step-result__preview-navigation"><span>{selectedIndex + 1} / {entries.length}</span><IconButton label="上一个素材" disabled={selectedIndex === 0} onClick={() => setSelectedId(entries[selectedIndex - 1].id)}><ChevronLeft size={16} /></IconButton><IconButton label="下一个素材" disabled={selectedIndex === entries.length - 1} onClick={() => setSelectedId(entries[selectedIndex + 1].id)}><ChevronRight size={16} /></IconButton></div>}</div>
      {selected ? <figure className="step-result__media"><ResultMedia key={`${selected.id}:${selected.version}:${selected.sha256}:${selected.path}`} assetId={selected.id} path={selected.path} kind={selected.kind} name={selected.name} exported={exported && selected.kind === 'video'} /></figure>
        : current.reference ? <figure className="step-result__media step-result__reference"><ResultMedia key={current.reference.id} assetId={current.reference.id} path={current.reference.path} kind="image" name={current.title} /><figcaption>参考图</figcaption></figure>
          : <ShotMediaSkeleton status={current.status ?? 'pending'} image={current.kind === '图片'} large />}
    </div>
  </section>;
}

function MediaEntryThumbnail({ entry }: { entry: MediaEntry }) {
  return entry.asset ? <ResultThumbnail asset={entry.asset} index={entry.index} /> : <ShotMediaSkeleton index={entry.index} status={entry.status ?? 'pending'} image={entry.kind === '图片'} />;
}

function ShotMediaSkeleton({ index, status, image, large = false }: { index?: string; status: GenerationShotProgress['status']; image: boolean; large?: boolean }) {
  const PlaceholderIcon = image ? Image : Clapperboard;
  const active = !large && !['pending', 'completed', 'interrupted', 'canceled'].includes(status);
  return <span className={`${large ? 'step-result__pending-media' : 'step-result__thumbnail'} step-result__media-skeleton`} data-skeleton="true" data-animating={active || undefined} aria-hidden="true">
    {index && <span className="step-result__media-card-index">{index}</span>}
    <PlaceholderIcon size={large ? 32 : 20} aria-hidden="true" />
  </span>;
}

function ResultThumbnail({ asset, index }: { asset: AssetRecord; index: string }) {
  const { container, visible } = useThumbnailVisibility(true);
  const availability = useAssetAvailability(asset.id);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [source, setSource] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    setSource(''); setStatus('loading');
    const element = canvas.current;
    if (!visible) { if (element) { element.width = 1; element.height = 1; } return; }
    if (asset.kind === 'audio') { setStatus('ready'); return; }
    const controller = new AbortController();
    if (asset.kind === 'video') {
      void videoThumbnails.read({ asset, timeUs: 0, width: 256, height: 144 }, controller.signal).then(frame => {
        if (controller.signal.aborted || !element) return;
        element.width = frame.width; element.height = frame.height;
        const context = element.getContext('2d');
        if (!context) throw new Error('无法读取视频缩略图');
        context.drawImage(frame.image, 0, 0); setStatus('ready');
      }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    } else {
      void getAssetUrl(asset.path).then(url => { if (!controller.signal.aborted) setSource(assetAvailabilityUrl(url, asset.id)); }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    }
    return () => controller.abort();
  }, [asset.id, asset.kind, asset.version, asset.sha256, asset.path, visible, availability]);
  return <span ref={container} className="step-result__thumbnail" data-state={status} aria-hidden="true">
    {asset.kind === 'video' && <canvas ref={canvas} width={1} height={1} />}
    {source && <img src={source} alt="" loading="lazy" onLoad={() => setStatus('ready')} onError={() => setStatus('error')} />}
    <span className="step-result__media-card-index">{index}</span>
    {asset.kind === 'audio' ? <Music2 size={24} /> : status === 'error' ? <span className="step-result__thumbnail-state"><TriangleAlert size={16} />预览不可用</span> : status === 'loading' ? <LoaderCircle size={18} className="spin" /> : <span className="step-result__thumbnail-kind">{asset.kind === 'video' ? <Play size={12} /> : <Image size={12} />}</span>}
  </span>;
}

function ResultMedia({ assetId, path, kind, name, exported = false }: { assetId?: string; path: string; kind: AssetRecord['kind']; name: string; exported?: boolean }) {
  const availability = useAssetAvailability(assetId);
  const media = useRef<HTMLMediaElement | null>(null);
  const [source, setSource] = useState<{ url?: string; error?: string }>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true; setSource({});
    void getAssetUrl(path).then(url => { if (current) setSource({ url: assetId ? assetAvailabilityUrl(url, assetId) : url }); }).catch(error => { if (current) setSource({ error: String(error) }); });
    return () => { current = false; };
  }, [assetId, path, retry, availability]);
  useEffect(() => {
    const element = media.current;
    return () => { if (element) { element.pause(); element.removeAttribute('src'); element.load(); } };
  }, [source.url, retry]);
  if (source.error) return <Notice kind="error">{source.error}<Button static onClick={() => setRetry(value => value + 1)}><RefreshCw size={14} />重试预览</Button></Notice>;
  if (!source.url) return <p role="status">正在读取媒体…</p>;
  const failed = () => setSource({ error: '媒体暂时无法预览，请检查文件后重试。' });
  return <>{kind === 'image' ? <img key={retry} src={source.url} alt={name} loading="lazy" onError={failed} /> : kind === 'video' ? <video ref={element => { media.current = element; }} key={retry} src={source.url} controls playsInline preload="metadata" aria-label={name} onError={failed} /> : <audio ref={element => { media.current = element; }} key={retry} src={source.url} controls preload="metadata" aria-label={name} onError={failed} />}
    {exported && <div className="step-result__file-action">
      {nativeDesktop ? <IconButton label="打开文件夹" onClick={() => void revealFile(path).catch(error => setSource({ error: String(error) }))}><FolderOpen size={16} aria-hidden="true" /></IconButton>
        : <a className="icon-button" aria-label="下载成片" title="下载成片" href={source.url} download={name}><Download size={16} strokeWidth={1.75} aria-hidden="true" /></a>}
    </div>}
  </>;
}

const fieldNames: Record<string, string> = { title: '标题', text: '内容', description: '说明', summary: '摘要', result: '结果', outputs: '子流程产物', preset: '动画方式', zoom: '缩放倍率', transition: '转场', shots: '镜头数量', zoomStart: '起始缩放', zoomEnd: '结束缩放', panX: '水平移动', panY: '垂直移动', keyframes: '关键帧', timeUs: '时间（微秒）', durationUs: '时长（微秒）', reason: '说明', message: '说明', warnings: '提示', style: '风格', items: '内容', note: '说明' };
const projectFieldNames = {
  id: null,
  title: '标题',
  brief: '创意简报',
  templateId: null,
  revision: null,
  profile: '视频规格',
  shots: '分镜',
  workflow: '制作流程',
  creativeContext: '创作设定',
  episode: '分集信息',
  episodeSource: '分集来源',
  originalText: '项目原文',
  musicClips: '背景音乐',
  researchSources: '资料来源',
  referenceDisplay: '成片引用编号',
  captionStyle: '字幕样式',
  scenePreset: '默认镜头模板',
  audioMix: '项目混音',
  clipEditSources: '原始镜头',
  clipEditPlans: '剪辑计划',
  claims: '事实主张',
  style: '视觉风格',
  createdAt: '创建时间',
  updatedAt: '更新时间',
  archived: '已归档',
} satisfies Record<keyof ProjectDocument, string | null>;

function EditedProfileResult({ value }: { value: JsonValue }) {
  const profile = videoProfileSchema.safeParse(value).data;
  return profile ? <VideoProfileResult profile={profile} /> : <p className="step-result__empty">视频规格无法读取。</p>;
}

function EditedStoryboardResult({ value }: { value: JsonValue }) {
  const shots = storyboardShots(value);
  return shots.length ? <StoryboardResult shots={shots} view="edited" /> : <p className="step-result__empty">暂无分镜。</p>;
}

function EditedWorkflowResult({ value }: { value: JsonValue }) {
  const workflow = workflowSchema.safeParse(value).data;
  if (!workflow) return <p className="step-result__empty">制作流程无法读取。</p>;
  const stages = resolveWorkbenchStages(workflow);
  return <dl className="step-result__fields" aria-label="流程概览">
    <div><dt>流程名称</dt><dd><p>{workflow.name || '未命名流程'}</p></dd></div>
    {stages ? stages.map(stage => <div key={stage.id}>
      <dt>{stage.label}</dt>
      <dd><p>{stage.nodes.map(node => node.label).join('、') || '暂无步骤'}</p></dd>
    </div>) : <div><dt>制作步骤</dt><dd><p>{workflow.nodes.map(node => node.label).join('、')}</p></dd></div>}
  </dl>;
}

const projectSectionViews: Record<string, ComponentType<{ value: JsonValue }>> = {
  profile: EditedProfileResult,
  shots: EditedStoryboardResult,
  workflow: EditedWorkflowResult,
};
const metadata = new Set(['source', 'modelId', 'providerUsage', 'kind', 'warnings']);
function ResultFields({ value, project = false }: { value: JsonValue; project?: boolean }) {
  const [limit, setLimit] = useState(30);
  if (value === null) return <p className="step-result__empty">本步没有额外的内容产物。</p>;
  if (typeof value !== 'object') return <p className="step-result__value">{typeof value === 'boolean' ? value ? '是' : '否' : value}</p>;
  const labels: Record<string, string | null> = project ? projectFieldNames : fieldNames;
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index + 1), item] as const)
    : Object.entries(value).filter(([key]) => !metadata.has(key) && labels[key] !== null);
  return <dl className="step-result__fields">
    {entries.slice(0, limit).map(([key, item]) => {
      const label = Object.hasOwn(labels, key) ? labels[key] : key;
      const View = project && Object.hasOwn(projectSectionViews, key) ? projectSectionViews[key] : undefined;
      return <div key={key}>
        <dt>{label}</dt>
        <dd>{item && typeof item === 'object'
          ? <NestedResult value={item} summary={View ? `查看${label}` : undefined} View={View} />
          : <ResultFields value={item} />}</dd>
      </div>;
    })}
    {entries.length > limit && <div><Button static onClick={() => setLimit(value => value + 30)}>显示更多结果</Button></div>}
  </dl>;
}
function NestedResult({ value, summary, View = ResultFields }: { value: JsonValue; summary?: string; View?: ComponentType<{ value: JsonValue }> }) {
  const [open, setOpen] = useState(false);
  const label = summary ?? (Array.isArray(value) ? `${value.length} 项内容` : '查看内容');
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open && <View value={value} />}
  </details>;
}
