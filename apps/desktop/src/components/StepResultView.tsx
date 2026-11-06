import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Clapperboard, Clock3, Download, FolderOpen, Image, LoaderCircle, Music2, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import { assetSchema, captionTrackSchema, creativeContextSchema, creativeEntityLabels, workflowProposalSchema, workflowProposalChanges, type AssetRecord, type GenerationShotProgress, type JsonValue, type RunStepPayload, type RunStepProgressDetail, type WorkflowNode } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';
import { assetAvailabilityUrl, useAssetAvailability } from '../lib/asset-availability';
import { nativeDesktop, revealFile } from './PathPicker';
import { Button, IconButton, Notice, formatTime } from './Primitives';
import { videoThumbnails } from './preview-thumbnails';
import { useThumbnailVisibility } from './thumbnail-visibility';
import ResultDocument from './ResultDocument';
import { ProgressIcon } from './StepProgress';
import { generationShotLabels } from '../lib/run-progress';
import './step-result-view.css';

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
const copy = (value: JsonValue | undefined) => typeof value === 'string' ? value : '';
const duration = (value: JsonValue | undefined) => typeof value === 'number' && value > 0 ? value : 0;

export default function StepResultView({ value, kind, mediaShots, mediaGeneration, progress, onRegenerate }: { value: JsonValue; kind: WorkflowNode['kind']; mediaShots?: RunStepPayload['mediaShots']; mediaGeneration?: RunStepPayload['mediaGeneration']; progress?: RunStepProgressDetail; onRegenerate?: (shotId: string, kind: 'image' | 'video') => void }) {
  const object = record(value);
  const shots = Array.isArray(object?.shots) ? object.shots.flatMap(value => { const shot = record(value); return shot ? [shot] : []; }) : [];
  const assets = useMemo(() => {
    const values = record(value)?.assets;
    return Array.isArray(values) ? values.flatMap(value => {
      const parsed = assetSchema.safeParse(value);
      return parsed.success && ['image', 'audio', 'video'].includes(parsed.data.kind) ? [parsed.data] : [];
    }) : [];
  }, [value]);
  const captions = captionTrackSchema.safeParse(object?.captionTrack);
  const creative = creativeContextSchema.safeParse(object?.creativeContext);
  const proposal = workflowProposalSchema.safeParse(object?.proposal);
  const proposalError = copy(object?.proposalError);
  const claims = Array.isArray(object?.claims) ? object.claims.flatMap(value => { const claim = record(value); return claim ? [claim] : []; }) : [];
  const text = typeof value === 'string' ? value : copy(object?.text) || copy(object?.style) || copy(object?.brief);
  const exportPath = kind === 'export' ? copy(object?.videoPath) || copy(object?.outputPath) || copy(object?.path) : '';
  const localCount = [object?.referenceAssetIds, object?.assetIds, object?.audioAssetIds].find(Array.isArray)?.filter(Boolean).length;
  const preparedShots = kind === 'animation' && typeof object?.shots === 'number' ? object.shots : undefined;
  const specialized = shots.length || assets.length || progress?.shots.length || captions.success || claims.length || text || exportPath || localCount !== undefined || preparedShots !== undefined || proposal.success || proposalError;

  return <div className="step-result" aria-label="制作结果">
    {shots.length > 0 && <StoryboardResult shots={shots} animation={kind === 'animation'} />}
    {creative.success && (creative.data.entities.length > 0 || creative.data.characterIds.length > 0 || creative.data.continuity) && <section className="step-result__document" aria-label="本次创作设定"><h3>创作设定</h3>{creative.data.characterIds.length > 0 && <p>{creative.data.characterIds.length} 个参考角色</p>}{creative.data.continuity && <p><strong>连续性要求</strong><br />{creative.data.continuity}</p>}{creative.data.entities.map(entity => <p key={entity.key}><strong>{creativeEntityLabels[entity.kind]}：{entity.name}</strong><br />{entity.description}</p>)}</section>}
    {(assets.length > 0 || Boolean(progress?.shots.length)) && <MediaGallery assets={assets} shots={mediaShots} exported={kind === 'export'} nodeKind={kind} progress={progress} mediaGeneration={mediaGeneration} onRegenerate={onRegenerate} />}
    {exportPath && !assets.some(asset => asset.kind === 'video') && <figure className="step-result__media"><ResultMedia path={exportPath} kind="video" name="导出成片" exported /></figure>}
    {captions.success && <CaptionResult track={captions.data} />}
    {claims.length > 0 && <section className="step-result__claims" aria-label="资料主张"><div className="step-result__summary">{claims.length} 条主张</div>{claims.map((claim, index) => <article key={copy(claim.id) || index}><header><strong>主张 {index + 1}</strong><span>{claim.status === 'verified' && object?.readonly === true ? '已核验' : claim.status === 'disputed' ? '存在争议' : '待核验'}</span></header><p>{copy(claim.text)}</p>{copy(claim.evidence) && <blockquote>{copy(claim.evidence)}</blockquote>}</article>)}</section>}
    {(proposal.success || proposalError) && <section className="step-result__document" aria-label="任务修改建议">{proposal.success && <><h3>{proposal.data.summary}</h3><dl className="step-result__fields">{workflowProposalChanges(proposal.data).map(change => <div key={change.field}><dt>{change.label}</dt><dd><p>当前内容：{change.before || '未设置'}</p><p>建议内容：{change.after || '未设置'}</p></dd></div>)}</dl></>}{proposalError && <Notice kind="error">{proposalError}</Notice>}<p>在对应任务的“对话修改任务”中打开已保存建议，核对修订后应用到草稿。</p>{text && <details><summary>原始模型结果</summary><pre>{text}</pre></details>}</section>}
    {text && !shots.length && !captions.success && !claims.length && !proposal.success && !proposalError && <ResultDocument text={text} title={copy(object?.title)} label={kind === 'style' ? '视觉风格' : kind === 'brief' ? '创作简报' : '创作内容'} />}
    {localCount !== undefined && !assets.length && <div className="step-result__checkpoint"><Check size={20} /><strong>{localCount ? `已沿用 ${localCount} 份素材` : '本步骤未添加参考素材'}</strong></div>}
    {preparedShots !== undefined && <div className="step-result__checkpoint"><Check size={20} /><div><strong>{preparedShots} 个镜头已就绪</strong>{copy(object?.message) && <p>{copy(object?.message)}</p>}</div></div>}
    {!specialized && kind === 'review' ? <div className="step-result__checkpoint"><Check size={24} /><div><strong>自动检查结果</strong><p>检查完成后，流程会自动继续后续步骤。</p></div></div>
      : !specialized && kind === 'join' ? <div className="step-result__checkpoint"><Check size={24} /><strong>上游分支已汇合</strong></div>
        : !specialized && kind === 'condition' ? <div className="step-result__checkpoint"><Check size={24} /><div><strong>{object?.matched === true ? '条件成立' : '条件不成立'}</strong><p>流程将沿对应的连接继续。</p></div></div>
          : !specialized && <ResultFields value={value} />}
    {Array.isArray(object?.warnings) && object.warnings.length > 0 && <Notice>{object.warnings.map((warning, index) => <p key={index}>{copy(warning)}</p>)}</Notice>}
  </div>;
}

