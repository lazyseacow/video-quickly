import { expect, it } from 'vitest';
import { resolveStudioIntent } from '../src/renderer/lib/studio-intent';

it('routes explicit creation requests and preserves their supplied material', () => {
  expect(resolveStudioIntent('  请帮我改编小说：第一章 夜雨\n她把钟拨慢了十分钟。  '))
    .toEqual({ flow: 'novel', content: '第一章 夜雨\n她把钟拨慢了十分钟。' });
  expect(resolveStudioIntent('把这段小说改编成短剧\n有人在窗外敲了两下。'))
    .toEqual({ flow: 'novel', content: '有人在窗外敲了两下。' });
  expect(resolveStudioIntent('上传剧本：第一场 客厅\n【夜】钟停在十点。'))
    .toEqual({ flow: 'upload', content: '第一场 客厅\n【夜】钟停在十点。' });
  expect(resolveStudioIntent('我想请你帮我写一个短剧，故事发生在深夜的便利店。'))
    .toEqual({ flow: 'write', content: '故事发生在深夜的便利店。' });
});

it('keeps bare commands available for a follow-up and preserves planning requirements', () => {
  expect(resolveStudioIntent('我想改编小说')).toEqual({ flow: 'novel', content: '' });
  expect(resolveStudioIntent('导入已有剧本。')).toEqual({ flow: 'upload', content: '' });
  expect(resolveStudioIntent('帮我生成分镜')).toEqual({ flow: 'planning', content: '' });
  expect(resolveStudioIntent('只提取风格')).toEqual({ flow: 'planning', content: '只提取风格' });
  const reference = '请根据这张参考图设计分镜';
  expect(resolveStudioIntent(reference)).toEqual({ flow: 'planning', content: reference });
  const goal = '请帮我生成一份分镜：雨夜的末班车，3 镜，每镜 5 秒，不要旁白。';
  expect(resolveStudioIntent(goal)).toEqual({ flow: 'planning', content: goal });
});

it('leaves pasted passages and ambiguous or canceled requests unresolved', () => {
  for (const text of [
    '',
    '她回头说：“帮我生成分镜。”',
    '第一章 想写一部剧的编剧\n我把小说放回了书架。',
    '我不想改编小说',
    '请不要生成分镜',
    '怎么上传剧本？',
    '改编小说还是写剧本？',
    '我想改编小说，还是先生成分镜？',
    '帮我生成分镜，算了。',
  ]) expect(resolveStudioIntent(text), text).toBeUndefined();

  const passage = '他放下书包，说先生成分镜，再写剧本。';
  expect(resolveStudioIntent(`改编小说：${passage}`)).toEqual({ flow: 'novel', content: passage });
});
