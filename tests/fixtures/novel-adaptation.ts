import { storyboardFixtureResponse } from './planning-response';

export const novelSource = '雨点敲在旧渡船的铁顶上。林夏握紧出发前借来的铜钥匙，等船工抬头。';
export const directorDraft = '第一场　旧渡船　外　夜\n人物：林夏、船工\n林夏用袖口擦去铜钥匙上的水珠。\n林夏：我得回去。';
export const approvedDialogue = '林夏：我得回去还这把钥匙。';
export const approvedScreenplay = directorDraft.replace('林夏：我得回去。', approvedDialogue);
export const characterSkill = '让林夏的橙色雨衣袖口保持反光条。';

export const novelCharacter = {
  key: 'lin-xia', name: '林夏', description: '年轻渡口乘客，橙色雨衣和有反光条的袖口。',
  visualPrompt: '橙色雨衣，袖口银色反光条，右手握一把铜钥匙。',
};

export const novelShot = {
  title: '钥匙落入灯光', narration: '我得回去还这把钥匙。', visualPrompt: '近景，灯光照在林夏手中的铜钥匙上。',
  soundPrompt: '雨点敲打渡船铁顶', durationUs: 5_000_000, characterKeys: [], entityKeys: [novelCharacter.key],
};

export function novelFixtureResponse(prompt: string, schemaName?: string): string {
  if (schemaName === 'video_storyboard_outline' || schemaName === 'video_storyboard_batch') {
    return storyboardFixtureResponse(prompt, JSON.stringify({ shots: [novelShot] }));
  }
  if (schemaName === 'novel_character_assets') return JSON.stringify({ characters: [novelCharacter] });
  if (schemaName === 'drama_screenplay') return JSON.stringify({ text: directorDraft });
  throw new Error(`Unexpected adaptation fixture request: ${schemaName}`);
}