function StoryboardResult({ shots, animation }: { shots: Record<string, JsonValue>[]; animation: boolean }) {
  const [limit, setLimit] = useState(20);
  const seconds = shots.reduce((sum, shot) => sum + duration(shot.durationUs), 0) / 1_000_000;
  return <section aria-label={animation ? '镜头动画' : '分镜预览'}>
    <div className="step-result__summary"><span><Clapperboard size={16} />{shots.length} 个镜头</span>{seconds > 0 && <span><Clock3 size={15} />{seconds.toFixed(1)} 秒</span>}</div>
    <ol className="step-result__storyboard">{shots.slice(0, limit).map((shot, index) => <li key={copy(shot.id) || index}>
      <header><span className="step-result__index">{String(index + 1).padStart(2, '0')}</span><h4>{copy(shot.title) || `镜头 ${index + 1}`}</h4>{duration(shot.durationUs) > 0 && <span>{(duration(shot.durationUs) / 1_000_000).toFixed(1)} 秒</span>}</header>
      {copy(shot.visualPrompt) && <div className="step-result__copy"><span>画面</span><p>{copy(shot.visualPrompt)}</p></div>}
      {copy(shot.narration) && <div className="step-result__copy"><span>旁白</span><p>{copy(shot.narration)}</p></div>}
      {copy(shot.soundPrompt) && <div className="step-result__copy"><span>声音</span><p>{copy(shot.soundPrompt)}</p></div>}
      {animation && record(shot.animation) && <details className="step-result__animation"><summary>动画与运镜</summary><ResultFields value={shot.animation} /></details>}
    </li>)}</ol>
    {shots.length > limit && <Button static onClick={() => setLimit(value => value + 20)}>显示更多镜头</Button>}
  </section>;
}

