import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { projectReadinessSchema, type ProjectReadiness, type ReadinessIssue, type RunSelection } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import { Button, Dialog, Notice } from './Primitives';
import './project-readiness.css';

const fixLabels: Record<ReadinessIssue['fix'], string> = { project: '查看项目', step: '调整步骤', models: '配置模型', characters: '查看角色', assets: '修复素材', runtime: '查看修复建议', runs: '查看未完成制作' };
const categories: Record<ReadinessIssue['category'], string> = { project: '项目', workflow: '流程', model: '模型', media: '素材', environment: '运行环境', skill: 'Skill' };
type Request = { id: string; pending: boolean; cancelSent: boolean };

export default function ProjectReadinessDialog({ projectId, selection, version, hasUnsavedChanges = false, onClose, onRepair, onError }: {
  projectId: string; selection?: RunSelection; version: number; hasUnsavedChanges?: boolean;
  onClose(): void; onRepair(issue: ReadinessIssue): void; onError(message: string): void;
}) {
  const [report, setReport] = useState<ProjectReadiness>(), [busy, setBusy] = useState(true), [error, setError] = useState('');
  const [checkedVersion, setCheckedVersion] = useState(version);
  const [issueLimit, setIssueLimit] = useState(100);
  const mounted = useRef(false), current = useRef<Request | undefined>(undefined), errorHandler = useRef(onError);
  useLayoutEffect(() => { errorHandler.current = onError; }, [onError]);
  function cancel(request: Request | undefined) {
    if (!request?.pending || request.cancelSent) return;
    request.cancelSent = true;
    void rpc('project.readiness.cancel', { projectId, requestId: request.id }).catch(() => errorHandler.current('停止本地检查尚未确认；执行器断开时会清理检查任务。'));
  }
  async function check() {
    if (current.current?.pending) return;
    const request: Request = { id: crypto.randomUUID(), pending: true, cancelSent: false };
    current.current = request; setBusy(true); setError('');
    const requestedVersion = version;
    try {
      const result = projectReadinessSchema.parse(await rpc('project.readiness', { projectId, selection, requestId: request.id }));
      if (mounted.current && current.current === request) { setReport(result); setCheckedVersion(requestedVersion); setIssueLimit(100); }
    } catch (failure) { if (mounted.current && current.current === request) setError(failure instanceof Error ? failure.message : '本地检查未完成，请重新检查。'); }
    finally { request.pending = false; if (mounted.current && current.current === request) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true; setReport(undefined); void check();
    return () => { mounted.current = false; cancel(current.current); current.current = undefined; };
    // Workspace notifications only mark results stale. Hashing is repeated on
    // an explicit check, rather than on every background run notification.
  }, [projectId, selection?.nodeId, selection?.mode]);
  const visible = report?.projectId === projectId && report.selection?.nodeId === selection?.nodeId && report.selection?.mode === selection?.mode ? report : undefined;
  const errors = visible?.issues.filter(issue => issue.severity === 'error') ?? [], warnings = visible?.issues.filter(issue => issue.severity === 'warning') ?? [];
  return <Dialog title="制作前检查" className="dialog--wide project-readiness-dialog" onClose={onClose}>
    <div className="dialog__body">
      <p className="readiness-intro">核对已保存项目的本地配置与素材，不提交生成任务。供应商连通性和计费状态需单独验证。</p>
      {hasUnsavedChanges && <Notice>当前有未保存的修改，本次仅检查已保存内容。保存修改后请重新检查。</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      {busy && <p role="status">正在核对步骤和素材文件，可关闭窗口停止检查…</p>}
      {visible && <>
        <dl className="readiness-summary"><div><dt>项目修订</dt><dd>{visible.projectRevision}</dd></div><div><dt>涉及步骤</dt><dd>{visible.stepCount}</dd></div><div><dt>涉及模型</dt><dd>{visible.modelCount}</dd></div><div><dt>素材引用</dt><dd>{visible.assetCount}</dd></div></dl>
        {!busy && !error && <Notice kind={errors.length ? 'error' : warnings.length ? 'info' : 'success'}>{errors.length ? `${errors.length} 项需要处理，${warnings.length} 项提醒。` : warnings.length ? `本地检查通过，请核对 ${warnings.length} 项提醒。` : '本地检查通过。'}</Notice>}
        {checkedVersion !== version && <Notice>工作区在检查后有更新，请重新检查当前配置。</Notice>}
        <ul className="readiness-issues" aria-label="制作检查结果">{[...errors, ...warnings].slice(0, issueLimit).map(issue => <li key={issue.id}><div><span className="readiness-issue-meta">{issue.severity === 'error' ? '需处理' : '提醒'} · {categories[issue.category]}{issue.nodeLabel ? ` · ${issue.nodeLabel}` : ''}{issue.modelName ? ` · ${issue.modelName}` : ''}</span><strong>{issue.message}</strong>{issue.hint && <p>{issue.hint}</p>}</div><Button disabled={busy || Boolean(error)} onClick={() => onRepair(issue)}>{fixLabels[issue.fix]}</Button></li>)}</ul>
        {visible.issues.length > issueLimit && <Button className="button-full" onClick={() => setIssueLimit(value => value + 100)}>显示更多检查结果</Button>}
        <p className="readiness-intro">检查时间：{new Date(visible.checkedAt).toLocaleString('zh-CN')}。制作时仍会按实际输入再次校验。</p>
      </>}
    </div>
    <div className="dialog__footer"><Button onClick={onClose}>{hasUnsavedChanges ? '返回保存修改' : '关闭'}</Button><Button variant="primary" busy={busy} onClick={() => void check()}><RefreshCw size={14} />重新检查</Button></div>
  </Dialog>;
}
