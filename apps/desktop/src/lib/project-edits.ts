import { z } from 'zod';
import { barChartSceneTemplateSchema, clipEditPlanSchema, clipEditSourceSchema, comparisonSceneTemplateSchema, musicClipSchema, processSceneTemplateSchema, projectSchema, shotSchema, videoProfileSchema, workflowNodeSchema, workflowSchema, type ProjectDocument, type Shot } from '@video-quickly/contracts';

// Preserve unfinished input, including values the commit schema will reject.
const draftComparisonSide = comparisonSceneTemplateSchema.shape.left.extend({ title: z.string(), points: z.array(z.string()).min(1).max(5) });
const draftSceneTemplateSchema = z.discriminatedUnion('kind', [
  processSceneTemplateSchema.extend({ heading: z.string(), steps: z.array(processSceneTemplateSchema.shape.steps.element.extend({ title: z.string(), detail: z.string() })).min(2).max(6) }),
  comparisonSceneTemplateSchema.extend({ heading: z.string(), left: draftComparisonSide, right: draftComparisonSide }),
  barChartSceneTemplateSchema.extend({ heading: z.string(), unit: z.string(), bars: z.array(barChartSceneTemplateSchema.shape.bars.element.extend({ label: z.string(), value: z.number().finite() })).min(2).max(6) }),
]);
const draftShotSchema = shotSchema.extend({ title: z.string(), narration: z.string(), visualPrompt: z.string(), durationUs: z.number().finite(), sceneTemplate: draftSceneTemplateSchema.optional() });
const draftProfileSchema = videoProfileSchema.extend({ width: z.number().finite(), height: z.number().finite(), frameRate: z.object({ numerator: z.number().finite(), denominator: z.number().finite() }) });
const draftWorkflowSchema = workflowSchema.extend({ nodes: z.array(workflowNodeSchema.extend({ label: z.string() })).max(100) });
export const editContentSchema = projectSchema.pick({ title: true, brief: true, profile: true, style: true, claims: true, shots: true, musicClips: true, researchSources: true, referenceDisplay: true, captionStyle: true, scenePreset: true, audioMix: true, clipEditSources: true, clipEditPlans: true }).extend({ title: z.string(), brief: z.string(), profile: draftProfileSchema, shots: z.array(draftShotSchema), workflow: draftWorkflowSchema, musicClips: z.array(musicClipSchema).default([]), researchSources: projectSchema.shape.researchSources.unwrap().default([]), referenceDisplay: projectSchema.shape.referenceDisplay.unwrap().default('hidden'), captionStyle: projectSchema.shape.captionStyle.default(null), scenePreset: projectSchema.shape.scenePreset.default(null), audioMix: projectSchema.shape.audioMix.default(null), clipEditSources: projectSchema.shape.clipEditSources.unwrap().default([]), clipEditPlans: projectSchema.shape.clipEditPlans.unwrap().default([]) });
export type EditContent = z.infer<typeof editContentSchema>;
const shotPatchSchema = z.object({ put: z.array(draftShotSchema), remove: z.array(z.string()), order: z.array(z.string()).optional() });
const workflowPatchSchema = z.object({
  id: z.string().optional(), name: z.string().optional(),
  subflows: workflowSchema.shape.subflows.unwrap().nullable().optional(), execution: workflowSchema.shape.execution.unwrap().nullable().optional(),
  nodes: z.object({ put: z.array(draftWorkflowSchema.shape.nodes.element), remove: z.array(z.string()), order: z.array(z.string()).optional() }).optional(),
  edges: z.object({ put: z.array(workflowSchema.shape.edges.element), remove: z.array(z.string()), order: z.array(z.string()).optional() }).optional(),
});
// Snapshot defaults must never turn an absent incremental field into a clearing command.
const editPatchSchema = editContentSchema.omit({ shots: true, workflow: true, musicClips: true, researchSources: true, referenceDisplay: true, captionStyle: true, scenePreset: true, style: true, claims: true, audioMix: true, clipEditSources: true, clipEditPlans: true }).partial().extend({ style: projectSchema.shape.style.unwrap().optional(), claims: projectSchema.shape.claims.unwrap().optional(), shots: shotPatchSchema.optional(), workflow: workflowPatchSchema.optional(), musicClips: z.array(musicClipSchema).optional(), researchSources: projectSchema.shape.researchSources, referenceDisplay: projectSchema.shape.referenceDisplay, captionStyle: projectSchema.shape.captionStyle, scenePreset: projectSchema.shape.scenePreset, audioMix: projectSchema.shape.audioMix, clipEditSources: z.object({ put: z.array(clipEditSourceSchema), remove: z.array(z.string()), order: z.array(z.string()).optional() }).optional(), clipEditPlans: z.object({ put: z.array(clipEditPlanSchema), remove: z.array(z.string()), order: z.array(z.string()).optional() }).optional() });
type EditPatch = z.infer<typeof editPatchSchema>;
const commandSchema = z.object({ label: z.string(), before: editPatchSchema, after: editPatchSchema }).transform(command => {
  const before = { ...command.before }, after = { ...command.after };
  // Earlier parsers could persist the same snapshot defaults on both sides of an unrelated command.
  for (const key of Object.keys(before) as Array<keyof typeof before>) if (Object.hasOwn(after, key) && sameContent(before[key], after[key])) { delete before[key]; delete after[key]; }
  return { ...command, before, after };
});
type EditCommand = z.infer<typeof commandSchema>;
const savedEditFields = {
  projectId: z.string(), revision: z.number().int().positive(),
  undo: z.array(commandSchema).max(50), redo: z.array(commandSchema).max(50), selectedShotId: z.string().optional(),
};
const currentSavedEditsSchema = z.object({ ...savedEditFields, version: z.literal(2), base: editContentSchema, present: editContentSchema });
const legacySavedEditsSchema = z.object({ ...savedEditFields, version: z.literal(1), base: editContentSchema.omit({ workflow: true }), present: editContentSchema.omit({ workflow: true }) });
export const savedEditsSchema = z.discriminatedUnion('version', [legacySavedEditsSchema, currentSavedEditsSchema]);
export type SavedEdits = z.infer<typeof savedEditsSchema>;
type EditorState = z.infer<typeof currentSavedEditsSchema> & { conflict?: ProjectDocument; recovered: boolean; busy: boolean };
export type EditConflict = { path: string; label: string; local: unknown; remote: unknown };
const keys = ['title', 'brief', 'profile', 'style', 'claims', 'musicClips', 'researchSources', 'referenceDisplay', 'captionStyle', 'scenePreset', 'audioMix'] as const;
export function sameContent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => sameContent(value, right[index]));
  if (!isObject(left) || !isObject(right)) return false;
  const leftKeys = Object.keys(left).filter(key => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && sameContent(left[key], right[key]));
}
export function editContent(project: ProjectDocument): EditContent {
  return { title: project.title, brief: project.brief, profile: project.profile, style: project.style, claims: project.claims, shots: project.shots, workflow: project.workflow, musicClips: project.musicClips ?? [], researchSources: project.researchSources ?? [], referenceDisplay: project.referenceDisplay ?? 'hidden', captionStyle: project.captionStyle ?? null, scenePreset: project.scenePreset ?? null, audioMix: project.audioMix ?? null, clipEditSources: project.clipEditSources ?? [], clipEditPlans: project.clipEditPlans ?? [] };
}