function CaptionResult({ track }: { track: ReturnType<typeof captionTrackSchema.parse> }) {
  const [limit, setLimit] = useState(20);
  return <section aria-label="字幕预览"><div className="step-result__summary">{track.cues.length} 条字幕 · {track.alignment === 'speech' ? '语音对齐' : track.alignment === 'estimated' ? '预估时间，需核对' : '手动时间'}</div><ol className="step-result__captions">{track.cues.slice(0, limit).map(cue => <li key={cue.id}><time>{formatTime(cue.startUs)} — {formatTime(cue.endUs)}</time><p>{cue.text}</p></li>)}</ol>{track.cues.length > limit && <Button static onClick={() => setLimit(value => value + 20)}>显示更多字幕</Button>}</section>;
}

interface MediaEntry { id: string; asset?: AssetRecord; reference?: AssetRecord; status?: GenerationShotProgress['status']; shotId?: string; kind: string; title: string; index: string; durationUs?: number }
function MediaGallery({ assets, shots, exported, nodeKind, progress, mediaGeneration, onRegenerate }: { assets: AssetRecord[]; shots?: RunStepPayload['mediaShots']; exported: boolean; nodeKind: WorkflowNode['kind']; progress?: RunStepProgressDetail; mediaGeneration?: RunStepPayload['mediaGeneration']; onRegenerate?: (shotId: string, kind: 'image' | 'video') => void }) {
  const [selectedId, setSelectedId] = useState('');
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
  return <section aria-label="产物媒体" className="step-result__gallery" data-multiple={showCards || undefined} data-regeneration={!exported && (Boolean(onRegenerate) || Boolean(progress?.shots.length)) || undefined} data-progress={Boolean(progress?.shots.length) && !onRegenerate || undefined}>
    {showCards && <>
      <div className="step-result__gallery-summary"><strong>{count}</strong><span>选择缩略图预览</span></div>
      <div ref={grid} className="step-result__media-grid" role="group" aria-label="选择预览素材">{entries.map(entry => <div key={entry.id} className="step-result__media-card" data-shot-id={entry.shotId} data-selected={entry.id === current.id} data-generation-state={entry.status}>
        <button type="button" className="step-result__media-select" data-asset-id={entry.asset?.id} aria-label={`预览${entry.title}（${entry.kind}）`} aria-pressed={entry.id === current.id} onClick={() => setSelectedId(entry.id)}>
        <MediaEntryThumbnail entry={entry} />
        <span className="step-result__media-card-copy"><strong title={entry.title}>{entry.title}</strong>{entry.id === current.id && <Check size={14} aria-label="当前预览" />}</span>
        <span className="step-result__media-card-meta">{entry.status ? <><span className="generation-state" data-state={entry.status}><ProgressIcon status={entry.status} size={12} />{generationShotLabels[entry.status]}</span>{entry.durationUs ? ` · ${(entry.durationUs / 1_000_000).toFixed(1)} 秒` : ''}</> : <>{entry.kind}{entry.durationUs ? ` · ${(entry.durationUs / 1_000_000).toFixed(1)} 秒` : ''}</>}</span>
        </button>
        {!exported && onRegenerate && entry.asset && entry.shotId && ['image', 'video'].includes(entry.asset.kind) && <Button static className="step-result__regenerate" variant="ghost" aria-label={`重新生成镜头 ${entry.index}：${entry.title}`} disabled={!mediaGeneration || mediaGeneration.kind !== entry.asset.kind} title={!mediaGeneration ? '本次制作未保存对应的生成模型' : undefined} onClick={() => { if (entry.shotId && entry.asset) onRegenerate(entry.shotId, entry.asset.kind === 'video' ? 'video' : 'image'); }}><RefreshCw size={12} />重新生成</Button>}
      </div>)}</div>
    </>}
    <div className="step-result__preview">
      <div className="step-result__preview-heading"><div><h4>{current.title}</h4><p>{current.kind}{current.durationUs ? ` · ${(current.durationUs / 1_000_000).toFixed(1)} 秒` : ''}{selected?.width && selected.height ? ` · ${selected.width} × ${selected.height}` : ''}<span className="generation-state" data-state={current.status ?? 'completed'}><ProgressIcon status={current.status ?? 'completed'} size={12} />{selected ? '已保存' : generationShotLabels[current.status ?? 'pending']}</span></p></div>{entries.length > 1 && <div className="step-result__preview-navigation"><span>{selectedIndex + 1} / {entries.length}</span><IconButton label="上一个素材" disabled={selectedIndex === 0} onClick={() => setSelectedId(entries[selectedIndex - 1].id)}><ChevronLeft size={16} /></IconButton><IconButton label="下一个素材" disabled={selectedIndex === entries.length - 1} onClick={() => setSelectedId(entries[selectedIndex + 1].id)}><ChevronRight size={16} /></IconButton></div>}</div>
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
  const active = !['pending', 'completed', 'interrupted', 'canceled'].includes(status);
  return <span className={`${large ? 'step-result__pending-media' : 'step-result__thumbnail'} step-result__media-skeleton`} data-skeleton="true" data-animating={active || undefined} aria-hidden={!large || undefined} role={large ? 'status' : undefined}>
    {index && <span className="step-result__media-card-index">{index}</span>}
    <PlaceholderIcon size={large ? 32 : 20} aria-hidden="true" />
    {large && <span>{generationShotLabels[status]}</span>}
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
    {exported && <div className="step-result__file-action">{nativeDesktop ? <Button static onClick={() => void revealFile(path).catch(error => setSource({ error: String(error) }))}><FolderOpen size={16} />打开文件夹</Button> : <a className="button" href={source.url} download={name}><Download size={16} />下载成片</a>}</div>}
  </>;
}

