import { useEffect, useId, useRef, useState } from 'react';
import { Captions, FileImage, FileJson, FileText, Play, RotateCcw, ShieldCheck, Trash2, UserPlus, Video } from 'lucide-react';
import { isCreativeReferenceAsset, isJsonDocument, type AssetListItem, type AssetRecord } from '@video-quickly/contracts';
import AssetJsonPreviewDialog from '../components/AssetJsonPreviewDialog';
import { useConfirmation } from '../components/ConfirmationDialog';
import { Button, Dialog, IconButton, Notice, formatTime } from '../components/Primitives';
import { videoThumbnails } from '../components/preview-thumbnails';
import { useThumbnailVisibility } from '../components/thumbnail-visibility';
import { assetAvailabilityUrl, useAssetAvailability } from '../lib/asset-availability';
import { getAssetUrl } from '../lib/client';
import type { Action } from '../lib/types';

export function canRemoveAsset(asset: AssetListItem) {
  return !asset.inUse && !asset.retained;
}

export function isVisualAsset(asset: AssetRecord) {
  return asset.kind === 'image' || asset.kind === 'video';
}

function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AssetCard({ asset, owner, action, onRestored, onCreateCharacter, selection }: {
  asset: AssetListItem;
  owner: string;
  action: Action;
  onRestored(): void;
  onCreateCharacter(asset: AssetRecord): void;
  selection?: { checked: boolean; busy: boolean; onChange(checked: boolean): void };
}) {
  const [previewing, setPreviewing] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const confirm = useConfirmation();
  const titleId = useId();
  const ownerId = `${titleId}-owner`;

  async function removeAsset() {
    const subject = asset.projectId ? `「${owner}」的“${asset.name}”` : `“${asset.name}”`;
    if (!await confirm({ title: '移除素材记录？', description: `${subject}将移入回收站。素材文件会保留，可在回收站恢复。`, confirmLabel: '确认移除' })) return;
    await action('asset.delete', { assetId: asset.id }, '素材已移入回收站');
  }

  async function restoreAsset() {
    setRestoring(true);
    try {
      if (await action('asset.restore', { assetId: asset.id }, '素材已恢复') !== null) onRestored();
    } finally {
      setRestoring(false);
    }
  }

  const visual = isVisualAsset(asset);
  const audio = asset.kind === 'audio';
  const json = isJsonDocument(asset);
  const removable = canRemoveAsset(asset);
  const checked = removable && Boolean(selection?.checked);
  const source = asset.provenance === '用户导入' ? undefined : asset.provenance;
  const extension = json ? 'JSON' : visual ? undefined : /\.([a-z\d]+)$/i.exec(asset.name)?.[1]?.toUpperCase();
  const FileIcon = asset.kind === 'subtitle' ? Captions : FileText;
  const choice = selection && <label className={visual ? 'library-card-choice' : 'asset-card__file-icon asset-card__file-choice'}>
    <input type="checkbox" aria-label={`选择“${asset.name}”`} aria-describedby={ownerId} checked={checked} disabled={selection.busy || !removable} onChange={event => selection.onChange(event.target.checked)} />
  </label>;

  return <article className="asset-card" aria-labelledby={titleId} aria-describedby={ownerId} data-kind={asset.kind} data-selected={checked || undefined}>
    {visual ? <div className="asset-card__preview">
      {selection ? <AssetThumbnail asset={asset} /> : <button type="button" className="asset-card__preview-button" aria-label={`预览“${asset.name}”`} aria-describedby={ownerId} title={asset.kind === 'image' ? '查看大图' : '播放视频'} onClick={() => setPreviewing(true)}>
        <AssetThumbnail asset={asset} />
        {asset.kind === 'video' && <span className="asset-card__play-icon" aria-hidden="true"><Play size={14} /></span>}
      </button>}
      {choice}
    </div> : choice ?? (audio || json
      ? <IconButton label={`${audio ? '试听' : '查看'}“${asset.name}”`} aria-describedby={ownerId} title={audio ? '试听音频' : '查看 JSON'} className="asset-card__file-icon" onClick={() => setPreviewing(true)}>
        {audio ? <Play size={16} aria-hidden="true" /> : <FileJson size={16} aria-hidden="true" />}
      </IconButton>
      : <span className="asset-card__file-icon" aria-hidden="true"><FileIcon size={19} /></span>)}
    <div className="asset-card__details">
      <h3 id={titleId} title={asset.name}>{asset.name}</h3>
      <span id={ownerId} className="asset-card__owner" title={owner}>{owner}</span>
      <div className="asset-card__meta">
        {extension && <span>{extension}</span>}
        {asset.durationUs && <span>{formatTime(asset.durationUs)}</span>}
        <span>{fileSize(asset.size)}</span>
        {asset.inUse && <span>使用中</span>}
        {asset.retained && <span>已保留</span>}
        {source && <span className="asset-card__source" title={source}>{source}</span>}
      </div>
    </div>
    {!selection && <div className="asset-actions">
      {asset.active ? <>
        {isCreativeReferenceAsset({}, asset) && <IconButton label={`用“${asset.name}”新建角色`} title="用此图新建角色" onClick={() => onCreateCharacter(asset)}><UserPlus size={16} aria-hidden="true" /></IconButton>}
        <IconButton label={asset.retained ? '取消保留此版本' : '保留此版本'} aria-describedby={ownerId} aria-pressed={asset.retained} onClick={() => void action('asset.retain', { assetId: asset.id, retained: !asset.retained }, asset.retained ? '已取消保留' : '此版本已保留')}><ShieldCheck size={16} aria-hidden="true" /></IconButton>
        <IconButton label={`移除素材“${asset.name}”`} aria-describedby={ownerId} title="移入回收站" disabled={!removable} onClick={() => void removeAsset()}><Trash2 size={16} aria-hidden="true" /></IconButton>
      </> : <IconButton label={`恢复素材“${asset.name}”`} aria-describedby={ownerId} busy={restoring} onClick={() => void restoreAsset()}><RotateCcw size={16} aria-hidden="true" /></IconButton>}
    </div>}
    {previewing && (json ? <AssetJsonPreviewDialog asset={asset} owner={owner} onClose={() => setPreviewing(false)} /> : <AssetPreviewDialog asset={asset} onClose={() => setPreviewing(false)} />)}
  </article>;
}

