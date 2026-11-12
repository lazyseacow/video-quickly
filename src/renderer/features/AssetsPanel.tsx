import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Image, ListChecks, Trash2, Upload } from 'lucide-react';
import { assetListItemSchema, recordPageSchema, type AssetListItem, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Field, Notice } from '../components/Primitives';
import { pathExample } from '../lib/desktop';
import type { Action, WorkspaceView } from '../lib/types';
import { useRecordPage } from '../lib/use-record-page';
import { useConfirmation } from '../components/ConfirmationDialog';
import PathPicker from '../components/PathPicker';
import AssetCard, { canRemoveAsset, isVisualAsset } from './AssetCard';

const assetsPageSchema = recordPageSchema(assetListItemSchema);

const assetFilters = [['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频'], ['document', '资料']] as const;
type AssetFilter = (typeof assetFilters)[number][0];

export function AssetsPanel({ workspace, action, project, onCreateCharacter }: {
  workspace: WorkspaceView;
  action: Action;
  project?: ProjectDocument;
  onCreateCharacter(asset: AssetRecord): void;
}) {
  const [importing, setImporting] = useState(false);
  const [trashed, setTrashed] = useState(false);
  const [source, setSource] = useState('');
  const [filter, setFilter] = useState<AssetFilter>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>();
  const [removing, setRemoving] = useState(false);
  const allAssets = useRef<HTMLButtonElement>(null);
  const selectionButton = useRef<HTMLButtonElement>(null);
  const trashToggle = useRef<HTMLButtonElement>(null);
  const removalInFlight = useRef(false);
  const confirm = useConfirmation();
  const kind = filter === 'all' ? undefined : filter === 'document' ? ['document', 'subtitle'] : filter;
  const library = useRecordPage('asset.list', { kind, trashed: trashed || undefined, hideExportOutputs: !trashed || undefined }, workspace.version, assetsPageSchema, workspace.assetsVersion);
  const assets = library.stale ? [] : library.items;
  const visualAssets = assets.filter(isVisualAsset);
  const fileAssets = assets.filter(asset => !isVisualAsset(asset));
  const loading = !assets.length && !library.error && (library.busy || !library.hasLoaded);
  const removable = selectedIds ? assets.filter(canRemoveAsset) : [];
  const selected = removable.filter(asset => selectedIds?.has(asset.id));
  const allSelected = removable.length > 0 && selected.length === removable.length;
  const projectLabels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { title } of workspace.projects) counts.set(title, (counts.get(title) ?? 0) + 1);
    return new Map(workspace.projects.map(({ id, title }) => [id, counts.get(title) === 1 ? title : `${title} · ${id.slice(0, 8)}`]));
  }, [workspace.projects]);

  useEffect(() => {
    if (!library.hasLoaded || library.stale) return;
    setSelectedIds(ids => {
      if (!ids?.size) return ids;
      const current = library.items.filter(asset => ids.has(asset.id) && canRemoveAsset(asset));
      return current.length === ids.size ? ids : new Set(current.map(asset => asset.id));
    });
  }, [library.hasLoaded, library.items, library.stale]);

  function changeFilter(value: AssetFilter) {
    if (value === filter) return;
    setSelectedIds(ids => ids && new Set());
    setFilter(value);
  }
  function showAllAssets() {
    changeFilter('all');
    allAssets.current?.focus();
  }
  function selectAsset(id: string, checked: boolean) {
    setSelectedIds(ids => {
      if (!ids) return ids;
      const next = new Set(ids);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  async function removeSelected() {
    if (removalInFlight.current || !selected.length) return;
    removalInFlight.current = true;
    try {
      if (!await confirm({ title: '批量移除素材记录？', description: `将 ${selected.length} 条记录移入回收站。素材文件会保留，可在回收站恢复。`, confirmLabel: '确认移除' })) return;
      setRemoving(true);
      const result = await action('asset.deleteMany', { assetIds: selected.map(asset => asset.id) }, `已将 ${selected.length} 条素材记录移入回收站`);
      if (result !== null) setSelectedIds(ids => ids && new Set());
      else library.refresh();
      if (document.activeElement === document.body) selectionButton.current?.focus({ preventScroll: true });
    } finally {
      removalInFlight.current = false;
      setRemoving(false);
    }
  }
  function renderAsset(asset: AssetListItem) {
    const owner = asset.projectId ? projectLabels.get(asset.projectId) ?? `原项目 · ${asset.projectId.slice(0, 8)}` : '公共素材';
    return <AssetCard key={asset.id} asset={asset} owner={owner} action={action} onCreateCharacter={onCreateCharacter} onRestored={() => {
      if (document.activeElement === document.body) trashToggle.current?.focus({ preventScroll: true });
    }} selection={selectedIds ? { checked: selectedIds.has(asset.id), busy: removing, onChange: checked => selectAsset(asset.id, checked) } : undefined} />;
  }
  return <>
    {trashed && <h2 className="asset-library__recycle-heading">素材回收站</h2>}
    <div className={`page-toolbar library-toolbar${selectedIds ? ' library-toolbar--selecting' : ''}`}>
      <div className="tabs" role="group" aria-label="媒体筛选">{assetFilters.map(([value, label]) => <button key={value} ref={value === 'all' ? allAssets : undefined} aria-pressed={filter === value} className={filter === value ? 'active' : ''} disabled={removing} onClick={() => changeFilter(value)}>{label}</button>)}</div>
      <div className="library-toolbar__actions">
        {selectedIds ? <>
          <label className="library-toolbar__select-all" title="选择当前筛选中已加载且可移除的素材">
            <input type="checkbox" checked={allSelected} disabled={removing || !removable.length} ref={input => {
              if (input) input.indeterminate = selected.length > 0 && !allSelected;
            }} onChange={event => setSelectedIds(new Set(event.target.checked ? removable.map(asset => asset.id) : []))} />
            全选已加载
          </label>
          <span className="tiny-meta" role="status">已选 {selected.length} 项</span>
          <Button variant="danger" busy={removing} disabled={!selected.length} onClick={() => void removeSelected()}><Trash2 size={15} />批量移除</Button>
        </> : library.hasLoaded && !library.stale && <span className="tiny-meta">{assets.length} 个素材</span>}
        {!trashed && <Button ref={selectionButton} disabled={!selectedIds && (removing || !assets.length)} onClick={() => setSelectedIds(ids => ids ? undefined : new Set())}>
          <ListChecks size={15} />{selectedIds ? '退出多选' : '多选'}
        </Button>}
        <Button ref={trashToggle} disabled={removing} onClick={() => { setSelectedIds(undefined); setTrashed(value => !value); }}>
          {trashed ? <><ArrowLeft size={16} aria-hidden="true" />返回素材库</> : <><Trash2 size={16} aria-hidden="true" />回收站</>}
        </Button>
        {!trashed && <Button aria-label="导入素材" variant="primary" onClick={() => setImporting(true)}><Upload size={15} aria-hidden="true" />导入</Button>}
      </div>
    </div>
    {library.error && <Notice kind="error">{library.error}<Button aria-label="重试读取素材" onClick={library.refresh}>重试</Button></Notice>}
    {loading && <p role="status" className="muted">正在读取素材…</p>}
    {assets.length > 0 && <div className="asset-library__items">
      {visualAssets.length > 0 && <section className="asset-grid" aria-label="图片与视频">{visualAssets.map(renderAsset)}</section>}
      {fileAssets.length > 0 && <section className="asset-file-list" aria-label="音频与资料">{fileAssets.map(renderAsset)}</section>}
    </div>}
    {!loading && !library.error && assets.length === 0 && <EmptyState icon={trashed ? <Trash2 size={25} /> : <Image size={25} />}
      title={filter !== 'all' ? '没有此类素材' : trashed ? '回收站为空' : '还没有素材'}
      description={trashed ? '移入回收站的素材可在此恢复。' : filter === 'all' ? '导入自有或已授权的图片、视频、音频和资料。' : '查看全部素材，或导入此类型的文件。'}>
      {filter !== 'all' && <Button onClick={showAllAssets}>{trashed ? '查看全部回收素材' : '查看全部素材'}</Button>}
    </EmptyState>}
    {!library.stale && library.nextCursor !== null && <Button aria-label="加载更多素材" className="button-full" busy={library.loadingMore} disabled={!library.canLoadMore} onClick={() => void library.loadMore()}>加载更多</Button>}
    {importing && <Dialog title="导入本地素材" onClose={() => setImporting(false)}>
      <form onSubmit={event => {
        event.preventDefault();
        void action('asset.import', { path: source, projectId: project?.id }, '素材已导入').then(result => {
          if (result !== null) { setImporting(false); setSource(''); }
        });
      }}>
        <div className="dialog__body">
          <Field label="文件路径"><PathPicker label="文件路径" autoFocus required value={source} onChange={setSource} placeholder={pathExample('image')} /></Field>
          <p className="tiny-meta">请使用自己创作或已获授权的素材。源文件会保留。</p>
        </div>
        <div className="dialog__footer">
          <Button onClick={() => setImporting(false)}>取消</Button>
          <Button variant="primary" type="submit"><Upload size={15} />导入</Button>
        </div>
      </form>
    </Dialog>}
  </>;
}
