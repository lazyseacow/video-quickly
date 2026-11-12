import { lazy, Suspense, useEffect, useState } from 'react';
import { supportsPromptExperiment, projectDetailSchema, projectSchema, type ProjectDocument } from '@video-quickly/contracts';
import { rpc } from '../lib/client';
import type { StepOutputSelection, WorkspaceView } from '../lib/types';
import { Button, Dialog, Field, Notice, Select } from './Primitives';
const PromptWorkbench = lazy(() => import('./PromptWorkbench'));

export default function PromptStudioLauncher({ workspace, onClose, onOpenOutput }: { workspace: WorkspaceView; onClose(): void; onOpenOutput(selection: StepOutputSelection): void }) {
  const projects = workspace.projects.filter(project => !project.archived);
  const [selectedProjectId, setSelectedProjectId] = useState(projects[0]?.id ?? '');
  const projectId = projects.some(project => project.id === selectedProjectId) ? selectedProjectId : projects[0]?.id ?? '';
  const [loadedProject, setProject] = useState<ProjectDocument>(), [nodeId, setNodeId] = useState(''), [opened, setOpened] = useState(false), [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const project = loadedProject?.id === projectId ? loadedProject : undefined;
  useEffect(() => {
    setProject(undefined); setError('');
    if (!projectId) return;
    let current = true;
    void rpc('project.get', { projectId }).then(value => { if (current) { setProject(projectDetailSchema.parse(value).project); setNodeId(''); } }).catch(error => { if (current) setError(error instanceof Error ? error.message : String(error)); });
    return () => { current = false; };
  }, [projectId, reload]);
  const tasks = project?.workflow.nodes.filter(supportsPromptExperiment) ?? [];
  const node = tasks.find(node => node.id === nodeId) ?? tasks[0];
  const taskStatus = projectId && !project ? (error ? '任务读取失败' : '正在读取任务…') : '暂无任务';
  return <><Dialog title="选择提示词实验任务" onClose={onClose}><div className="dialog__body">
    <Field label="实验项目"><Select value={projectId} disabled={!projects.length} onChange={event => setSelectedProjectId(event.target.value)}>
      {projects.length ? projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>) : <option className="select-empty-option" value="" disabled>暂无项目</option>}
    </Select></Field>
    <Field label="实验任务"><Select value={node?.id ?? ''} disabled={!tasks.length} aria-busy={Boolean(projectId && !project && !error)} onChange={event => setNodeId(event.target.value)}>
      {tasks.length ? tasks.map(node => <option key={node.id} value={node.id}>{node.label}</option>) : <option key={taskStatus} className="select-empty-option" value="" disabled>{taskStatus}</option>}
    </Select></Field>{error && <Notice kind="error">{error}<Button aria-label="重试读取实验任务" onClick={() => setReload(value => value + 1)}>重试</Button></Notice>}
    </div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button variant="primary" disabled={!project || !node} onClick={() => setOpened(true)}>打开提示词实验</Button></div></Dialog>
    {opened && project && node && <Suspense fallback={<p role="status">正在打开提示词实验…</p>}><PromptWorkbench projectId={project.id} projectRevision={project.revision} node={node} models={workspace.models} skills={workspace.skills} groups={workspace.skillGroups} version={workspace.version} onClose={() => setOpened(false)} onOpenOutput={selection => { onClose(); onOpenOutput(selection); }} onApplyPrompt={async next => {
      const value = projectSchema.parse(await rpc('project.update', { projectId: project.id, revision: project.revision, patch: { workflow: { ...project.workflow, nodes: project.workflow.nodes.map(node => node.id === next.id ? { ...node, prompt: next.prompt, promptBindings: next.promptBindings, promptTemplate: next.promptTemplate } : node) } } }));
      setProject(value); setOpened(false);
    }} /></Suspense>}
  </>;
}
