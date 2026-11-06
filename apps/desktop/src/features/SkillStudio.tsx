import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Pencil, Plus, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react';
import { z } from 'zod';
import { supportsSkillScript, type SkillGroup, type SkillPackage } from '@video-quickly/contracts';
import type { Action, StepOutputSelection, WorkspaceView } from '../lib/types';
import { rpc } from '../lib/client';
import { Button, Dialog, EmptyState, Field, IconButton, Notice, Select } from '../components/Primitives';
import SkillImportDialog from '../components/SkillImportDialog';
import { SkillImportRecord } from '../components/SkillImportStatus';
import { useConfirmation } from '../components/ConfirmationDialog';
import ToolConnections from './ToolConnections';
import '../components/skill-library.css';

const PromptStudioLauncher = lazy(() => import('../components/PromptStudioLauncher'));
const resourceSchema = z.object({ path: z.string(), content: z.string() });

export default function SkillStudio({ workspace, action, onOpenOutput }: { workspace: WorkspaceView; action: Action; onOpenOutput(selection: StepOutputSelection): void }) {
  const [importing, setImporting] = useState(false), [promptStudio, setPromptStudio] = useState(false);
  const [selected, setSelected] = useState<SkillPackage>(), [editingGroup, setEditingGroup] = useState<SkillGroup>();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string[]>([]), [operationError, setOperationError] = useState('');
  const pending = useRef(new Set<string>());
  const confirm = useConfirmation();
  const groups = workspace.skillGroups ?? [], grouped = new Set(groups.flatMap(group => group.skillIds));
  const collections = [...groups.map(group => ({ id: group.id, name: group.name, source: group.source, group, skills: workspace.skills.filter(skill => group.skillIds.includes(skill.id)) })),
    { id: 'ungrouped', name: '独立 Skill', source: '', group: undefined, skills: workspace.skills.filter(skill => !grouped.has(skill.id)) }];
  const query = search.trim().toLocaleLowerCase();
  function skillBusy(id: string) { return busy.includes(id) || groups.some(group => group.skillIds.includes(id) && busy.includes(group.id)); }
  async function perform(id: string, method: string, params: unknown, message: string) {
    if (pending.current.has(id)) return;
    pending.current.add(id); setBusy(value => [...value, id]); setOperationError('');
    try {
      if (await action(method, params, message) === null) setOperationError('操作未完成，请检查连接或导入状态后重试。');
    } finally {
      pending.current.delete(id); setBusy(value => value.filter(item => item !== id));
    }
  }
  async function uninstallSkill(skill: SkillPackage) {
    if (!await confirm({ title: `卸载“${skill.name}”？`, description: '此 Skill 将从库和所属分组移除，已有任务绑定会显示不可用。运行中的任务和历史快照会保留，可从原来源重新导入恢复。', confirmLabel: '卸载 Skill' })) return;
    await perform(skill.id, 'skill.uninstall', { skillId: skill.id }, 'Skill 已卸载');
  }
  async function uninstallGroup(group: SkillGroup) {
    const others = new Set(groups.filter(item => item.id !== group.id).flatMap(item => item.skillIds));
    const shared = group.skillIds.filter(id => others.has(id)).length;
    if (!await confirm({ title: `卸载分组“${group.name}”？`, description: `移除该分组及其独有的 ${group.skillIds.length - shared} 个 Skill。${shared ? `仍属于其他分组的 ${shared} 个 Skill 会保留。` : ''}引用已卸载 Skill 的任务需重新选择，运行中的任务和历史快照会保留。`, confirmLabel: '卸载分组' })) return;
    await perform(group.id, 'skill.group.uninstall', { id: group.id }, 'Skill 分组已卸载');
  }
  return <div className="content-page">
    <div className="page-heading"><div><h1>Skill 工作室</h1></div><Button variant="primary" onClick={() => setImporting(true)}><Plus size={16} />导入 Skill</Button></div>
    <div className="page-toolbar"><input type="search" aria-label="搜索 Skill 或分组" placeholder="搜索 Skill 或分组" value={search} onChange={event => setSearch(event.target.value)} /><Button onClick={() => setPromptStudio(true)}>提示词实验与模板</Button></div>
    {operationError && <Notice kind="error">{operationError}</Notice>}
    {(workspace.skillImports?.length ?? 0) > 0 && <details className="skill-import-history"><summary>导入记录（{workspace.skillImports!.length}）</summary>{workspace.skillImports!.slice(0, 10).map(job => <SkillImportRecord key={job.id} job={job} groups={groups} action={action} />)}</details>}
    <div className="settings-grid"><div className="skill-studio-groups">
      {workspace.skills.length ? collections.map(collection => {
        const skills = collection.name.toLocaleLowerCase().includes(query) ? collection.skills : collection.skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query));
        if (!skills.length) return null;
        const group = collection.group;
        return <section className="skill-studio-group" key={collection.id} aria-label={`Skill 分组“${collection.name}”`}>
          <div className="skill-studio-group__heading"><div><h2>{collection.name} <span className="tiny-meta">{collection.skills.length} 个 Skill · 已启用 {collection.skills.filter(skill => skill.enabled).length} 个</span></h2>{collection.source && <p className="tiny-meta">{collection.source}</p>}</div>{group && <div className="skill-studio-group__actions"><Button aria-label={`编辑分组“${collection.name}”`} disabled={busy.includes(collection.id)} onClick={() => setEditingGroup(group)}>编辑分组</Button><Button aria-label={`${collection.skills.every(skill => skill.enabled) ? '停用' : '启用'}分组“${collection.name}”`} busy={busy.includes(collection.id)} disabled={collection.skills.some(skill => busy.includes(skill.id))} onClick={() => void perform(collection.id, 'skill.group.toggle', { id: collection.id, enabled: !collection.skills.every(skill => skill.enabled) }, '分组启用状态已更新')}>{collection.skills.every(skill => skill.enabled) ? '停用整组' : '启用整组'}</Button><Button variant="ghost" aria-label={`卸载分组“${collection.name}”`} disabled={busy.includes(collection.id) || collection.skills.some(skill => busy.includes(skill.id))} onClick={() => void uninstallGroup(group)}><Trash2 size={15} />卸载分组</Button></div>}</div>
          {skills.map(skill => <article className={'list-card skill-card' + (skill.enabled ? '' : ' skill-card--disabled')} key={skill.id}><div className="list-card__icon"><BookOpen size={20} /></div><div className="list-card__body"><h3>{skill.name}</h3><p>{skill.description}</p><div className="pill-row"><span className="pill">{skill.version.slice(0, 12)}</span><span className="pill">{skill.resources.length} 个资源</span>{skill.tools.length > 0 && <span className="pill">{skill.tools.length} 个工具</span>}</div></div><div className="list-card__actions"><IconButton label={`查看“${skill.name}”`} onClick={() => setSelected(skill)}><Pencil size={16} /></IconButton><Button role="switch" className="skill-toggle" aria-label={`“${skill.name}”启用状态`} aria-checked={skill.enabled} title={skill.enabled ? '停用 Skill' : '启用 Skill'} variant={skill.enabled ? 'primary' : 'default'} static busy={skillBusy(skill.id)} onClick={() => void perform(skill.id, 'skill.toggle', { skillId: skill.id, enabled: !skill.enabled }, skill.enabled ? 'Skill 已停用' : 'Skill 已启用')}>{!skillBusy(skill.id) && (skill.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />)}{skill.enabled ? '已启用' : '已停用'}</Button><Button variant="ghost" aria-label={`卸载“${skill.name}”`} disabled={skillBusy(skill.id)} onClick={() => void uninstallSkill(skill)}><Trash2 size={15} />卸载</Button></div></article>)}
        </section>;
      }) : <div className="section-card"><EmptyState icon={<BookOpen size={25} />} title="把你的方法加入创作" description="导入创作方法，在创建项目和任务设置中直接选用。"><Button variant="primary" onClick={() => setImporting(true)}><Plus size={15} />导入 Skill</Button></EmptyState></div>}
      {workspace.skills.length > 0 && query && !collections.some(collection => collection.name.toLocaleLowerCase().includes(query) && collection.skills.length || collection.skills.some(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query))) && <p className="muted">没有匹配的 Skill。</p>}
    </div><aside><div className="section-card"><div className="list-help"><p>每次导入会将来源中的全部 Skill 保存为一个分组，可自定义组名。</p><p>创建项目时可整组选用，任务设置中可分别调整。</p><p>任务固定所选指令和已展开的引用资源。工具需要单独启用。</p></div></div></aside></div>
    <ToolConnections action={action} />
    {importing && <SkillImportDialog onClose={() => setImporting(false)} />}
    {selected && <SkillDetails key={selected.id} initial={selected} action={action} onClose={() => setSelected(undefined)} />}
    {editingGroup && <GroupDetails group={editingGroup} action={action} onClose={() => setEditingGroup(undefined)} />}
    {promptStudio && <Suspense fallback={null}><PromptStudioLauncher workspace={workspace} onClose={() => setPromptStudio(false)} onOpenOutput={onOpenOutput} /></Suspense>}
  </div>;
}

