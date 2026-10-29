import { z } from 'zod';

const common = {
  heading: z.string().max(160).refine(value => value.trim().length > 0, '模板标题不能为空'),
  palette: z.enum(['sage', 'blue', 'amber']), motion: z.enum(['reveal', 'none']),
};
export const processSceneTemplateSchema = z.object({
  kind: z.literal('process'), ...common,
  steps: z.array(z.object({ title: z.string().max(80).refine(value => value.trim().length > 0, '步骤标题不能为空'), detail: z.string().max(300) })).min(2).max(6),
});
const comparisonSideSchema = z.object({ title: z.string().max(80).refine(value => value.trim().length > 0, '比较标题不能为空'), points: z.array(z.string().max(180).refine(value => value.trim().length > 0, '比较要点不能为空')).min(1).max(5) });
export const comparisonSceneTemplateSchema = z.object({ kind: z.literal('comparison'), ...common, left: comparisonSideSchema, right: comparisonSideSchema });
export const barChartSceneTemplateSchema = z.object({
  kind: z.literal('bar-chart'), ...common, unit: z.string().max(24),
  bars: z.array(z.object({ label: z.string().max(80).refine(value => value.trim().length > 0, '数据标签不能为空'), value: z.number().nonnegative() })).min(2).max(6),
});
export const sceneTemplateSchema = z.discriminatedUnion('kind', [processSceneTemplateSchema, comparisonSceneTemplateSchema, barChartSceneTemplateSchema]);
export type SceneTemplate = z.infer<typeof sceneTemplateSchema>;
export type SceneTemplateKind = SceneTemplate['kind'];

/** Every call owns its editable data; sample numbers and statements are explicitly labelled. */
export function createSceneTemplate(kind: SceneTemplateKind): SceneTemplate {
  const common = { palette: 'sage' as const, motion: 'reveal' as const };
  if (kind === 'process') return { kind, ...common, heading: '示例：一项研究如何推进', steps: [
    { title: '提出问题', detail: '先明确想要解释的现象。' },
    { title: '收集资料', detail: '记录证据与资料来源。' },
    { title: '验证观点', detail: '比较结果，检查可能的例外。' },
    { title: '解释结论', detail: '说明发现与仍待验证的部分。' },
  ] };
  if (kind === 'comparison') return { kind, ...common, heading: '示例：两种方案的比较', left: { title: '方案 A', points: ['步骤更少', '适合快速试做', '便于独立调整'] }, right: { title: '方案 B', points: ['分工更细', '适合多人协作', '便于逐项核对'] } };
  return { kind, ...common, heading: '示例：三组观测数据', unit: '次（示例数据）', bars: [{ label: '第一组', value: 24 }, { label: '第二组', value: 48 }, { label: '第三组', value: 36 }] };
}
