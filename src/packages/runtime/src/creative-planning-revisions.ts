import { z } from 'zod';
import { creativeNarrationSentences, shotSchema, type CreativeRevisionScope, type Shot } from '@video-quickly/contracts';
import { ModelResponseValidationError } from './model-responses.js';

const fieldSchemas = {
  title: shotSchema.shape.title.trim().min(1),
  narration: shotSchema.shape.narration,
  visualPrompt: shotSchema.shape.visualPrompt,
  soundPrompt: shotSchema.shape.soundPrompt.unwrap(),
  lineText: z.string().trim().min(1).max(10000),
};

export function creativeRevisionPatchSchema(scope: CreativeRevisionScope) {
  return z.strictObject(Object.fromEntries(scope.fields.map(field => [field, fieldSchemas[field]])));
}

export function creativeRevisionTarget(shots: readonly Shot[], scope: CreativeRevisionScope) {
  const index = shots.findIndex(shot => shot.id === scope.shotId);
  const shot = shots[index];
  if (!shot) throw new Error('所选镜头已被移除，请重新选择。');
  if (shot.locked) throw new Error('请先解锁所选镜头，再修改内容。');
  const line = scope.lineId === undefined ? undefined : shot.drama?.lines.find(item => item.id === scope.lineId);
  if (scope.lineId !== undefined && !line) throw new Error('所选台词已被移除，请重新选择。');
  const sentence = scope.sentenceIndex === undefined || shot.drama?.lines.length ? undefined : creativeNarrationSentences(shot.narration)[scope.sentenceIndex];
  if (scope.sentenceIndex !== undefined && !sentence) throw new Error('所选句子已变更，请重新选择。');
  if (scope.fields.includes('narration') && shot.drama?.lines.length) throw new Error('此镜头使用逐句台词，请选择要修改的一句。');
  const current = { title: shot.title, narration: shot.narration, visualPrompt: shot.visualPrompt, soundPrompt: shot.soundPrompt ?? '', lineText: line?.text ?? sentence?.text ?? '' };
  return { index, shot, line, sentence, current };
}

export function applyCreativeRevisionPatch(shots: Shot[], scope: CreativeRevisionScope, patch: Record<string, string>) {
  const { index, shot, line, sentence, current } = creativeRevisionTarget(shots, scope);
  const changes = scope.fields.flatMap(field => current[field] === patch[field] ? [] : [{ field, before: current[field], after: patch[field] }]);
  if (!changes.length) throw new ModelResponseValidationError([{ path: '$', message: '修改结果与当前内容相同。' }], '镜头修改');
  let next = shot;
  for (const { field, after } of changes) {
    if (field !== 'lineText') {
      next = { ...next, [field]: after };
    } else if (line && next.drama) {
      next = { ...next, drama: { ...next.drama, lines: next.drama.lines.map(item => item.id === line.id ? { ...item, text: after } : item) } };
    } else if (sentence) {
      const narration = `${shot.narration.slice(0, sentence.start)}${after}${shot.narration.slice(sentence.end)}`;
      if (!shotSchema.shape.narration.safeParse(narration).success) {
        throw new ModelResponseValidationError([{ path: 'lineText', message: '修改后整段旁白超过 10000 个字符。' }], '镜头修改');
      }
      next = { ...next, narration };
    }
  }
  return { shots: shots.map((item, at) => at === index ? next : item), changes };
}
