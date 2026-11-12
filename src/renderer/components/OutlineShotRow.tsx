import { memo } from 'react';
import { Check, LockKeyhole } from 'lucide-react';
import type { AssetRecord, Shot } from '@video-quickly/contracts';
import type { SelectionModifiers } from '../lib/shot-selection';
import { ScenePreview, type ScenePreviewProject } from './ScenePreview';

interface Props {
  project: ScenePreviewProject; shot: Shot; index: number; assets: AssetRecord[];
  selected: boolean; primary: boolean; multipleSelected: boolean; modifierLabel: string;
  onSelectShot: (id: string, modifiers?: SelectionModifiers) => void | Promise<void>;
}

export default memo(function OutlineShotRow({ project, shot, index, assets, selected, primary, multipleSelected, modifierLabel, onSelectShot }: Props) {
  return <button type="button" className={`shot-card outline-shot ${selected ? 'selected' : ''} ${primary ? 'active' : ''}`} aria-pressed={selected} aria-keyshortcuts="Control+Space Meta+Space Shift+Enter" onClick={event => void onSelectShot(shot.id, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey, keepGroup: !event.ctrlKey && !event.metaKey && !event.shiftKey && selected })} title={`${shot.title}；${modifierLabel} 切换选择，Shift 连续选择`}>
    <div className="shot-thumbnail"><ScenePreview project={project} shot={shot} shotIndex={index} assets={assets} thumbnail /><span className="shot-thumb-index">{(index + 1).toString().padStart(2, '0')}</span>{multipleSelected && <span className="outline-shot-selection" aria-hidden="true"><Check size={11} /></span>}</div>
    <div className="outline-shot-copy"><div className="shot-card-info"><strong>{shot.title}</strong>{shot.locked ? <LockKeyhole size={12} aria-label="镜头已锁定" /> : shot.assetId || shot.videoAssetId ? <Check size={12} aria-label="已添加画面素材" /> : null}</div><div className="outline-shot-meta">{(shot.durationUs / 1_000_000).toFixed(1)} 秒</div></div>
  </button>;
});
