import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assetSchema, DEFAULT_CAPTION_STYLE, DEFAULT_VIDEO_PROFILE, seriesTemplateSchema, skillGroupSchema, skillSchema, type CaptionStyle } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';

const referencePath = 'references/production-card.md';
const presets = [
  {
    key: 'live-action-drama',
    name: 'AI 短剧 · 竖屏真人',
    description: '9:16 真人短剧。用行动开场、短对白推进冲突，以反应镜头和集尾悬念收束。',
    source: 'https://github.com/eternityspring/shuohao-skills',
    style: '写实真人摄影，自然肤质，克制的电影光影和浅景深。纵向构图保留眼神、手部动作与底部字幕区。固定人物的脸型、发型、服装和随身道具，同一场的主光方向与人物站位连续。',
    caption: { fontWeight: 700, textColor: '#FFFFFF', backgroundColor: '#17171C', backgroundOpacity: .76 },
    directions: [
      '先明确本集主角的目标、阻碍及行动代价。开场用一个可见的动作或线索建立问题，中段让人物的选择改变局势，结尾用新线索或未完成的行动衔接下一集。',
      '将场景拆成空间交代、动作和反应。相邻镜头延续视线、出入画方向和关键道具状态。一镜只安排一个主要动作，停顿与反应也分配时长。',
      '把可直接朗读的台词或旁白写入 narration，声音方向写入 soundPrompt。对白镜头写清主说话者、情绪和停顿。静默反应镜头可将 narration 留空。',
    ],
    card: [
      '# 真人短剧制作卡',
      '- 分集素材：本集目标 → 阻碍 → 行动与代价 → 局势变化 → 集尾悬念。',
      '- 角色卡记录识别特征、当场服装、说话节奏、此时知道什么、随身物品和情绪变化。',
      '- 镜头卡记录景别、机位、开场动作、反应、切出状态及同期声。可用素材库的「内置参考 · 巴黎石板巷」研究纵深、墙面反光与入口位置。',
      '- 示例镜头「门缝」约 4 秒。竖屏侧近景，手把钥匙送入锁孔，门内灯光突然熄灭，切到手停住的瞬间。留空台词，收录金属轻响与骤停的室内声。',
    ],
    image: { file: 'paris-alley.jpg', name: '巴黎石板巷', credit: 'Charles Marville，《Impasse Briare》，馆藏 2005.100.362' },
  },
  {
    key: 'motion-comic',
    name: 'AI 漫剧 · 动态条漫',
    description: '9:16 动态漫画。用清晰轮廓、分层构图和逐镜动作保留条漫的节奏。',
    source: 'https://github.com/freestylefly/canghe-skills/tree/master/skills/canghe-manga-drama',
    style: '二维漫画线稿和赛璐璐上色，清晰轮廓、整洁色块，环境用次要色降低对比。每镜采用单幅竖屏构图，前景、人物与背景层次分明。连续镜头保持人物色卡、服饰与场景轴线一致。',
    caption: { fontWeight: 700, textColor: '#FFF3DC', backgroundColor: '#25233E', backgroundOpacity: .84 },
    directions: [
      '按出场、行动、反应和后果拆出阅读节拍。先给出人物、场景、道具的稳定识别特征，再为各镜头选择实际出镜的设定。',
      '每镜写清可生成的单幅首帧和一个主运动，例如人物回头、推镜、前后景视差。用关键动作、目光变化或遮挡承接切点，动作完成后的姿态要能接到下一镜。',
      '保持画面内的文本区域简洁，字幕由应用独立排版。把对白和旁白留给 narration，把环境声、动作声与口吻留给 soundPrompt。',
    ],
    card: [
      '# 动态条漫制作卡',
      '- 人物设定卡包含轮廓、发型、主色、服装细节和识别道具。同一人物的参考图可保留正面、侧面与表情变化。',
      '- 逐镜素材记录首帧构图、主体动作、前景／主体／背景分层、切出状态。可用素材库的「内置参考 · 大桥骤雨」研究斜线动势与远近色块。',
      '- 示例首帧「雨中来客」为中景，橘色外套人物在画面右侧停步，深蓝雨棚在前景遮挡上沿，雨巷消失在远处。视频仅推进少许，人物回头，前景雨丝掠过。',
    ],
    image: { file: 'rain-on-the-bridge.jpg', name: '大桥骤雨', credit: '歌川广重，《大桥安宅骤雨》，馆藏 JP644' },
  },
  {
    key: 'ink-wash-drama',
    name: 'AI 漫剧 · 国风水墨',
    description: '9:16 水墨漫剧。用墨色层次、留白、环境声和缓动镜头讲述古风故事。',
    source: 'https://github.com/zenstory-ai/drama-skills',
    style: '宣纸肌理、干湿墨分层，以淡青或朱砂作为单一强调色。前景用浓墨，中景交代人物，远景以淡墨和留白分隔。服装、兵器、地貌和天色沿用同一组视觉设定。',
    caption: { fontId: 'serif', textColor: '#FFF1D5', backgroundColor: '#20342F', backgroundOpacity: .82 },
    directions: [
      '根据创意简报确定时代感、人物动机和空间地标。关键场次先让观众认清人物与地标的位置，再以近景交代表情、手势或道具变化。',
      '用首帧固定人物轮廓与近、中、远三层空间。每镜给一个可读动作，允许薄雾、衣摆和纸面光影缓慢变化。动作镜头写清出手、受力与结果，跨镜核对方向和道具状态。',
      '对白和解说采用与人物身份相符的语言。用风声、水声、脚步或器物声音支撑停顿。按当前任务的分镜字段组织结果。',
    ],
    card: [
      '# 水墨漫剧制作卡',
      '- 场景卡记录地标、行进方向、天色、主色和可听环境。同一地点的变体沿用地标关系。',
      '- 图片提示词从纸纹、墨色层次、留白位置和角色轮廓入手。可用素材库的「内置参考 · 云山隐居图」研究山径、墨色和云气的层次。',
      '- 示例镜头「山径信使」以浓墨松枝作前景、信使与石阶作中景、云山作背景。信使在石阶转角停住，右手扶住信筒。镜头缓慢推近，配松风与一声踩石。',
    ],
    image: { file: 'mountains-and-clouds.jpg', name: '云山隐居图', credit: '传龚贤，《云山隐居图》，馆藏 1983.609' },
  },
] satisfies Array<{
  key: string; name: string; description: string; source: string; style: string; caption: Partial<CaptionStyle>;
  directions: string[]; card: string[]; image: { file: string; name: string; credit: string };
}>;

