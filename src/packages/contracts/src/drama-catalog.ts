import { z } from 'zod';

export type DramaStylePreset = {
  id: string;
  name: string;
  category: 'live-action' | '2d' | '3d' | 'illustration';
  visualStyle: 'live-action' | 'animation' | 'mixed';
  description: string;
  prompt: string;
  skillIds: string[];
};

const characterSkills = ['builtin-drama-characters', 'builtin-drama-continuity', 'builtin-drama-storyboard'];

export const dramaStylePresets: DramaStylePreset[] = [
  {
    id: 'natural-live-action', name: '自然写实', category: 'live-action', visualStyle: 'live-action',
    description: '自然肤质、生活光线和克制的电影构图。',
    prompt: '真人写实摄影，保留自然肤质和真实材质。以柔和的环境光为主，色彩适度，避免过度磨皮。用人物的动作、眼神和空间关系表达剧情，同场镜头沿用光线方向、服装和道具状态。',
    skillIds: [...characterSkills, 'builtin-drama-dialogue'],
  },
  {
    id: 'urban-drama', name: '都市暖光', category: 'live-action', visualStyle: 'live-action',
    description: '温暖城市日常，适合关系、成长与生活喜剧。',
    prompt: '现代都市真人摄影，暖白色生活光、清晰的中间调，室内有可辨认的生活细节。用双人构图、反应镜头和自然停顿表现关系变化。人物服饰、住宅布局与日夜时间在连续镜头中保持一致。',
    skillIds: [...characterSkills, 'builtin-drama-dialogue'],
  },
  {
    id: 'period-film', name: '古装电影', category: 'live-action', visualStyle: 'live-action',
    description: '以服装、器物和空间建立可信的古装世界。',
    prompt: '古装真人电影摄影，布料、木器、石材具有清晰而克制的质感。根据故事设定统一服饰、器物、建筑与时代感。先交代地标和人物位置，再用近景表现手势、眼神及重要物件；保持场景轴线与兵器持握状态连续。',
    skillIds: [...characterSkills, 'builtin-drama-video-prompts'],
  },
  {
    id: 'suspense-cinema', name: '冷调悬疑', category: 'live-action', visualStyle: 'live-action',
    description: '用受控暗部、线索特写和环境声推进悬念。',
    prompt: '真人悬疑摄影，低饱和冷调，暗部保留可辨认的细节。以门窗、走廊和前景遮挡建立空间层次，重点线索用清楚的特写呈现。主光方向和线索位置跨镜一致，以环境声和人物反应制造紧张感，避免无意义的闪烁与频繁切镜。',
    skillIds: [...characterSkills, 'builtin-drama-editing'],
  },
  {
    id: 'cel-animation', name: '二维赛璐璐', category: '2d', visualStyle: 'animation',
    description: '整洁线稿、明确色块和可读的动作轮廓。',
    prompt: '二维动画，清晰的轮廓线和赛璐璐色块，角色色卡与比例固定。前景、主体和背景分层，主要动作有明确起势、变化和落点。表情变化服务人物动机，连续镜头保持发型、衣饰、光源与场景地标一致。',
    skillIds: [...characterSkills, 'builtin-drama-video-prompts'],
  },
  {
    id: 'ink-wash', name: '国风水墨', category: 'illustration', visualStyle: 'animation',
    description: '墨色层次、宣纸肌理与留白形成叙事空间。',
    prompt: '国风水墨动画，宣纸肌理、干湿墨层次，以淡青或朱砂作克制的强调色。浓墨前景、可读人物中景与淡墨远景构成空间，留白服务视线与行动。人物轮廓、衣饰、器物和山水地标跨镜稳定，运动轻缓但关键动作清楚。',
    skillIds: [...characterSkills, 'builtin-drama-video-prompts'],
  },
  {
    id: 'graphic-illustration', name: '平面绘本', category: 'illustration', visualStyle: 'animation',
    description: '简洁形状与有限色板，适合寓言和温暖故事。',
    prompt: '平面绘本插画，简洁几何形状、柔和纸纹和有限色板。通过轮廓、色块与物件位置识别人物和场景，画面层次清楚。每镜聚焦一个可读动作，保持角色比例、主色与关键道具一致，画面文字由独立字幕排版。',
    skillIds: [...characterSkills, 'builtin-drama-script'],
  },
  {
    id: 'paper-cut', name: '剪纸剧场', category: 'illustration', visualStyle: 'animation',
    description: '纸片分层、投影与舞台式调度。',
    prompt: '分层剪纸动画，纸张边缘、轻微纤维纹理和柔和投影可见。用前中后景纸片构建舞台空间，人物以稳定的剪影和局部细节识别。动作遵循纸片关节与位移的表达方式，镜头移动保持层间视差和角色朝向连续。',
    skillIds: [...characterSkills, 'builtin-drama-editing'],
  },
  {
    id: 'stylized-3d', name: '风格化三维', category: '3d', visualStyle: 'animation',
    description: '统一的角色比例、材质和清晰的空间光照。',
    prompt: '风格化三维动画，角色比例统一，材质简洁，皮肤、布料与环境具有一致的渲染质感。光照帮助识别体积和人物站位，动作有重量、接触和明确落点。跨镜沿用角色模型特征、场景布局、视线方向和道具状态。',
    skillIds: [...characterSkills, 'builtin-drama-video-prompts'],
  },
  {
    id: 'clay-animation', name: '黏土定格', category: '3d', visualStyle: 'animation',
    description: '手工塑形质感与有节拍的定格表演。',
    prompt: '黏土定格动画，保留手工塑形的微小纹理，角色轮廓和主色固定。微缩布景具有真实的接触阴影，动作按清楚的表演节拍推进。保持物件尺度、灯光位置、人物朝向和动作结果连续，避免材质或形体无理由变化。',
    skillIds: [...characterSkills, 'builtin-drama-editing'],
  },
];

export const dramaTopicSchema = z.object({
  id: z.string().min(1), title: z.string().trim().min(1).max(160),
  logline: z.string().trim().min(1).max(1000), description: z.string().max(20000).default(''),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).refine(tags => new Set(tags).size === tags.length, '选题标签不能重复。').default([]),
  revision: z.number().int().positive(), createdAt: z.string(), updatedAt: z.string(), archived: z.boolean().default(false),
});
export type DramaTopic = z.infer<typeof dramaTopicSchema>;

export const dramaTopicInputSchema = dramaTopicSchema.pick({ title: true, logline: true, description: true, tags: true }).extend({
  id: z.string().min(1).optional(), revision: z.number().int().positive().optional(),
});
export type DramaTopicInput = z.input<typeof dramaTopicInputSchema>;
