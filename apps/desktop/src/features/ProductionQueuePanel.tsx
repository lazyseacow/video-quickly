import { lazy, Suspense, useRef, useState } from 'react';
import { ListOrdered } from 'lucide-react';
import { productionQueueDetailSchema, productionQueueSchema, projectDetailSchema, recordPageSchema, type ProductionQueueItem, type StoryWork } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { useRecordPage } from '../lib/use-record-page';
import { useRuntimeRead } from '../lib/use-runtime-read';
import type { StepOutputSelection } from '../lib/types';
import { Button, EmptyState, Field, Notice, Select, Status } from '../components/Primitives';
import { useConfirmation } from '../components/ConfirmationDialog';
const RunInspector = lazy(() => import('./RunInspector'));
const queuePage = recordPageSchema(productionQueueSchema);
const queueLabels = { paused: '已暂停派发', running: '顺序制作中', needs_attention: '需要处理', succeeded: '已完成', canceled: '已取消后续派发' };
const itemLabels = { queued: '待制作', running: '制作中', succeeded: '已完成', needs_attention: '需要处理', failed: '制作失败', canceled: '已取消', skipped: '已跳过' };
export default function ProductionQueuePanel({ work, version, selectedQueueId, onOpen, onOpenOutput }: { work: StoryWork; version: number; selectedQueueId?: string; onOpen(id: string): void; onOpenOutput(value: StepOutputSelection): void }) {
  const list = useRecordPage('productionQueue.list', { workId: work.id, limit: 30 }, version, queuePage);
  const [selected, setSelected] = useState(selectedQueueId);
  const id = selected ?? list.items[0]?.id;
  return <div className="production-queue"><p className="tiny-meta">队列按列表顺序执行，每个分集使用启动时的快照。暂停派发会保留当前制作；停止当前制作单独操作。</p>
    {list.error && <Notice kind="error">{list.error}<Button onClick={list.refresh}>重试读取</Button></Notice>}
    {id && <Field label="作品生产队列"><Select value={id} onChange={event => setSelected(event.target.value)}>{!list.items.some(queue => queue.id === id) && <option value={id}>已选生产队列</option>}{list.items.map(queue => <option value={queue.id} key={queue.id}>{new Date(queue.createdAt).toLocaleString('zh-CN')} · {queueLabels[queue.status]}</option>)}</Select></Field>}
    {!id && !list.busy && !list.error && <EmptyState icon={<ListOrdered size={24} />} title="还没有生产队列" description="在分集列表中选择分集入队，再核对顺序并开始制作。" />}
    {list.nextCursor !== null && <Button busy={list.loadingMore} onClick={() => void list.loadMore()}>更早的队列</Button>}
    {id && <QueueDetail key={id} queueId={id} version={version} onOpen={onOpen} onOpenOutput={onOpenOutput} />}
  </div>;
}

function QueueDetail({ queueId, version, onOpen, onOpenOutput }: { queueId: string; version: number; onOpen(id: string): void; onOpenOutput(value: StepOutputSelection): void }) {
  const detail = useRuntimeRead('productionQueue.get', { queueId }, version, productionQueueDetailSchema);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [inspected, setInspected] = useState<string>();
  const inFlight = useRef(false), confirm = useConfirmation();
  const queue = detail.data?.queue, items = detail.data?.items ?? [];
  async function perform(method: string, params: unknown) {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError('');
    try { await rpc(method, params); detail.refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function start() {
    if (!queue || !await confirm({ title: '开始顺序制作？', description: `将按顺序执行 ${items.filter(item => item.status === 'queued').length} 个待制作分集，模型请求会产生用量。启动前逐集核对项目修订。`, confirmLabel: '开始队列', variant: 'primary' })) return;
    await perform('productionQueue.start', { queueId, revision: queue.revision });
  }
  async function cancel() {
    if (!queue || !await confirm({ title: '取消后续排队项？', description: '尚未开始的分集将取消。当前正在制作的分集继续执行，可用“停止当前制作”单独停止。', confirmLabel: '取消后续排队项' })) return;
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
  const blocked = items.some(item => ['needs_attention', 'failed'].includes(item.status));
  return <>{(detail.error || error) && <Notice kind="error">{detail.error || error}<Button onClick={detail.refresh}>刷新队列</Button></Notice>}
    {queue && <><div className="queue-summary"><strong>{queueLabels[queue.status]}</strong><span>{items.filter(item => item.status === 'succeeded').length} / {items.length} 集完成</span><span>队列修订 {queue.revision}</span></div>{queue.error && <Notice kind="error">{queue.error}</Notice>}
      <div className="work-actions"><Button variant="primary" busy={busy} disabled={!['paused','needs_attention'].includes(queue.status) || blocked} onClick={() => void start()}>开始队列</Button><Button disabled={busy || queue.status !== 'running'} onClick={() => void perform('productionQueue.pause', { queueId, revision: queue.revision })}>暂停后续派发</Button><Button disabled={busy || ['canceled','succeeded'].includes(queue.status)} onClick={() => void cancel()}>取消后续排队项</Button><Button disabled={busy} onClick={detail.refresh}>刷新队列</Button></div>
      <ol className="queue-items">{items.map(item => <li className="section-card queue-item" key={item.id} data-queue-item-id={item.id}><div className="queue-item__heading"><div><span className="tiny-meta">第 {item.episodeNumber} 集 · 输入修订 {item.projectRevision}</span><h3>{item.title}</h3></div><span className={`queue-item__status queue-item__status--${item.status}`}>{itemLabels[item.status]}</span></div>{item.error && <Notice kind="error">{item.error}</Notice>}
        <div className="work-actions"><Button onClick={() => onOpen(item.projectId)}>打开分集</Button>{item.runId && <Button onClick={() => setInspected(item.runId)}>查看制作记录</Button>}
          {item.status === 'running' && <Button disabled={busy} onClick={() => void stop(item)}>停止当前制作</Button>}
          {['failed','needs_attention'].includes(item.status) && item.runId && <Button disabled={busy} onClick={() => void perform('productionQueue.resumeItem', { itemId: item.id, revision: item.revision })}>继续原运行</Button>}
          {['queued','needs_attention'].includes(item.status) && !item.runId && <Button disabled={busy} onClick={() => void refreshInput(item)}>核对并刷新输入</Button>}
          {['queued','failed','needs_attention'].includes(item.status) && <Button disabled={busy} onClick={() => void skip(item)}>跳过此分集</Button>}
        </div></li>)}</ol>
    </>}
    {inspected && <Suspense fallback={null}><RunInspector runId={inspected} version={version} onClose={() => setInspected(undefined)} onChanged={detail.refresh} onRestart={() => setInspected(undefined)} onOpenOutput={value => { setInspected(undefined); onOpenOutput(value); }} /></Suspense>}
  </>;
}