export function seedBuiltInDramaTemplates(directory: string, store: DocumentStore): void {
  const marker = 'builtin-drama-templates';
  if (store.get('metadata', marker)) return;
  store.database.transaction(() => {
    if (store.get('metadata', marker)) return;
    const time = new Date().toISOString();
    const profile = { ...DEFAULT_VIDEO_PROFILE, width: 1080, height: 1920, frameRate: { numerator: 60, denominator: 1 } };
    const assetDirectory = join(directory, 'projects', 'library', 'assets');
    mkdirSync(assetDirectory, { recursive: true });
    const skillIds: string[] = [];

    for (const preset of presets) {
      const skillId = `builtin-skill-${preset.key}`;
      const instructions = [
        ...preset.directions,
        `按需使用 ${referencePath} 的制作卡与原创示例。沿用用户给定的剧情、项目画幅与参考素材，按当前步骤要求返回结果。`,
      ].join('\n');
      const card = preset.card.join('\n\n');
      const contentHash = createHash('sha256').update(instructions).update(card).digest('hex');
      const referenceDirectory = join(directory, 'skills', skillId, 'references');
      mkdirSync(referenceDirectory, { recursive: true });
      writeFileSync(join(referenceDirectory, 'production-card.md'), card, 'utf8');
      const skill = skillSchema.parse({
        id: skillId, name: `vq-${preset.key}`, description: preset.description, source: preset.source,
        instructions, resources: [referencePath], enabled: true, autoDiscover: false, contentHash, version: contentHash.slice(0, 12), importedAt: time,
      });
      store.put('skill', skill.id, skill);
      skillIds.push(skill.id);

      const template = seriesTemplateSchema.parse({
        id: `builtin-series-${preset.key}`, name: preset.name, description: preset.description, revision: 1, createdAt: time, updatedAt: time,
        settings: { style: preset.style, captionStyle: { ...DEFAULT_CAPTION_STYLE, ...preset.caption }, scenePreset: null },
        creationDefaults: { profile, skillIds: [skillId] },
      });
      store.put('series-template', template.id, template);

      const bytes = readFileSync(new URL(`./builtin-drama-media/${preset.image.file}`, import.meta.url));
      const assetId = `builtin-scene-${preset.key}`;
      const path = join(assetDirectory, `${assetId}.jpg`);
      writeFileSync(path, bytes);
      const asset = assetSchema.parse({
        id: assetId, name: `内置参考 · ${preset.image.name}`, kind: 'image', path, mimeType: 'image/jpeg', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), version: 1, createdAt: time,
        provenance: `${preset.image.credit} · 大都会艺术博物馆 Open Access（CC0）`,
      });
      store.put('asset', asset.id, asset);
    }

    const group = skillGroupSchema.parse({ id: 'builtin-drama-skills', name: '内置短剧与漫剧', source: '随应用提供', skillIds, createdAt: time, updatedAt: time });
    store.put('skill-group', group.id, group);
    store.put('metadata', marker, { version: 1 });
  }).immediate();
}
