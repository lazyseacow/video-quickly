import { planningDocumentSchemas, type PlanningDocumentKind } from '@video-quickly/contracts';

export function planningFixtureFields(kind: PlanningDocumentKind, text: string) {
  const required = kind === 'brief' ? 'topic' : 'artStyle';
  return Object.fromEntries(Object.keys(planningDocumentSchemas[kind].shape).map(key => [key, key === required ? text : '']));
}

export function planningFixtureResponse(prompt: string, text: string): string {
  if (prompt.includes('分字段填写可直接用于后续制作的中文创意简报')) return JSON.stringify(planningFixtureFields('brief', text));
  if (prompt.includes('分字段填写可直接用于分镜与画面生成的中文风格正文')) return JSON.stringify(planningFixtureFields('style', text));
  return prompt.includes('最终回复只返回一个完整的 JSON 对象') ? JSON.stringify({ text }) : text;
}

export const storyboardOutlineRequest = (prompt: string) => prompt.includes('分镜生成阶段：全片大纲。');

export function storyboardFixtureResponse(prompt: string, text: string): string {
  const outline = storyboardOutlineRequest(prompt);
  const planned = /^本批镜头计划：(.+)$/m.exec(prompt);
  if (!outline && !planned) return text;
  let source: { shots?: { id?: string; title: string }[]; entities?: unknown[] };
  try { source = JSON.parse(text); } catch { return text; }
  if (!Array.isArray(source?.shots)) return text;
  if (outline) return JSON.stringify({
    outline: '按镜头计划展开叙事。',
    shots: source.shots.map(({ id, title }) => ({ id, title, beat: '交代当前叙事要点。' })),
    entities: source.entities ?? [],
  });
  if (!planned) return text;
  const slots = JSON.parse(planned[1]) as { number: number }[];
  return JSON.stringify({ shots: slots.map(({ number }) => ({ ...source.shots?.[number - 1], number })) });
}
