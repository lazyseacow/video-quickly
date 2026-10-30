import { expect, it } from 'vitest';
import { DEFAULT_VIDEO_PROFILE, projectSchema, workflowSchema, type WorkflowDefinition } from '@video-quickly/contracts';
import { editContent, mergeEdits, ProjectEditSession, savedEditsSchema } from '../apps/desktop/src/lib/project-edits';

const project = () => projectSchema.parse({ id: 'flow', title: '流程项目', brief: '', revision: 1, profile: DEFAULT_VIDEO_PROFILE, createdAt: '', updatedAt: '', shots: [], workflow: { id: 'graph', version: 1, name: '制作', nodes: [{ id: 'a', kind: 'brief', label: '简报', position: { x: 0, y: 0 } }, { id: 'b', kind: 'agent', label: '文稿', prompt: 'unrelated-prompt-marker'.repeat(1000), position: { x: 300, y: 0 } }], edges: [{ id: 'ab', source: 'a', target: 'b' }] } });
function edit(session: ProjectEditSession, patch: Partial<WorkflowDefinition>, label = '调整流程', group?: string) {
  session.edit({ ...session.state.present, workflow: { ...session.state.present.workflow, ...patch } }, label, group);
}

it('groups typing and pointer movement into incremental commands without copying unrelated prompts', () => {
  const original = project(), session = new ProjectEditSession(original);
  for (const label of ['新', '新的简报']) edit(session, { nodes: session.state.present.workflow.nodes.map(node => node.id === 'a' ? { ...node, label } : node) }, '修改步骤', 'a:label');
  session.endGroup();
  for (const x of [20, 40, 60]) edit(session, { nodes: session.state.present.workflow.nodes.map(node => node.id === 'a' ? { ...node, position: { x, y: 10 } } : node) }, '移动步骤', 'position');
  expect(session.state.undo).toHaveLength(2);
  expect(session.state.undo[0].after.workflow?.nodes?.put.map(node => node.id)).toEqual(['a']);
  expect(session.state.undo[0].after.workflow?.edges).toBeUndefined();
  expect(JSON.stringify(session.state.undo)).not.toContain('unrelated-prompt-marker');
  session.undo(); expect(session.state.present.workflow.nodes[0].position).toEqual({ x: 0, y: 0 });
  session.undo(); expect(session.state.present).toEqual(editContent(original));
  session.redo(); session.redo(); expect(session.state.present.workflow.nodes[0]).toMatchObject({ label: '新的简报', position: { x: 60, y: 10 } });
});

it('restores node deletion and its connections atomically and keeps server versions through undo', () => {
  const original = project(), session = new ProjectEditSession(original);
  const third = workflowSchema.parse({ ...original.workflow, nodes: [{ id: 'c', kind: 'join', label: '汇合' }] }).nodes[0];
  edit(session, { nodes: [...session.state.present.workflow.nodes, third], edges: [...original.workflow.edges, { id: 'bc', source: 'b', target: 'c' }] }, '添加步骤与连接');
  edit(session, { nodes: session.state.present.workflow.nodes.filter(node => node.id !== 'b'), edges: [] }, '移除步骤及连接');
  session.saved({ ...original, ...session.state.present, revision: 2, workflow: { ...session.state.present.workflow, version: 2 } });
  expect(session.dirty).toBe(false);
  const restored = new ProjectEditSession({ ...original, revision: 2 }, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
  restored.undo(); expect(restored.state.present.workflow.nodes.map(node => node.id)).toEqual(['a', 'b', 'c']);
  expect(restored.state.present.workflow.edges.map(edge => edge.id)).toEqual(['ab', 'bc']);
  expect(restored.state.present.workflow.version).toBe(2);
  restored.redo(); expect(restored.state.present.workflow.nodes.map(node => node.id)).toEqual(['a', 'c']);
  expect(restored.state.present.workflow.edges).toEqual([]); expect(restored.state.present.workflow.version).toBe(2);
});

it('persists unfinished names and invalid graph drafts in version 2 without weakening the commit schema', () => {
  const original = project(), session = new ProjectEditSession(original);
  edit(session, { nodes: original.workflow.nodes.map(node => node.id === 'a' ? { ...node, label: '' } : node), edges: [...original.workflow.edges, { id: 'ba', source: 'b', target: 'a' }] });
  const disk = savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state)));
  expect(disk.version).toBe(2);
  const restored = new ProjectEditSession(original, disk);
  expect(restored.state.recovered).toBe(true); expect(restored.state.present.workflow.nodes[0].label).toBe('');
  expect(projectSchema.safeParse({ ...original, ...restored.state.present }).success).toBe(false);
  restored.undo(); expect(restored.state.present).toEqual(editContent(original));
  restored.redo(); expect(restored.state.present.workflow.edges).toHaveLength(2);
});

it('migrates legacy drafts and history while adopting the current workflow instead of overwriting it', () => {
  const original = project(), session = new ProjectEditSession(original);
  session.edit({ ...session.state.present, title: '保留的旧草稿' }, '标题');
  session.edit({ ...session.state.present, brief: '可重做的简报' }, '简报'); session.undo();
  const legacy = JSON.parse(JSON.stringify(session.state)); legacy.version = 1;
  delete legacy.base.workflow; delete legacy.present.workflow;
  const remote = { ...original, revision: 2, workflow: { ...original.workflow, version: 3, name: '新版流程' } };
  const restored = new ProjectEditSession(remote, savedEditsSchema.parse(legacy));
  expect(restored.state.version).toBe(2); expect(restored.state.present.title).toBe('保留的旧草稿');
  expect(restored.state.present.workflow).toEqual(remote.workflow); expect(restored.state.conflict).toBeUndefined();
  restored.redo(); expect(restored.state.present.brief).toBe('可重做的简报');
  restored.undo(); restored.undo(); expect(restored.state.present.workflow).toEqual(remote.workflow); expect(restored.state.present.title).toBe(original.title);
});