export function sameWorkflow(left: EditContent['workflow'], right: EditContent['workflow']) {
  const { version: _leftVersion, ...before } = left, { version: _rightVersion, ...after } = right;
  return sameContent(before, after);
}
function sameEdits(left: EditContent, right: EditContent) {
  return left === right || sameWorkflow(left.workflow, right.workflow) && sameContent({ ...left, workflow: undefined }, { ...right, workflow: undefined });
}
function workflowVersion(content: EditContent, version: number): EditContent {
  return content.workflow.version === version ? content : { ...content, workflow: { ...content.workflow, version } };
}

function diff(from: EditContent, to: EditContent): EditPatch {
  const patch: EditPatch = {};
  for (const key of keys) if (!sameContent(from[key], to[key])) Object.assign(patch, { [key]: to[key] });
  const previous = new Map(from.shots.map(shot => [shot.id, shot]));
  const next = new Map(to.shots.map(shot => [shot.id, shot]));
  const put = to.shots.filter(shot => !sameContent(previous.get(shot.id), shot));
  const remove = from.shots.filter(shot => !next.has(shot.id)).map(shot => shot.id);
  const order = to.shots.map(shot => shot.id);
  const reordered = !sameContent(from.shots.map(shot => shot.id), order);
  if (put.length || remove.length || reordered) patch.shots = { put, remove, ...(reordered ? { order } : {}) };
  const sources = diffRecords(from.clipEditSources, to.clipEditSources), plans = diffRecords(from.clipEditPlans, to.clipEditPlans);
  if (sources) patch.clipEditSources = sources;
  if (plans) patch.clipEditPlans = plans;
  const nodes = diffRecords(from.workflow.nodes, to.workflow.nodes), edges = diffRecords(from.workflow.edges, to.workflow.edges);
  if (!sameWorkflow(from.workflow, to.workflow)) patch.workflow = { ...(from.workflow.id !== to.workflow.id ? { id: to.workflow.id } : {}), ...(from.workflow.name !== to.workflow.name ? { name: to.workflow.name } : {}), ...(!sameContent(from.workflow.subflows, to.workflow.subflows) ? { subflows: to.workflow.subflows ?? null } : {}), ...(!sameContent(from.workflow.execution, to.workflow.execution) ? { execution: to.workflow.execution ?? null } : {}), ...(nodes ? { nodes } : {}), ...(edges ? { edges } : {}) };
  return patch;
}

