import { useState } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import type { SkillGroup, SkillImportJob } from '@video-quickly/contracts';
import type { Action } from '../lib/types';
import { Button, IconButton, Notice } from './Primitives';
import './skill-library.css';

function sourceName(job: SkillImportJob) {
  if (job.groupName) return job.groupName;
  if (job.source.url) return new URL(job.source.url).pathname.split('/').filter(Boolean)[1]?.replace(/\.git$/, '') ?? 'Skill';
  return job.source.path?.split(/[\\/]/).filter(Boolean).at(-1)?.replace(/\.zip$/i, '') ?? 'Skill';
}

function SkillImportNotice({ job, groups, action, onDismiss }: { job: SkillImportJob; groups: SkillGroup[]; action: Action; onDismiss(): void }) {
  const [busy, setBusy] = useState(false);
  const name = groups.find(group => group.id === job.groupId)?.name ?? sourceName(job);
  const pending = job.status === 'queued' || job.status === 'running';
  const failed = job.status === 'failed' || job.status === 'interrupted';
  return <Notice kind={failed ? 'error' : job.status === 'succeeded' ? 'success' : 'info'}>
    <span className="skill-import-record">{pending && <LoaderCircle size={16} className="spin" aria-hidden="true" />}<span><strong>{pending ? `正在导入“${name}”` : failed ? `“${name}”导入未完成` : `已导入“${name}”`}</strong><small>{pending ? job.total === undefined ? '正在读取来源，关闭窗口后会继续。' : `已处理 ${job.completed} / ${job.total} 个 Skill` : failed ? job.error : `本次完成了 ${job.completed} 个 Skill 的导入。`}</small></span></span>
    {failed && <Button busy={busy} onClick={() => { setBusy(true); void action('skill.import.retry', { id: job.id }).finally(() => setBusy(false)); }}>重试导入</Button>}
    <IconButton label={`关闭“${name}”导入状态`} onClick={onDismiss}><X size={15} /></IconButton>
  </Notice>;
}

export default function SkillImportStatus({ jobs = [], groups = [], action }: { jobs?: SkillImportJob[]; groups?: SkillGroup[]; action: Action }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const visible = jobs.filter(job => !dismissed.includes(`${job.id}:${job.status}`) && (job.status !== 'succeeded' || Date.now() - Date.parse(job.updatedAt) < 60_000 && groups.some(group => group.id === job.groupId))).slice(0, 3);
  if (!visible.length) return null;
  return <div className="skill-import-status" aria-label="Skill 导入状态">{visible.map(job => <SkillImportNotice key={job.id} job={job} groups={groups} action={action} onDismiss={() => setDismissed(value => [...value, `${job.id}:${job.status}`])} />)}</div>;
}
