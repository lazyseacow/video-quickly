import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import { ListOrdered, RefreshCw } from 'lucide-react';
import { productionQueueDetailSchema, productionQueueSchema, projectDetailSchema, recordPageSchema, type ProductionQueueItem, type StoryWork } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { StepOutputSelection } from '../lib/types';
import { Button, EmptyState, Field, Notice, Select } from '../components/Primitives';
import { useConfirmation } from '../components/ConfirmationDialog';
const RunInspector = lazy(() => import('./RunInspector'));
const queuePage = recordPageSchema(productionQueueSchema);
const queueLabels = { paused: '已暂停派发', running: '顺序制作中', needs_attention: '需要处理', succeeded: '已完成', canceled: '已取消后续派发' };
const itemLabels = { queued: '待制作', running: '制作中', succeeded: '已完成', needs_attention: '需要处理', failed: '制作失败', canceled: '已取消', skipped: '已跳过' };
export default function ProductionQueuePanel({ work, version, selectedQueueId, onSelectQueue, onSelectEpisodes, onOpen, onOpenOutput }: {
  work: StoryWork; version: number; selectedQueueId?: string; onSelectQueue(id: string): void; onSelectEpisodes(): void;
  onOpen(id: string): void; onOpenOutput(value: StepOutputSelection): void;
}) {
  const list = useRecordPage('productionQueue.list', { workId: work.id, limit: 30 }, version, queuePage);
  const id = selectedQueueId ?? list.items[0]?.id;
  if (!id) return <div className="production-queue">
    {list.error ? <Notice kind="error"><span>{list.error}</span><Button busy={list.busy} onClick={list.refresh}>重试读取</Button></Notice> : list.busy || !list.hasLoaded
      ? <p className="muted" role="status">正在读取生产队列…</p>
      : <EmptyState icon={<ListOrdered size={24} />} title="还没有生产队列" description={work.archived ? '归档前创建的队列会显示在这里。' : '选择分集入队后，可在这里核对顺序并开始制作。'}>
        {!work.archived && <Button onClick={onSelectEpisodes}>选择分集</Button>}
      </EmptyState>}
  </div>;
  const hasHistory = list.items.length > 1 || list.nextCursor !== null || list.items.some(queue => queue.id !== id);
  const history = hasHistory && <div className="queue-history">
    <Field label="队列历史"><Select value={id} onChange={event => onSelectQueue(event.target.value)}>
      {!list.items.some(queue => queue.id === id) && <option value={id}>当前队列</option>}
      {list.items.map(queue => <option value={queue.id} key={queue.id}>{new Date(queue.createdAt).toLocaleString('zh-CN')} · {queueLabels[queue.status]}</option>)}
    </Select></Field>
    {list.nextCursor !== null && <Button variant="ghost" busy={list.loadingMore} disabled={!list.canLoadMore} onClick={() => void list.loadMore()}>更早的队列</Button>}
  </div>;
  return <div className="production-queue"><QueueDetail key={id} queueId={id} version={version} history={history}
    onRefreshList={list.refresh} listBusy={list.busy && !list.loadingMore} listError={list.error} onOpen={onOpen} onOpenOutput={onOpenOutput} /></div>;
}