function diffRecords<T extends { id: string }>(from: readonly T[], to: readonly T[]) {
  const previous = new Map(from.map(value => [value.id, value])), next = new Set(to.map(value => value.id));
  const put = to.filter(value => !sameContent(previous.get(value.id), value)), remove = from.filter(value => !next.has(value.id)).map(value => value.id);
  const order = to.map(value => value.id), reordered = !sameContent(from.map(value => value.id), order);
  return put.length || remove.length || reordered ? { put, remove, ...(reordered ? { order } : {}) } : undefined;
}
function applyRecords<T extends { id: string }>(current: T[], patch?: { put: T[]; remove: string[]; order?: string[] }): T[] {
  if (!patch) return current;
  const values = new Map(current.map(value => [value.id, value]));
  for (const id of patch.remove) values.delete(id);
  for (const value of patch.put) values.set(value.id, value);
  return (patch.order ?? [...values.keys()]).flatMap(id => { const value = values.get(id); return value ? [value] : []; });
}

function apply(content: EditContent, patch: EditPatch): EditContent {
  const { shots: changes, workflow: graph, clipEditSources: sources, clipEditPlans: plans, ...settings } = patch;
  const workflow = graph ? { ...content.workflow, ...(graph.id !== undefined ? { id: graph.id } : {}), ...(graph.name !== undefined ? { name: graph.name } : {}), ...(Object.hasOwn(graph, 'subflows') ? { subflows: graph.subflows ?? undefined } : {}), ...(Object.hasOwn(graph, 'execution') ? { execution: graph.execution ?? undefined } : {}), nodes: applyRecords(content.workflow.nodes, graph.nodes), edges: applyRecords(content.workflow.edges, graph.edges) } : content.workflow;
  const collections = { workflow, clipEditSources: applyRecords(content.clipEditSources, sources), clipEditPlans: applyRecords(content.clipEditPlans, plans) };
  if (!changes) return { ...content, ...settings, ...collections };
  const shots = new Map(content.shots.map(shot => [shot.id, shot]));
  for (const id of changes.remove) shots.delete(id);
  for (const shot of changes.put) shots.set(shot.id, shot);
  return { ...content, ...settings, ...collections, shots: (changes.order ?? [...shots.keys()]).flatMap(id => { const shot = shots.get(id); return shot ? [shot] : []; }) };
}