function AssetThumbnail({ asset }: { asset: AssetRecord }) {
  const { container, visible } = useThumbnailVisibility(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const availability = useAssetAvailability(asset.id);
  const [thumbnail, setThumbnail] = useState<{ status: 'loading' | 'ready' | 'error'; url?: string }>({ status: 'loading' });
  const image = asset.kind === 'image';

  useEffect(() => {
    setThumbnail({ status: 'loading' });
    const element = canvas.current;
    if (!visible) {
      if (element) { element.width = 1; element.height = 1; }
      return;
    }
    const controller = new AbortController();
    const fail = () => { if (!controller.signal.aborted) setThumbnail({ status: 'error' }); };
    if (image) {
      void getAssetUrl(asset.path).then(url => {
        if (!controller.signal.aborted) setThumbnail({ status: 'loading', url: assetAvailabilityUrl(url, asset.id) });
      }).catch(fail);
    } else {
      void videoThumbnails.read({ asset, timeUs: 0, width: 256, height: 144 }, controller.signal).then(frame => {
        if (controller.signal.aborted || !element) return;
        element.width = frame.width;
        element.height = frame.height;
        const context = element.getContext('2d');
        if (!context) throw new Error('无法读取视频缩略图。');
        context.drawImage(frame.image, 0, 0);
        setThumbnail({ status: 'ready' });
      }).catch(fail);
    }
    return () => controller.abort();
  }, [asset.id, asset.path, asset.version, asset.sha256, image, visible, availability]);

  const Placeholder = image ? FileImage : Video;
  return <span ref={container} className="asset-card__thumbnail" data-state={thumbnail.status}>
    {thumbnail.url && <img src={thumbnail.url} alt="" loading="lazy" decoding="async"
      onLoad={() => setThumbnail(current => ({ ...current, status: 'ready' }))} onError={() => setThumbnail({ status: 'error' })} />}
    {!image && <canvas ref={canvas} width={1} height={1} aria-hidden="true" />}
    {thumbnail.status !== 'ready' && <span className="asset-card__placeholder" role={thumbnail.status === 'error' ? 'img' : undefined}
      aria-label={thumbnail.status === 'error' ? `无法预览“${asset.name}”` : undefined}><Placeholder size={24} aria-hidden="true" />
      {thumbnail.status === 'error' && <span>缩略图不可用</span>}
    </span>}
  </span>;
}

function AssetPreviewDialog({ asset, onClose }: { asset: AssetRecord; onClose(): void }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const availability = useAssetAvailability(asset.id);
  const [source, setSource] = useState<{ url?: string; failed?: true }>({});
  const [retry, setRetry] = useState(0);
  const fail = () => setSource({ failed: true });
  const kindLabel = asset.kind === 'image' ? '图片' : asset.kind === 'video' ? '视频' : '音频';

  useEffect(() => {
    let active = true;
    setSource({});
    void getAssetUrl(asset.path).then(url => {
      if (active) setSource({ url: assetAvailabilityUrl(url, asset.id) });
    }).catch(() => { if (active) fail(); });
    return () => { active = false; };
  }, [asset.id, asset.path, availability, retry]);

  useEffect(() => {
    const element = media.current;
    return () => {
      if (!element) return;
      element.pause();
      element.removeAttribute('src');
      element.load();
    };
  }, [source.url]);

  return <Dialog title={asset.name} className={`asset-preview-dialog${isVisualAsset(asset) ? ' dialog--wide' : ''}`}
    onDismissStart={() => media.current?.pause()} onClose={onClose}>
    <div className="dialog__body">
      {source.failed ? <Notice kind="error">无法预览此{kindLabel}。<Button static onClick={() => setRetry(value => value + 1)}>重试</Button></Notice>
        : !source.url ? <p role="status">正在读取{kindLabel}…</p>
          : asset.kind === 'image' ? <img src={source.url} alt={asset.name} decoding="async" onError={fail} />
            : asset.kind === 'video' ? <video ref={element => { media.current = element; }} src={source.url} aria-label={asset.name} controls preload="metadata" playsInline onError={fail} />
              : <audio ref={element => { media.current = element; }} src={source.url} aria-label={asset.name} controls preload="metadata" onError={fail} />}
    </div>
  </Dialog>;
}