it('synchronizes workflow version metadata without recording it as an edit', () => {
  const original = project(), session = new ProjectEditSession(original);
  edit(session, { version: 80 }); expect(session.dirty).toBe(false); expect(session.state.undo).toEqual([]);
  session.receive({ ...original, revision: 2, workflow: { ...original.workflow, version: 4 } });
  expect(session.state.present.workflow.version).toBe(4); expect(session.state.base.workflow.version).toBe(4);
  expect(session.dirty).toBe(false); expect(session.state.undo).toEqual([]);
});

it('rebases independent project changes without letting graph undo overwrite them', () => {
  const original = project(), session = new ProjectEditSession(original);
  edit(session, { name: '我的流程名称' });
  session.receive({ ...original, revision: 2, title: '外部项目名称' });
  expect(session.state.conflict).toBeUndefined(); expect(session.state.revision).toBe(2);
  expect(session.state.present.title).toBe('外部项目名称');
  session.undo(); expect(session.state.present.title).toBe('外部项目名称'); expect(session.state.present.workflow.name).toBe(original.workflow.name);
  session.redo(); expect(session.state.present.workflow.name).toBe('我的流程名称');
  const other = new ProjectEditSession(original); other.edit({ ...other.state.present, brief: '我的简报' }, '简报');
  other.receive({ ...original, revision: 2, workflow: { ...original.workflow, version: 2, name: '外部流程名称' } });
  other.undo(); expect(other.state.present.workflow.name).toBe('外部流程名称'); expect(other.state.present.brief).toBe('');
});

it('treats competing dependency graphs as one conflict, retaining independent remote fields', () => {
  const original = project(), session = new ProjectEditSession(original);
  edit(session, { nodes: original.workflow.nodes.map(node => node.id === 'a' ? { ...node, label: '我的简报' } : node) });
  const remote = { ...original, revision: 2, title: '远端标题', workflow: { ...original.workflow, version: 2, nodes: [original.workflow.nodes[0]], edges: [] } };
  session.receive(remote); expect(session.state.revision).toBe(1); expect(session.state.conflict).toEqual(remote);
  expect(mergeEdits(session.state.base, session.state.present, editContent(remote)).conflicts.map(item => item.path)).toEqual(['workflow']);
  session.resolve({ workflow: 'local' });
  expect(session.state.present.title).toBe('远端标题'); expect(session.state.present.workflow.nodes[0].label).toBe('我的简报');
  expect(session.state.present.workflow.edges).toHaveLength(1); expect(session.state.present.workflow.version).toBe(2);
  session.undo(); expect(session.state.present).toEqual(editContent(remote));
  const second = new ProjectEditSession(original); edit(second, { name: '本地名称' }); second.receive(remote); second.resolve({ workflow: 'remote' });
  expect(second.state.present.workflow).toEqual(remote.workflow); expect(second.dirty).toBe(false);
});

it('requires explicit rebase when remote fields are still owned by saved undo history', () => {
  const original = project(), session = new ProjectEditSession(original);
  session.edit({ ...session.state.present, title: '已保存的标题' }, '标题');
  const saved = { ...original, ...session.state.present, revision: 2 }; session.saved(saved);
  edit(session, { name: '流程草稿' });
  session.receive({ ...saved, revision: 3, title: '外部较新标题' });
  expect(session.state.conflict).toBeDefined(); session.resolve({}); session.undo();
  expect(session.state.present.title).toBe('外部较新标题'); expect(session.state.undo).toEqual([]);
});

it('retains newer graph input during saving, restamping only the committed server version', () => {
  const original = project(), session = new ProjectEditSession(original);
  edit(session, { name: '已提交的名称' }); session.beginSave();
  const saved = { ...original, ...session.state.present, revision: 2, workflow: { ...session.state.present.workflow, version: 2 } };
  edit(session, { name: '等待保存时的新名称' });
  session.receive(saved); session.saved(saved); session.endSave();
  expect(session.state.present.workflow).toMatchObject({ version: 2, name: '等待保存时的新名称' });
  expect(session.state.base.workflow.name).toBe('已提交的名称'); expect(session.dirty).toBe(true); expect(session.state.conflict).toBeUndefined();
  const recovered = new ProjectEditSession(saved, savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state))));
  recovered.undo(); expect(recovered.state.present.workflow).toEqual(saved.workflow); expect(recovered.dirty).toBe(false);
});

it('recognizes a committed graph after a lost response without losing undo and redo', () => {
  const original = project(), session = new ProjectEditSession(original);
  edit(session, { name: '提交的流程名称' }); session.beginSave();
  const disk = savedEditsSchema.parse(JSON.parse(JSON.stringify(session.state)));
  const committed = { ...original, ...session.state.present, revision: 2, workflow: { ...session.state.present.workflow, version: 2 } };
  const recovered = new ProjectEditSession(committed, disk);
  expect(recovered.dirty).toBe(false); expect(recovered.state.recovered).toBe(false);
  expect(recovered.state.present.workflow.version).toBe(2);
  recovered.undo(); expect(recovered.state.present.workflow).toEqual({ ...original.workflow, version: 2 });
  recovered.redo(); expect(recovered.dirty).toBe(false);
});