const fieldLabels: Record<string, string> = { clipEdit: '文稿剪辑', clipEditSources: '原始镜头', clipEditPlans: '剪辑计划', audioProcessing: '镜头声音处理', audioMix: '项目混音', captionStyle: '字幕样式', scenePreset: '新镜头模板默认', researchSources: '资料正文', referenceDisplay: '成片引用编号', claimIds: '镜头引用', musicClips: '背景音乐', characterIds: '镜头角色', sceneTemplate: '科普画面模板', captionTrack: '字幕', sourceInUs: '素材入点', audioInUs: '旁白入点', videoInUs: '视频入点', sceneInUs: '场景入点', sceneDurationUs: '原场景时长', title: '标题', brief: '创意简报', profile: '视频规格', width: '宽度', height: '高度', frameRate: '帧率', style: '系列风格', claims: '事实主张', narration: '旁白', visualPrompt: '画面要求', durationUs: '时长', animation: '运镜', zoom: '缩放', panX: '水平移动', panY: '垂直移动', transition: '转场', assetId: '画面素材', videoAssetId: '视频素材', audioAssetId: '旁白音频', locked: '锁定状态' };
export function mergeEdits(base: EditContent, local: EditContent, remote: EditContent, choices: Record<string, 'local' | 'remote'> = {}) {
  const conflicts: EditConflict[] = [];
  function merge(original: unknown, mine: unknown, theirs: unknown, path: string, label: string): unknown {
    if (sameContent(mine, original)) return theirs;
    if (sameContent(theirs, original) || sameContent(mine, theirs)) return mine;
    if (isObject(original) && isObject(mine) && isObject(theirs)) {
      return Object.fromEntries([...new Set([...Object.keys(original), ...Object.keys(mine), ...Object.keys(theirs)])].map(key => [key, merge(original[key], mine[key], theirs[key], `${path}.${key}`, `${label} · ${fieldLabels[key] ?? key}`)]));
    }
    conflicts.push({ path, label, local: mine, remote: theirs });
    return choices[path] === 'remote' ? theirs : mine;
  }
  const settings = Object.fromEntries(keys.map(key => [key, merge(base[key], local[key], remote[key], key, fieldLabels[key])])) as Omit<EditContent, 'shots' | 'workflow' | 'clipEditSources' | 'clipEditPlans'>;
  let workflow: EditContent['workflow'];
  if (sameWorkflow(local.workflow, base.workflow)) workflow = remote.workflow;
  else if (sameWorkflow(remote.workflow, base.workflow) || sameWorkflow(local.workflow, remote.workflow)) workflow = workflowVersion(local, remote.workflow.version).workflow;
  else {
    // Nodes and edges form one dependency graph; merging their arrays independently can create dangling edges or cycles.
    conflicts.push({ path: 'workflow', label: '流程编排', local: local.workflow, remote: remote.workflow });
    workflow = choices.workflow === 'remote' ? remote.workflow : workflowVersion(local, remote.workflow.version).workflow;
  }
  function mergeRecords<T extends { id: string }>(before: T[], mine: T[], theirs: T[], key: string): T[] {
    const original = new Map(before.map(value => [value.id, value])), localValues = new Map(mine.map(value => [value.id, value])), remoteValues = new Map(theirs.map(value => [value.id, value]));
    return [...new Set([...original.keys(), ...localValues.keys(), ...remoteValues.keys()])].flatMap(id => {
      const value = merge(original.get(id), localValues.get(id), remoteValues.get(id), `${key}.${id}`, fieldLabels[key]) as T | undefined;
      return value ? [value] : [];
    });
  }
  const previous = new Map(base.shots.map(shot => [shot.id, shot]));
  const mine = new Map(local.shots.map(shot => [shot.id, shot]));
  const theirs = new Map(remote.shots.map(shot => [shot.id, shot]));
  const shots = new Map<string, Shot>();
  for (const id of new Set([...previous.keys(), ...mine.keys(), ...theirs.keys()])) {
    const shot = merge(previous.get(id), mine.get(id), theirs.get(id), `shots.${id}`, `镜头「${mine.get(id)?.title ?? theirs.get(id)?.title ?? previous.get(id)?.title}」`) as Shot | undefined;
    if (shot) shots.set(id, shot);
  }
  const order = merge(base.shots.map(shot => shot.id), local.shots.map(shot => shot.id), remote.shots.map(shot => shot.id), 'shot-order', '镜头顺序') as string[];
  const ordered = [...new Set([...order, ...shots.keys()])].flatMap(id => { const shot = shots.get(id); return shot ? [shot] : []; });
  return { content: { ...settings, workflow, clipEditSources: mergeRecords(base.clipEditSources, local.clipEditSources, remote.clipEditSources, 'clipEditSources'), clipEditPlans: mergeRecords(base.clipEditPlans, local.clipEditPlans, remote.clipEditPlans, 'clipEditPlans'), shots: ordered }, conflicts };
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export class ProjectEditSession {
  private listeners = new Set<() => void>();
  private group?: string;
  private deferred?: ProjectDocument;
  state: EditorState;
  constructor(project: ProjectDocument, saved?: SavedEdits) {
    const content = editContent(project);
    const restored = saved?.projectId !== project.id ? undefined : saved.version === 2 ? saved : { ...saved, version: 2 as const, base: { ...saved.base, workflow: content.workflow }, present: { ...saved.present, workflow: content.workflow } };
    this.state = { version: 2, projectId: project.id, revision: project.revision, base: content, present: content, undo: [], redo: [], selectedShotId: project.shots[0]?.id, recovered: false, busy: false, ...restored };
    this.state.recovered = this.dirty;
    this.receive(project);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get dirty() { return !sameEdits(this.state.base, this.state.present); }
  private publish(patch: Partial<EditorState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  endGroup = () => { this.group = undefined; };
  select(id?: string) { this.endGroup(); this.publish({ selectedShotId: id }); }
  edit(next: EditContent, label: string, group?: string) {
    next = workflowVersion(next, this.state.present.workflow.version);
    if (sameEdits(next, this.state.present)) return;
    const undo = [...this.state.undo];
    const previous = group && group === this.group ? undo.pop() : undefined;
    const original = previous ? apply(this.state.present, previous.before) : this.state.present;
    if (!sameEdits(original, next)) undo.push({ label, before: diff(next, original), after: diff(original, next) });
    this.group = group;
    this.publish({ present: next, undo: undo.slice(-50), redo: [] });
  }
  undo() {
    const command = this.state.undo.at(-1);
    if (!command || this.state.busy || this.state.conflict) return;
    this.endGroup();
    this.publish({ present: apply(this.state.present, command.before), undo: this.state.undo.slice(0, -1), redo: [...this.state.redo, command] });
  }
  redo() {
    const command = this.state.redo.at(-1);
    if (!command || this.state.busy || this.state.conflict) return;
    this.endGroup();
    this.publish({ present: apply(this.state.present, command.after), undo: [...this.state.undo, command], redo: this.state.redo.slice(0, -1) });
  }
  receive(project: ProjectDocument) {
    if (project.revision <= this.state.revision) return;
    if (this.state.busy) { this.deferred = project; return; }
    const remote = editContent(project);
    if (sameEdits(remote, this.state.base)) { this.publish({ revision: project.revision, base: remote, present: workflowVersion(this.state.present, remote.workflow.version), conflict: undefined }); return; }
    // A crash can happen after SQLite commits but before the client receives the reply.
    if (sameEdits(remote, this.state.present)) { this.publish({ revision: project.revision, base: remote, present: workflowVersion(this.state.present, remote.workflow.version), conflict: undefined, recovered: false }); return; }
    const changed = Object.keys(diff(this.state.base, remote)) as Array<keyof EditContent>;
    const protectedFields = new Set([...Object.keys(diff(this.state.base, this.state.present)), ...this.state.undo.flatMap(command => Object.keys(command.before)), ...this.state.redo.flatMap(command => Object.keys(command.after))]);
    if (changed.every(key => !protectedFields.has(key))) {
      const present = { ...this.state.present };
      for (const key of changed) Object.assign(present, { [key]: remote[key] });
      this.endGroup();
      this.publish({ revision: project.revision, base: remote, present: workflowVersion(present, remote.workflow.version), conflict: undefined });
      return;
    }
    if (this.dirty) { this.publish({ conflict: project }); return; }
    this.endGroup();
    this.publish({ revision: project.revision, base: remote, present: remote, undo: [], redo: [], conflict: undefined });
  }
  beginSave() { this.endGroup(); this.publish({ busy: true }); }
  saved(project: ProjectDocument) { this.publish({ revision: project.revision, base: editContent(project), present: workflowVersion(this.state.present, project.workflow.version), conflict: undefined, recovered: false }); }
  applySaved(project: ProjectDocument, label: string) { this.edit(editContent(project), label); this.saved(project); }
  endSave() {
    this.publish({ busy: false });
    const deferred = this.deferred; this.deferred = undefined;
    if (deferred) this.receive(deferred);
  }
  resolve(choices: Record<string, 'local' | 'remote'>) {
    const remote = this.state.conflict;
    if (!remote) return;
    const base = editContent(remote);
    const { content } = mergeEdits(this.state.base, this.state.present, base, choices);
    this.endGroup();
    this.publish({ revision: remote.revision, base, present: base, undo: [], redo: [], conflict: undefined });
    this.edit(content, '合并草稿');
  }
  discard(project: ProjectDocument) {
    const content = editContent(project); this.endGroup();
    this.publish({ revision: project.revision, base: content, present: content, undo: [], redo: [], conflict: undefined, recovered: false });
  }
}
