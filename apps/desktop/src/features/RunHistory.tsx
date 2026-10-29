import { useState } from 'react';
import { CheckCheck, ChevronDown, History, RefreshCw, RotateCcw, Square } from 'lucide-react';
import { activitySchema, recordPageSchema, runEventSchema, runSummarySchema } from '@video-quickly/contracts';
import { Button, Dialog, EmptyState, Notice, Status } from '../components/Primitives';
import { useRecordPage } from '../lib/use-record-page';
import type { Action, WorkspaceView } from '../lib/types';

const runsSchema = recordPageSchema(runSummarySchema);
const eventsSchema = recordPageSchema(runEventSchema);
const activitiesSchema = recordPageSchema(activitySchema);

export default function RunsPage({ workspace, action, onOpen }: { workspace: WorkspaceView; action: Action; onOpen: (id: string) => void }) {
  const history = useRecordPage('run.list', {}, workspace.version, runsSchema);
  const [replay, setReplay] = useState<unknown | null>(null);
  return <div className="content-page"><div className="page-heading"><div><h1>制作记录</h1><p>查看每一步的执行结果，审阅小样，或从中断处继续。</p></div><Button busy={history.busy} onClick={history.refresh}><RefreshCw size={15} />刷新</Button></div>
    {history.error && <Notice kind="error">{history.error}</Notice>}
    {history.items.map(run => {
      const project = workspace.projects.find(item => item.id === run.projectId);
      const completed = run.completedNodeIds.length;
      return <article className="run-card" key={run.id}><div className="run-card__header"><History size={17} /><h3>{project?.title ?? '项目制作'}</h3><Status value={run.status} /></div><div className="run-card__meta"><span>{new Date(run.createdAt).toLocaleString('zh-CN')}</span><span>修订 {run.projectRevision} · 流程 v{run.workflowVersion}</span><span>{completed} 个步骤已完成</span></div>
        {run.error && <div className="run-error"><Notice kind="error">{run.error}</Notice></div>}<div className="progress-line"><span style={{ width: `${Math.min(100, completed / Math.max(1, project?.workflowNodeCount ?? 1) * 100)}%` }} /></div>
        <div className="run-card__actions">{run.status === 'waiting_review' && <><Button variant="primary" onClick={() => void action('run.review', { runId: run.id, approved: true }, '审阅已通过，继续制作')}><CheckCheck size={15} />通过审阅</Button><Button onClick={() => void action('run.review', { runId: run.id, approved: false }, '已保留当前结果')}><Square size={14} />停止并修改</Button></>}
          {['failed', 'needs_attention', 'waiting_external', 'queued'].includes(run.status) && <Button variant="primary" onClick={() => void action('run.resume', { runId: run.id }, '已请求继续执行')}><RotateCcw size={15} />继续执行</Button>}
          {['running', 'queued', 'waiting_external', 'retry_scheduled'].includes(run.status) && <Button onClick={() => void action('run.cancel', { runId: run.id }, '已请求停止')}><Square size={14} />停止</Button>}
          {run.status === 'canceled' && <Button onClick={() => void action('run.start', { projectId: run.projectId, parentRunId: run.id }, '已请求重新制作')}><RotateCcw size={15} />重新制作</Button>}
          <Button onClick={() => void action('run.replay', { runId: run.id }).then(result => { if (result !== null) setReplay(result); })}><History size={15} />重放检查</Button><Button variant="ghost" onClick={() => onOpen(run.projectId)}>打开项目</Button>
        </div><RunDetails runId={run.id} version={workspace.version} />
      </article>;
    })}
    {!history.items.length && !history.busy && !history.error && <div className="section-card"><EmptyState icon={<History size={25} />} title="还没有制作记录" description="从项目中开始制作后，步骤状态、审阅记录和恢复入口会显示在这里。" /></div>}
    {history.nextCursor !== null && <Button className="button-full" busy={history.busy} onClick={() => void history.loadMore()}><ChevronDown size={15} />加载更早的制作记录</Button>}
    {replay !== null && <Dialog title="重放检查结果" onClose={() => setReplay(null)} className="dialog--wide"><div className="dialog__body"><Notice>本次只读取历史记录，不提交生成或渲染任务。</Notice><pre className="run-log">{typeof replay === 'string' ? replay : JSON.stringify(replay, null, 2)}</pre></div><div className="dialog__footer"><Button onClick={() => setReplay(null)}>关闭</Button></div></Dialog>}
  </div>;
}
function RunDetails({ runId, version }: { runId: string; version: number }) {
  const [open, setOpen] = useState(false);
  return <details className="execution-details" onToggle={event => setOpen(event.currentTarget.open)}><summary>查看活动与执行日志</summary>{open && <RunLog runId={runId} version={version} />}</details>;
}
function RunLog({ runId, version }: { runId: string; version: number }) {
  const events = useRecordPage('run.events', { runId }, version, eventsSchema);
  const activities = useRecordPage('run.activities', { runId }, version, activitiesSchema);
  return <>{(events.error || activities.error) && <Notice kind="error">{events.error || activities.error}<Button onClick={() => { events.refresh(); activities.refresh(); }}>重试读取日志</Button></Notice>}
    {activities.items.map(activity => <div className="run-activity" key={activity.id}><span>{activity.nodeId}</span>{activity.remoteTaskId && <span className="tiny-meta">任务 {activity.remoteTaskId}</span>}<Status value={activity.status === 'completed' ? 'succeeded' : activity.status === 'prepared' ? 'queued' : activity.status === 'submitted' ? 'waiting_external' : activity.status === 'unknown' ? 'needs_attention' : activity.status} /></div>)}
    {activities.nextCursor !== null && <Button busy={activities.busy} onClick={() => void activities.loadMore()}>加载更多活动</Button>}
    <div className="run-log">{events.items.length ? events.items.toReversed().map(event => `${new Date(event.createdAt).toLocaleTimeString('zh-CN')}  ${event.message}`).join('\n') : events.busy ? '正在读取执行日志…' : '执行日志会在任务开始后显示。'}</div>
    {events.nextCursor !== null && <Button busy={events.busy} onClick={() => void events.loadMore()}>加载更早的日志</Button>}
  </>;
}
