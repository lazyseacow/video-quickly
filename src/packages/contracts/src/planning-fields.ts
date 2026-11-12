import { z } from 'zod';

export const MAX_STORYBOARD_SHOTS = 100;

function planningField(title: string, limit: number, placeholder: string, rows = 1, required = false) {
  const text = z.string().trim().max(limit, `${title}最多 ${limit} 个字符。`);
  return (required ? text.min(1, `请填写${title}。`) : text).meta({ title, placeholder, rows });
}

export const planningDocumentSchemas = {
  brief: z.strictObject({
    topic: planningField('主题', 160, '这段视频要讲什么', 1, true),
    audience: planningField('目标受众', 240, '例如初次接触这个主题的观众'),
    coreMessage: planningField('核心信息', 10_000, '希望观众看完后记住什么', 3),
    narrativeOrder: planningField('叙事顺序', 5000, '从哪里开始，接着讲什么，怎么结尾', 3),
    targetDuration: planningField('预期成片时长', 80, '例如 45 秒至 1 分钟'),
    expression: planningField('表达要求', 5000, '语气、重点和需要保留的内容', 3),
  }),
  style: z.strictObject({
    artStyle: planningField('画风', 10_000, '例如低饱和手绘水彩', 2, true),
    palette: planningField('色彩', 2000, '主色和点缀色'),
    composition: planningField('构图', 3000, '主体位置、景别和留白', 2),
    lighting: planningField('光线', 3000, '光源、方向和明暗', 2),
    characterAppearance: planningField('角色外观', 5000, '人物外形、服装和显著特征', 3),
    sceneContinuity: planningField('场景连续性', 5000, '跨镜头要保持一致的布置或画面特征', 3),
  }),
};

export const manualPlanningFieldsSchema = z.strictObject({
  brief: planningDocumentSchemas.brief.optional(),
  style: planningDocumentSchemas.style.optional(),
});

export type ManualPlanningFields = z.infer<typeof manualPlanningFieldsSchema>;
export type PlanningDocumentKind = keyof typeof planningDocumentSchemas;

export function planningDocumentSections(kind: PlanningDocumentKind, values: Readonly<Record<string, string>>) {
  return Object.entries(planningDocumentSchemas[kind].shape).flatMap(([key, field]) => {
    const text = values[key]?.trim();
    return text ? [{ heading: field.meta()?.title ?? key, text }] : [];
  });
}

export function formatPlanningDocument(kind: PlanningDocumentKind, values: Readonly<Record<string, string>>): string {
  return planningDocumentSections(kind, values).map(({ heading, text }) => `${heading}\n${text}`).join('\n\n');
}