const fieldNames: Record<string, string> = { title: '标题', text: '内容', description: '说明', summary: '摘要', result: '结果', outputs: '子流程产物', preset: '动画方式', zoom: '缩放倍率', transition: '转场', shots: '镜头数量', zoomStart: '起始缩放', zoomEnd: '结束缩放', panX: '水平移动', panY: '垂直移动', keyframes: '关键帧', timeUs: '时间（微秒）', durationUs: '时长（微秒）', reason: '说明', message: '说明', warnings: '提示', style: '风格', items: '内容', note: '说明' };
const metadata = new Set(['source', 'modelId', 'providerUsage', 'kind', 'warnings']);
function ResultFields({ value }: { value: JsonValue }) {
  const [limit, setLimit] = useState(30);
  if (value === null) return <p className="step-result__empty">本步没有额外的内容产物。</p>;
  if (typeof value !== 'object') return <p className="step-result__value">{typeof value === 'boolean' ? value ? '是' : '否' : value}</p>;
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index + 1), item] as const) : Object.entries(value).filter(([key]) => !metadata.has(key));
  return <dl className="step-result__fields">{entries.slice(0, limit).map(([key, item]) => <div key={key}><dt>{fieldNames[key] ?? key}</dt><dd>{item && typeof item === 'object' ? <NestedResult value={item} /> : <ResultFields value={item} />}</dd></div>)}{entries.length > limit && <div><Button static onClick={() => setLimit(value => value + 30)}>显示更多结果</Button></div>}</dl>;
}
function NestedResult({ value }: { value: JsonValue }) {
  const [open, setOpen] = useState(false);
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)}><summary>{Array.isArray(value) ? `${value.length} 项内容` : '查看内容'}</summary>{open && <ResultFields value={value} />}</details>;
}
