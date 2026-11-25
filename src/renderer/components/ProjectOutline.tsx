import { primaryModifier } from '../lib/desktop';
import { memo, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { Film, ListChecks, SlidersHorizontal, X, Plus } from 'lucide-react';
import type { AssetRecord, ProjectDocument } from '@video-quickly/contracts';
import { IconButton } from './Primitives';
import type { SelectionModifiers } from '../lib/shot-selection';
import OutlineShotRow from './OutlineShotRow';
import { useScenePreviewContext } from '../lib/scene-preview-context';
import { useCommittedCallback } from '../lib/use-committed-callback';
import { useStoryboardReorder, type ReorderStoryboard } from './use-storyboard-reorder';
import './storyboard-reorder.css';

interface ProjectOutlineProps {
  project: ProjectDocument;
  assets: AssetRecord[];
  selectedShotId?: string;
  selectedIds?: readonly string[];
  onSelectShot: (id: string, modifiers?: SelectionModifiers) => void | Promise<void>;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
  onBulkEdit?: () => void;
  onAddShot?: () => Promise<void>;
  reorderRevision?: number;
  onReorderShots?: ReorderStoryboard;
  actions?: ReactNode;
}

export default memo(function ProjectOutline({ project, assets, selectedShotId, selectedIds, onSelectShot, onSelectAll, onClearSelection, onBulkEdit, onAddShot, reorderRevision, onReorderShots, actions }: ProjectOutlineProps) {
  const modifierLabel = primaryModifier().label;
  const previewContext = useScenePreviewContext(project);
  const selectShot = useCommittedCallback(onSelectShot);
  const selected = useMemo(() => { const ids = new Set(selectedIds ?? (selectedShotId ? [selectedShotId] : [])); return new Set(project.shots.filter(shot => ids.has(shot.id)).map(shot => shot.id)); }, [project.shots, selectedIds, selectedShotId]);
  const { status, pointerHandlers } = useStoryboardReorder(project.shots, selected, reorderRevision, onReorderShots);
  const canReorder = Boolean(onReorderShots && reorderRevision !== undefined && project.shots.length > 1);
  const canReorderSelection = selected.size < project.shots.length && !project.shots.some(shot => shot.locked && selected.has(shot.id));

  function selectionKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a' && onSelectAll) { event.preventDefault(); event.stopPropagation(); onSelectAll(); }
    if (event.key === 'Escape' && onClearSelection) { event.preventDefault(); event.stopPropagation(); onClearSelection(); }
  }

  return <>
    <header className="outline-heading">
      <h2>分镜</h2><span>{project.shots.length} 镜</span>
      {onAddShot && <IconButton label="添加镜头" onClick={() => void onAddShot()}><Plus size={16} aria-hidden="true" /></IconButton>}
      {actions}
    </header>
    {(onSelectAll || onClearSelection || onBulkEdit) && <div className="outline-selection" role="group" aria-label="镜头操作" onKeyDown={selectionKey}>
      <span aria-live="polite">已选 {selected.size}</span>
      {onSelectAll && <IconButton label="全选镜头" disabled={!project.shots.length || selected.size === project.shots.length} onClick={onSelectAll}><ListChecks size={15} aria-hidden="true" /></IconButton>}
      {onClearSelection && <IconButton label="清除镜头选择" disabled={!selected.size} onClick={onClearSelection}><X size={15} aria-hidden="true" /></IconButton>}
      {onBulkEdit && <IconButton label="批量编辑镜头" disabled={!selected.size} onClick={onBulkEdit}><SlidersHorizontal size={15} aria-hidden="true" /></IconButton>}
    </div>}
    <span ref={status} className="outline-reorder-status" role="status" />
    <div className="shot-list outline-list" role="region" aria-label="镜头列表" tabIndex={0} onKeyDown={selectionKey} {...pointerHandlers}>
      {project.shots.length ? project.shots.map((shot, index) => <OutlineShotRow key={shot.id} project={previewContext} shot={shot} index={index} assets={assets} selected={selected.has(shot.id)} primary={selected.has(shot.id) && shot.id === selectedShotId} reorderable={canReorder && !shot.locked && (!selected.has(shot.id) || canReorderSelection)} modifierLabel={modifierLabel} onSelectShot={selectShot} />) : <div className="outline-empty"><Film size={20} aria-hidden="true" /><p>还没有镜头</p></div>}
    </div>
  </>;
});
