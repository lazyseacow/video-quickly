import { creativeContextSchema, projectSchema, shotSchema, type CreativeContext, type JsonValue, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { sameContent, type EditContent } from './project-edits';

export type PlanningSection = 'brief' | 'style' | 'script';
export type PlanningProject = Pick<ProjectDocument, 'brief' | 'style' | 'creativeContext' | 'shots'>;
export const planningLabels = { brief: '创意简报', style: '风格与角色', script: '旁白与分镜' };
export const planningShotFields = ['title', 'narration', 'visualPrompt', 'soundPrompt'] as const;
export type PlanningShot = Pick<Shot, 'id' | typeof planningShotFields[number]>;
export type PlanningChange = { kind: 'brief'; text: string } | { kind: 'style'; text: string; creativeContext: CreativeContext | null } | { kind: 'script'; shots: PlanningShot[] };
export interface PlanningControls { project: PlanningProject; onEdit(section: PlanningSection): void; disabledReason?: string }
export const isPlanningSection = (kind: string): kind is PlanningSection => ['brief', 'style', 'script'].includes(kind);

function changedField<T>(current: T, before: T, after: T, label: string): T {
  if (sameContent(before, after)) return current;
  if (!sameContent(current, before) && !sameContent(current, after)) throw new Error(`${label}已在其他位置修改，输入已保留，请关闭后重新核对。`);
  return after;
}

/** Apply only authored fields, preserving current media, timing, shot order and unrelated edits. */
export function applyPlanningEdit(current: EditContent, baseline: PlanningProject, change: PlanningChange): EditContent {
  if (change.kind === 'brief') return { ...current, brief: changedField(current.brief, baseline.brief, projectSchema.shape.brief.parse(change.text), '创意简报') };
  if (change.kind === 'style') return { ...current,
    style: changedField(current.style, baseline.style, projectSchema.shape.style.parse(change.text), '视觉风格'),
    creativeContext: changedField(current.creativeContext ?? null, baseline.creativeContext ?? null, creativeContextSchema.nullable().parse(change.creativeContext), '角色与创作设定'),
  };
  const previous = new Map(baseline.shots.map(shot => [shot.id, shot]));
  const live = new Map(current.shots.map(shot => [shot.id, shot]));
  const replacements = new Map<string, Shot>();
  for (const input of change.shots) {
    const before = previous.get(input.id), shot = live.get(input.id);
    if (!before) throw new Error('分镜不属于打开时的项目，请重新核对。');
    const fields = planningShotFields.filter(field => !sameContent(before[field], input[field]));
    if (!fields.length) continue;
    if (!shot) throw new Error(`镜头「${before.title}」已移除，输入已保留，请重新核对。`);
    if (shot.locked) throw new Error(`镜头「${shot.title}」已锁定，请先解锁再修改。`);
    const replacement = { ...shot };
    for (const field of fields) {
      const label = `镜头「${shot.title}」的内容`;
      if (field === 'soundPrompt') replacement.soundPrompt = changedField(shot.soundPrompt, before.soundPrompt, shotSchema.shape.soundPrompt.parse(input.soundPrompt), label);
      else replacement[field] = changedField(shot[field], before[field], shotSchema.shape[field].parse(input[field]), label);
    }
    replacements.set(shot.id, replacement);
  }
  return { ...current, shots: current.shots.map(shot => replacements.get(shot.id) ?? shot) };
}

export function planningResultValue(project: PlanningProject, section: PlanningSection): JsonValue {
  if (section === 'brief') return { text: project.brief };
  if (section === 'script') return { shots: project.shots.map(shot => ({ id: shot.id, title: shot.title, durationUs: shot.durationUs, narration: shot.narration, visualPrompt: shot.visualPrompt, soundPrompt: shot.soundPrompt ?? '' })) };
  const context = project.creativeContext;
  return { text: project.style, ...(context ? { creativeContext: { characterIds: context.characterIds, continuity: context.continuity, entities: context.entities.map(entity => ({ key: entity.key, kind: entity.kind, name: entity.name, description: entity.description })) } } : {}) };
}