function GroupDetails({ group, action, onClose }: { group: SkillGroup; action: Action; onClose(): void }) {
  const [name, setName] = useState(group.name), [busy, setBusy] = useState(false);
  return <Dialog title="编辑 Skill 分组" onClose={onClose}><form onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); void action('skill.group.update', { id: group.id, name }).then(result => { if (result) onClose(); }).finally(() => setBusy(false)); }}><div className="dialog__body"><Field label="分组名称"><input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></Field></div><div className="dialog__footer"><Button onClick={onClose}>取消</Button><Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>保存</Button></div></form></Dialog>;
}

function SkillDetails({ initial, action, onClose }: { initial: SkillPackage; action: Action; onClose(): void }) {
  const [skill, setSkill] = useState(initial), [instructions, setInstructions] = useState(initial.instructions);
  const [resource, setResource] = useState(''), [content, setContent] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false), [saving, setSaving] = useState(false);
  useEffect(() => {
    setContent(''); setError('');
    if (!resource) { setLoading(false); return; }
    let current = true; setLoading(true);
    void rpc('skill.resource.read', { skillId: skill.id, path: resource }).then(value => { if (current) setContent(resourceSchema.parse(value).content); }).catch(reason => { if (current) setError(reason instanceof Error ? reason.message.replace(/^Error invoking remote method 'vq:runtime': (?:Error: )?/, '') : String(reason)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [skill.id, resource]);
  return <Dialog title={skill.name} onClose={onClose} className="dialog--wide"><div className="dialog__body"><p>{skill.description}</p><Field label="Skill 指令"><textarea className="skill-editor" value={instructions} onChange={event => setInstructions(event.target.value)} spellCheck={false} /></Field>
    {skill.resources.length > 0 && <><Field label="查看引用资源"><Select value={resource} onChange={event => setResource(event.target.value)}><option value="">选择资源</option>{skill.resources.map(path => <option key={path} value={path}>{path}</option>)}</Select></Field>{loading && <p role="status">正在读取资源…</p>}{error && <Notice kind="error">{error}</Notice>}{content && <pre className="skill-resource-preview" tabIndex={0} aria-label={resource}>{content}</pre>}</>}
    <p className="tiny-meta">来源：{skill.source}</p>{skill.tools.length > 0 && <div className="skill-tools"><h3>工具权限</h3>{skill.tools.map(tool => <label key={tool.id} className="field-inline"><input type="checkbox" checked={tool.enabled} disabled={!supportsSkillScript(tool.id) && !tool.enabled} onChange={event => { const enabled = event.target.checked; void action<SkillPackage>('skill.tool.toggle', { skillId: skill.id, toolId: tool.id, enabled }, '工具权限已更新').then(value => { if (value) setSkill(value); }); }} />{tool.label} <span className="tiny-meta">{supportsSkillScript(tool.id) ? tool.permissions.join('、') : '需通过工具连接运行'}</span></label>)}</div>}</div><div className="dialog__footer"><Button onClick={onClose}>关闭</Button><Button aria-label="保存新版本" variant="primary" busy={saving} onClick={() => { setSaving(true); void action('skill.update', { skillId: skill.id, instructions }, 'Skill 已保存为新版本').then(result => { if (result !== null) onClose(); }).finally(() => setSaving(false)); }}><Check size={15} />保存</Button></div></Dialog>;
}
