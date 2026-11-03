import { useEffect, useRef, useState } from 'react';
import { Check, Clapperboard, Clock3, Download, Film, FolderOpen, Image, Mic, RefreshCw } from 'lucide-react';
import { assetSchema, captionTrackSchema, type AssetRecord, type JsonValue, type WorkflowNode } from '@video-quickly/contracts';
import { getAssetUrl } from '../lib/client';
import { assetAvailabilityUrl, useAssetAvailability } from '../lib/asset-availability';
import { nativeDesktop, revealFile } from './PathPicker';
import { Button, Notice, formatTime } from './Primitives';
import './step-result-view.css';

function record(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
const copy = (value: JsonValue | undefined) => typeof value === 'string' ? value : '';
const duration = (value: JsonValue | undefined) => typeof value === 'number' && value > 0 ? value : 0;

export default function StepResultView({ value, kind }: { value: JsonValue; kind: WorkflowNode['kind'] }) {
  const object = record(value);
  const shots = Array.isArray(object?.shots) ? object.shots.flatMap(value => { const shot = record(value); return shot ? [shot] : []; }) : [];
  const assets = (Array.isArray(object?.assets) ? object.assets : []).flatMap(value => {
    const parsed = assetSchema.safeParse(value);
    return parsed.success && ['image', 'audio', 'video'].includes(parsed.data.kind) ? [parsed.data] : [];
  });
  const captions = captionTrackSchema.safeParse(object?.captionTrack);
  const claims = Array.isArray(object?.claims) ? object.claims.flatMap(value => { const claim = record(value); return claim ? [claim] : []; }) : [];
  const text = typeof value === 'string' ? value : copy(object?.text) || copy(object?.style) || copy(object?.brief);
  const exportPath = kind === 'export' ? copy(object?.videoPath) || copy(object?.outputPath) || copy(object?.path) : '';
  const localCount = [object?.assetIds, object?.audioAssetIds].find(Array.isArray)?.length;
  const specialized = shots.length || assets.length || captions.success || claims.length || text || exportPath || localCount !== undefined;

  return <div className="step-result" aria-label="制作结果">
    {shots.length > 0 && <section aria-label={kind === 'animation' ? '镜头动画' : '分镜预览'}>
      <div className="step-result__summary"><span><Clapperboard size={16} />{shots.length} 个镜头</span>{shots.some(shot => duration(shot.durationUs)) && <span><Clock3 size={15} />共 {(shots.reduce((sum, shot) => sum + duration(shot.durationUs), 0) / 1_000_000).toFixed(1)} 秒</span>}</div>
      <ol className="step-result__storyboard">{shots.map((shot, index) => <li key={copy(shot.id) || index}>
        <header><span className="step-result__index">{String(index + 1).padStart(2, '0')}</span><h4>{copy(shot.title) || `镜头 ${index + 1}`}</h4>{duration(shot.durationUs) > 0 && <span>{(duration(shot.durationUs) / 1_000_000).toFixed(1)} 秒</span>}</header>
        {copy(shot.visualPrompt) && <div className="step-result__visual"><Image size={20} aria-hidden="true" /><p>{copy(shot.visualPrompt)}</p><small>画面要求</small></div>}
        {copy(shot.narration) && <div className="step-result__narration"><Mic size={15} aria-hidden="true" /><p>{copy(shot.narration)}</p></div>}
        {kind === 'animation' && record(shot.animation) && <div className="step-result__animation"><span>动画与运镜</span><ResultFields value={shot.animation} /></div>}
      </li>)}</ol>
    </section>}
    {assets.length > 0 && <MediaGallery assets={assets} exported={kind === 'export'} />}
    {exportPath && !assets.some(asset => asset.kind === 'video') && <figure className="step-result__media"><ResultMedia path={exportPath} kind="video" name="导出成片" exported /></figure>}
    {captions.success && <CaptionResult track={captions.data} />}
    {claims.length > 0 && <section className="step-result__claims" aria-label="资料主张"><div className="step-result__summary">{claims.length} 条主张</div>{claims.map((claim, index) => <article key={copy(claim.id) || index}><header><strong>主张 {index + 1}</strong><span>{claim.status === 'verified' && object?.readonly === true ? '已核验' : claim.status === 'disputed' ? '存在争议' : '待核验'}</span></header><p>{copy(claim.text)}</p>{copy(claim.evidence) && <blockquote>{copy(claim.evidence)}</blockquote>}</article>)}</section>}
    {text && !shots.length && !captions.success && !claims.length && <article className="step-result__document" aria-label={kind === 'style' ? '视觉风格' : kind === 'brief' ? '创作简报' : '创作内容'}>{copy(object?.title) && <h3>{copy(object?.title)}</h3>}{text.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</article>}
    {localCount !== undefined && !assets.length && <div className="step-result__checkpoint"><Check size={22} /><div><strong>已沿用 {localCount} 份画面素材</strong><p>可在项目预览中查看已关联的内容。</p></div></div>}
    {!specialized && kind === 'review' ? <div className="step-result__checkpoint"><Check size={24} /><div><strong>自动检查结果</strong><p>检查完成后，流程会自动继续后续步骤。</p></div></div>
      : !specialized && kind === 'join' ? <div className="step-result__checkpoint"><Check size={24} /><strong>上游分支已汇合</strong></div>
        : !specialized && kind === 'condition' ? <div className="step-result__checkpoint"><Check size={24} /><div><strong>{object?.matched === true ? '条件成立' : '条件不成立'}</strong><p>流程将沿对应的连接继续。</p></div></div>
          : !specialized && <ResultFields value={value} />}
    {Array.isArray(object?.warnings) && object.warnings.length > 0 && <Notice>{object.warnings.map((warning, index) => <p key={index}>{copy(warning)}</p>)}</Notice>}
  </div>;
}

function CaptionResult({ track }: { track: ReturnType<typeof captionTrackSchema.parse> }) {
  const [limit, setLimit] = useState(100);
  return <section aria-label="字幕预览"><div className="step-result__summary">{track.cues.length} 条字幕 · {track.alignment === 'speech' ? '语音对齐' : track.alignment === 'estimated' ? '预估时间，需核对' : '手动时间'}</div><ol className="step-result__captions">{track.cues.slice(0, limit).map(cue => <li key={cue.id}><time>{formatTime(cue.startUs)} — {formatTime(cue.endUs)}</time><p>{cue.text}</p></li>)}</ol>{track.cues.length > limit && <Button static onClick={() => setLimit(value => value + 100)}>显示更多字幕</Button>}</section>;
}

function MediaGallery({ assets, exported }: { assets: AssetRecord[]; exported: boolean }) {
  const [selectedId, setSelectedId] = useState('');
  const selected = assets.find(asset => asset.id === selectedId) ?? (exported ? assets.find(asset => asset.kind === 'video') : undefined) ?? assets[0];
  return <section aria-label="产物媒体">
    <figure className="step-result__media"><ResultMedia key={`${selected.id}:${selected.version}:${selected.sha256}:${selected.path}`} assetId={selected.id} path={selected.path} kind={selected.kind} name={selected.name} exported={exported && selected.kind === 'video'} />{!exported && <figcaption>{selected.name}</figcaption>}</figure>
    {assets.length > 1 && <div className="step-result__asset-list" aria-label="选择媒体">{assets.map(asset => <button type="button" key={asset.id} aria-pressed={selected.id === asset.id} onClick={() => setSelectedId(asset.id)}>{asset.kind === 'image' ? <Image size={16} /> : asset.kind === 'audio' ? <Mic size={16} /> : <Film size={16} />}<span>{asset.name}</span></button>)}</div>}
  </section>;
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
const metadata = new Set(['source', 'modelId', 'providerUsage', 'kind']);
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