function QueueDetail({ queueId, version, history, onRefreshList, listBusy, listError, onOpen, onOpenOutput }: {
  queueId: string; version: number; history: ReactNode; onRefreshList(): void; listBusy: boolean; listError: string;
  onOpen(id: string): void; onOpenOutput(value: StepOutputSelection): void;
}) {
  const detail = useRuntimeRead('productionQueue.get', { queueId }, version, productionQueueDetailSchema);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [inspected, setInspected] = useState<string>();
  const inFlight = useRef(false), confirm = useConfirmation();
  const queue = detail.data?.queue, items = detail.data?.items ?? [];
  const pendingCount = items.filter(item => item.status === 'queued').length;
  const completedCount = items.filter(item => item.status === 'succeeded').length;
  const blocked = items.some(item => item.status === 'needs_attention' || item.status === 'failed');
  const canStart = queue && (queue.status === 'paused' || queue.status === 'needs_attention') && pendingCount > 0 && !blocked;
  const canPause = queue?.status === 'running' && pendingCount > 0;
  const canCancel = queue && queue.status !== 'canceled' && queue.status !== 'succeeded' && (pendingCount > 0 || blocked);
  // Background reads keep the last detail usable. Mutations check its revision in the runtime.
  const controlsDisabled = busy || Boolean(detail.error);
  function refreshQueue() {
    setError('');
    onRefreshList();
    void detail.refresh();
  }
  async function perform(method: string, params: unknown) {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError('');
    try { await rpc(method, params); await detail.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function start() {
    if (!queue || !await confirm({ title: '开始顺序制作？', description: `将按列表顺序制作 ${pendingCount} 集，开始每集前会核对入队时的项目修订。模型请求会产生用量。`, confirmLabel: '开始队列', variant: 'primary' })) return;
    await perform('productionQueue.start', { queueId, revision: queue.revision });
  }
  async function cancel() {
    if (!queue || !await confirm({ title: '取消后续排队项？', description: '将取消所有待处理分集，保留已有制作记录与产物。当前正在制作的分集继续执行，可用“停止当前制作”单独停止。', confirmLabel: '取消后续排队项' })) return;
    await perform('productionQueue.cancel', { queueId, revision: queue.revision });
  }
  async function refreshInput(item: ProductionQueueItem) {
    if (inFlight.current) return;
    try {
      const project = projectDetailSchema.parse(await rpc('project.get', { projectId: item.projectId })).project;
      if (!project) throw new Error('分集项目不可用。');
      if (!await confirm({ title: '刷新排队输入？', description: `“${project.title}”：由项目修订 ${item.projectRevision} 更新为修订 ${project.revision}。刷新后暂停派发，核对后再开始。`, confirmLabel: '刷新输入', variant: 'primary' })) return;
      await perform('productionQueue.refreshItem', { itemId: item.id, revision: item.revision, projectRevision: project.revision });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  }
  async function skip(item: ProductionQueueItem) {
    if (!await confirm({ title: '跳过此分集？', description: `“${item.title}”的已有运行和产物保留，后续分集等待开始。`, confirmLabel: '跳过并保留产物', variant: 'primary' })) return;
    await perform('productionQueue.skipItem', { itemId: item.id, revision: item.revision });
  }
  async function stop(item: ProductionQueueItem) {
    if (!await confirm({ title: '停止当前制作？', description: `停止“${item.title}”的本地执行并暂停后续派发。已提交的远端任务需按服务能力核对。`, confirmLabel: '停止当前制作' })) return;
    await perform('productionQueue.stopCurrent', { itemId: item.id, revision: item.revision });
  }
  const readError = detail.error || listError;
  const queueError = queue?.error && !items.some(item => item.error === queue.error) ? queue.error : '';
  return <>
    <div className="queue-toolbar">
      {history || (queue && <time className="tiny-meta" dateTime={queue.createdAt}>{new Date(queue.createdAt).toLocaleString('zh-CN')} 创建</time>)}
      <Button variant="ghost" aria-label="刷新队列" busy={detail.busy || listBusy} disabled={busy} onClick={refreshQueue}><RefreshCw size={15} aria-hidden="true" />刷新</Button>
    </div>
    {(readError || error) && <Notice kind="error">{readError || error}</Notice>}
    {!queue && !readError && <p className="muted" role="status">正在读取队列详情…</p>}
    {queue && <>
      <div className="queue-overview">
        <div className="queue-summary" role="status">
          <strong>{queue.status === 'paused' && pendingCount === items.length ? '待开始' : queueLabels[queue.status]}</strong>
          <span>{completedCount} / {items.length} 集完成</span>
          {(queue.status === 'paused' || queue.status === 'canceled') && items.some(item => item.status === 'running') && <span>当前分集继续制作</span>}
        </div>
        {(canStart || canPause || canCancel) && <div className="queue-controls" aria-busy={busy || undefined}>
          {(canStart || canPause) && <Button variant={canPause ? 'default' : 'primary'} disabled={controlsDisabled}
            onClick={() => void (canPause ? perform('productionQueue.pause', { queueId, revision: queue.revision }) : start())}>
            {canPause ? '暂停后续派发' : '开始队列'}
          </Button>}
          {canCancel && <Button variant="ghost" disabled={controlsDisabled} onClick={() => void cancel()}>取消后续排队项</Button>}
        </div>}
      </div>
      {queueError && <Notice kind="error">{queueError}</Notice>}
      <ol className="queue-items" aria-label="分集制作顺序">{items.map(item => {
        const number = `第 ${item.episodeNumber} 集`;
        const needsAttention = item.status === 'failed' || item.status === 'needs_attention';
        const canRefreshInput = queue.status !== 'canceled' && !item.runId && (item.status === 'queued' || item.status === 'needs_attention');
        return <li className="queue-item" key={item.id} data-queue-item-id={item.id}>
          <div className="queue-item__heading">
            {item.title !== number && <span className="tiny-meta">{number}</span>}
            <h3>{item.title}</h3>
          </div>
          <span className={`queue-item__status queue-item__status--${item.status}`}>{itemLabels[item.status]}</span>
          {item.error && (item.status !== 'canceled' || queue.status !== 'canceled') && <div className="queue-item__error"><Notice kind={item.status === 'canceled' ? 'info' : 'error'}>{item.error}</Notice></div>}
          <div className="queue-item__actions">
            {item.status === 'running' && <Button disabled={controlsDisabled} onClick={() => void stop(item)}>停止当前制作</Button>}
            {queue.status !== 'canceled' && needsAttention && item.runId && <Button disabled={controlsDisabled} onClick={() => void perform('productionQueue.resumeItem', { itemId: item.id, revision: item.revision })}>继续原运行</Button>}
            {canRefreshInput && <Button variant={needsAttention ? 'default' : 'ghost'} aria-label="核对并刷新输入" disabled={controlsDisabled} onClick={() => void refreshInput(item)}>更新输入</Button>}
            <Button variant="ghost" onClick={() => onOpen(item.projectId)}>打开分集</Button>
            {item.runId && <Button variant="ghost" onClick={() => setInspected(item.runId)}>查看制作记录</Button>}
            {queue.status !== 'canceled' && (item.status === 'queued' || needsAttention) && <Button variant="ghost" aria-label="跳过此分集" disabled={controlsDisabled} onClick={() => void skip(item)}>跳过</Button>}
          </div>
        </li>;
      })}</ol>
    </>}
    {inspected && <Suspense fallback={null}><RunInspector runId={inspected} version={version} onClose={() => setInspected(undefined)} onChanged={detail.refresh} onRestart={() => setInspected(undefined)} onOpenOutput={value => { setInspected(undefined); onOpenOutput(value); }} /></Suspense>}
  </>;
}
