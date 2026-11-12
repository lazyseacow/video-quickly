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

type StoryboardFixtureShot = { id?: string; title: string; visualPrompt?: unknown; durationUs?: unknown; initialFrame?: unknown };

function structuredFixtureShot(shot: StoryboardFixtureShot) {
  if (!shot || 'initialFrame' in shot || typeof shot.visualPrompt !== 'string') return shot;
  const { visualPrompt, durationUs = 1_000_000, ...fields } = shot;
  return {
    ...fields, durationUs,
    initialFrame: visualPrompt || '固定机位拍摄当前场景。',
    characterPositions: '无人出镜。',
    actionTimeline: [{ startUs: 0, endUs: typeof durationUs === 'number' ? durationUs : 1_000_000, action: '镜头保持当前构图。' }],
  };
}

export function storyboardFixtureResponse(prompt: string, text: string): string {
  const outline = storyboardOutlineRequest(prompt);
  const planned = /^本批镜头计划：(.+)$/m.exec(prompt);
  const structured = prompt.includes('"initialFrame"') && prompt.includes('"actionTimeline"');
  if (!outline && !planned && !structured) return text;
  let source: { shots?: StoryboardFixtureShot[]; entities?: unknown[] };
  try { source = JSON.parse(text); } catch { return text; }
  if (!Array.isArray(source?.shots)) return text;
  if (outline) return JSON.stringify({
    outline: '按镜头计划展开叙事。',
    shots: source.shots.map(({ id, title }) => ({ id, title, beat: '交代当前叙事要点。' })),
    entities: source.entities ?? [],
  });
  const shots = structured ? source.shots.map(structuredFixtureShot) : source.shots;
  if (!planned) return JSON.stringify({ ...source, shots });
  const slots = JSON.parse(planned[1]) as { number: number }[];
  return JSON.stringify({ shots: slots.map(({ number }) => ({ ...shots[number - 1], number })) });
}
