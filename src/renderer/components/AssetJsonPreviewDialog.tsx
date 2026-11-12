import { useState } from 'react';
import { jsonAssetPreviewSchema, type AssetRecord } from '@video-quickly/contracts';
import { useAssetAvailability } from '../lib/asset-availability';
import { getAssetUrl } from '../lib/client';
import { useRuntimeRead } from '../lib/use-runtime-read';
import { nativeDesktop, revealFile } from '../lib/desktop';
import { Button, Dialog, Notice } from './Primitives';
import './asset-json-preview.css';

export default function AssetJsonPreviewDialog({ asset, owner, onClose }: { asset: AssetRecord; owner?: string; onClose(): void }) {
  const availability = useAssetAvailability(asset.id);
  const preview = useRuntimeRead('asset.read', { assetId: asset.id, format: 'text' }, availability, jsonAssetPreviewSchema);
  const [fileError, setFileError] = useState('');

  async function showOriginal() {
    setFileError('');
    try {
      if (nativeDesktop) await revealFile(asset.path);
      else {
        const link = document.createElement('a');
        link.href = await getAssetUrl(asset.path);
        link.download = asset.name;
        link.click();
      }
    } catch {
      setFileError('无法打开原文件，请检查素材文件。');
    }
  }

  return <Dialog title={asset.name} className="dialog--wide asset-json-preview" onClose={onClose}>
    <div className="dialog__body">
      {owner && <p className="asset-json-preview__owner">{owner}</p>}
      {preview.error ? <Notice kind="error">{preview.error}<Button static onClick={preview.refresh}>重试</Button></Notice>
        : preview.data ? <>
          {preview.data.truncated && <Notice>文件较大，当前显示开头部分。<Button static onClick={() => void showOriginal()}>{nativeDesktop ? '在文件夹中显示' : '下载原文件'}</Button></Notice>}
          {fileError && <Notice kind="error">{fileError}</Notice>}
          {preview.data.text ? <pre className="asset-json-preview__content" role="region" aria-label="JSON 内容" tabIndex={0}>{preview.data.text}</pre>
            : <p role="status">JSON 文件为空。</p>}
        </> : <p role="status">正在读取 JSON 文件…</p>}
    </div>
  </Dialog>;
}
