import { createSceneTemplate, creativeContextSchema, formatPlanningDocument, MAX_STORYBOARD_SHOTS, projectSchema, shotSchema, validateCreativeReferences, type CreativeContext, type JsonValue, type ManualPlanningFields, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { sameContent, type EditContent } from './project-edits';

export type PlanningSection = 'brief' | 'style' | 'script';
export type PlanningProject = Pick<ProjectDocument, 'brief' | 'style' | 'creativeContext' | 'shots' | 'profile'> & { title?: string; manualPlanningFields?: ManualPlanningFields };
export const planningLabels = { brief: '创意简报', style: '风格与角色', script: '旁白与分镜' };
const planningShotFields = ['title', 'narration', 'visualPrompt', 'soundPrompt'] as const;
const storyboardFields = ['durationUs', 'characterIds', 'creativeEntityKeys'] as const;
export type PlanningShot = Pick<Shot, 'id' | typeof planningShotFields[number]> & Partial<Pick<Shot, typeof storyboardFields[number]>>;
export type PlanningChange = { kind: 'brief'; text: string; fields?: ManualPlanningFields['brief'] }
  | { kind: 'style'; text: string; fields?: ManualPlanningFields['style']; creativeContext: CreativeContext | null }
  | { kind: 'script'; shots: PlanningShot[]; newShots?: PlanningShot[]; creativeContext?: CreativeContext | null };
export type StoryboardDraft = Pick<PlanningProject, 'shots' | 'creativeContext'>;
export const storyboardDraftSchema = projectSchema.pick({ shots: true, creativeContext: true });
export interface PlanningEditOptions { storyboard?: StoryboardDraft; profile?: PlanningProject['profile']; onSaved?(context: PlanningProject['creativeContext']): void }
export interface PlanningControls { project: PlanningProject; onEdit(section: PlanningSection, options?: PlanningEditOptions): void; disabledReason?: string }
export const isPlanningSection = (kind: string): kind is PlanningSection => ['brief', 'style', 'script'].includes(kind);

export function readRecordedStoryboardDraft(value: JsonValue, currentContext: PlanningProject['creativeContext']): StoryboardDraft | undefined {
  const draft = storyboardDraftSchema.safeParse(value).data;
  if (!draft?.shots.length) return;
  if (!currentContext || !draft.creativeContext) return draft;

  const missingKeys = new Set(draft.shots.flatMap(shot => shot.creativeEntityKeys ?? []));
  for (const entity of currentContext.entities) missingKeys.delete(entity.key);
  const restored = draft.creativeContext.entities.filter(entity => missingKeys.has(entity.key));
  return { shots: draft.shots, creativeContext: { ...currentContext, entities: [...currentContext.entities, ...restored] } };
}

function changedField<T>(current: T, before: T, after: T, label: string): T {
  if (sameContent(before, after)) return current;
  if (!sameContent(current, before) && !sameContent(current, after)) throw new Error(`${label}已在其他位置修改，输入已保留，请关闭后重新核对。`);
  return after;
}

/** Apply authored fields and append new shots while preserving existing media and unrelated edits. */
export function applyPlanningEdit(current: EditContent, baseline: PlanningProject, change: PlanningChange): EditContent {
  if (change.kind !== 'script') {
    const kind = change.kind, label = kind === 'brief' ? '创意简报' : '视觉风格';
    const next = { ...current, [kind]: changedField(current[kind], baseline[kind], projectSchema.shape[kind].parse(change.text), label) };
    if (change.kind === 'style') next.creativeContext = changedField(current.creativeContext ?? null, baseline.creativeContext ?? null, creativeContextSchema.nullable().parse(change.creativeContext), '角色与创作设定');
    if (!change.fields) return next;
    const { production } = current.workflow;
    const fields = changedField(production.manualPlanningFields?.[kind], baseline.manualPlanningFields?.[kind], change.fields, label);
    const manualPlanningSteps = [...new Set([...(production.manualPlanningSteps ?? []), kind])];
    return { ...next, workflow: { ...current.workflow, production: { ...production, manualPlanningSteps, manualPlanningFields: { ...production.manualPlanningFields, [kind]: fields } } } };
  }
  const previous = new Map(baseline.shots.map(shot => [shot.id, shot]));
  const live = new Map(current.shots.map(shot => [shot.id, shot]));
  const replacements = new Map<string, Shot>();
  for (const input of change.shots) {
    const before = previous.get(input.id), shot = live.get(input.id);
    if (!before) throw new Error('分镜不属于打开时的项目，请重新核对。');
    const editable = [...planningShotFields, ...storyboardFields.filter(field => field in input)];
    const fields = editable.filter(field => !sameContent(before[field], input[field]));
    if (!fields.length) continue;
    if (!shot) throw new Error(`镜头「${before.title}」已移除，输入已保留，请重新核对。`);
    if (shot.locked) throw new Error(`镜头「${shot.title}」已锁定，请先解锁再修改。`);
    const patch: Partial<Shot> = {};
    for (const field of fields) {
      if (field === 'durationUs' && shot.clipEdit) throw new Error(`镜头「${shot.title}」已在时间轴裁剪，请在时间轴调整时长。`);
      const value = changedField(shot[field], before[field], shotSchema.shape[field].parse(input[field]), `镜头「${shot.title}」的内容`);
      Object.assign(patch, { [field]: value });
    }
    replacements.set(shot.id, { ...shot, ...patch });
  }
  const additions: Shot[] = [];
  const newIds = new Set<string>();
  for (const input of change.newShots ?? []) {
    if (previous.has(input.id) || newIds.has(input.id)) throw new Error('镜头编号已存在，请重新打开分镜表单。');
    newIds.add(input.id);
    const preset = current.scenePreset;
    const sceneTemplate = preset ? { ...createSceneTemplate(preset.kind), palette: preset.palette, motion: preset.motion } : undefined;
    const shot = shotSchema.parse({ ...input, sceneTemplate });
    const existing = live.get(shot.id);
    if (existing && !sameContent(existing, shot)) throw new Error('新增镜头已在项目中修改，请重新打开分镜表单。');
    if (!existing) additions.push(shot);
  }
  const shots = [...current.shots.map(shot => replacements.get(shot.id) ?? shot), ...additions];
  if (additions.length && shots.length > MAX_STORYBOARD_SHOTS) throw new Error(`分镜最多可填写 ${MAX_STORYBOARD_SHOTS} 个镜头。`);
  const creativeContext = change.creativeContext === undefined ? current.creativeContext
    : changedField(current.creativeContext ?? null, baseline.creativeContext ?? null, creativeContextSchema.nullable().parse(change.creativeContext), '角色与创作设定');
  validateCreativeReferences({ shots, creativeContext });
  return { ...current, shots, ...(change.creativeContext === undefined ? {} : { creativeContext }) };
}

export function planningResultValue(project: PlanningProject, section: PlanningSection): JsonValue {
  if (section === 'script') return { profile: project.profile, shots: project.shots.map(shot => ({ id: shot.id, title: shot.title, durationUs: shot.durationUs, narration: shot.narration, visualPrompt: shot.visualPrompt, soundPrompt: shot.soundPrompt ?? '' })) };
  const text = project[section], fields = project.manualPlanningFields?.[section];
  const context = section === 'style' ? project.creativeContext : undefined;
  return { text, ...(fields && formatPlanningDocument(section, fields) === text ? { fields } : {}), ...(context ? { creativeContext: { characterIds: context.characterIds, continuity: context.continuity, entities: context.entities.map(entity => ({ key: entity.key, kind: entity.kind, name: entity.name, description: entity.description })) } } : {}) };
}
