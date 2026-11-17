import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dramaTopicSchema, skillGroupSchema, skillSchema, type DramaTopicInput, type SkillGroup } from '@video-quickly/contracts';
import type { DocumentStore } from './database.js';

export const builtInDramaStudioVersion = 1;
const source = 'Video Quickly 内置原创';
const resourcePath = 'references/production-guide-v1.md';

export const builtInDramaTopics: Array<DramaTopicInput & { id: string }> = [
  {
    id: 'builtin-topic-last-stop', title: '末班车没有终点', tags: ['悬疑', '时间循环', '城市'],
    logline: '公交司机连续三晚在末班车上接到同一位乘客，而对方每次都在尚未抵达的车站留下失物。',
    description: '主角想完成退休前的最后一班车，却发现车票上的时间指向一场被遗漏的事故。围绕司机、失物招领员和乘客展开；每次找到失物都改变他对旧事的判断。开场从一张还温热的车票切入，让悬念由可见线索与人物选择推进。',
  },
  {
    id: 'builtin-topic-watch-shop', title: '旧钟表铺的周末', tags: ['亲情', '生活', '成长'],
    logline: '准备关闭祖父钟表铺的年轻人，接到一只没有指针的旧表和一份必须亲手送达的维修单。',
    description: '每位来取表的客人，都知道祖父的一段不同往事。主角在清理铺子的过程中重新认识家人，并决定哪些承诺值得留下。以钟声、修理动作和短对白表现关系，适合少量固定场景与反复出现的道具。',
  },
  {
    id: 'builtin-topic-last-order', title: '合伙人的最后一单', tags: ['职场', '搭档', '反转'],
    logline: '即将散伙的两位小公司合伙人，为支付员工尾款接下最后一单，客户却要求他们撤回自己最成功的作品。',
    description: '一位重视承诺，一位相信结果。两人必须查清旧项目的代价，在客户、员工和彼此之间作出选择。冲突落在可执行的决定与证据上，反转由先前信息重新解释产生，适合现代办公室与街边工作室场景。',
  },
  {
    id: 'builtin-topic-rain-gate', title: '雨夜山门', tags: ['武侠', '师徒', '身份谜局'],
    logline: '守山门的年轻弟子收到师父亲笔求救信，信中却命他绝不能让当夜归来的师父进门。',
    description: '故事围绕山门、旧剑和约定展开。主角需要辨认真伪，也要面对自己一直回避的师门旧事。动作服务试探与选择，先明确人物站位、武器与地形，再安排交锋；每次判断都必须承担具体后果。',
  },
  {
    id: 'builtin-topic-swapped-doors', title: '门牌交换以后', tags: ['奇幻', '邻里', '喜剧'],
    logline: '小区维修员换错两块门牌后，住户开始收到对方未来一天的快递。',
    description: '一个习惯独来独往的住户与一位热心邻居，需要合作处理越来越离奇的包裹。以日常小物件带出误会和互助，逐步明确门牌变化的规则，保留轻喜剧节奏和温暖的人物关系。',
  },
  {
    id: 'builtin-topic-seventh-rule', title: '夜班第七条', tags: ['规则悬疑', '封闭空间', '搭档'],
    logline: '档案馆新夜班员发现值班手册只有六条规则，而每晚交接时都会有人提醒他千万遵守第七条。',
    description: '主角与一名即将调走的老员工共同整理一批无人认领的档案。规则必须能被观众观察、验证和重新理解，紧张感来自执行规则的代价；不要用任意新增规则替代因果。适合走廊、库房和值班室等固定空间。',
  },
  {
    id: 'builtin-topic-sea-list', title: '海风送来的清单', tags: ['治愈', '友情', '小镇'],
    logline: '返乡青年在海边拾到一张愿望清单，完成第一项后，发现整个小镇都在替同一个陌生人守约。',
    description: '从修好长椅、找回旧照片等具体小事进入人物关系。主角逐渐从被动帮忙变成主动承担，故事的情绪回报来自行动改变他人的生活。适合自然写实、平面绘本或黏土画风。',
  },
  {
    id: 'builtin-topic-bridge', title: '桥通那一天', tags: ['现实', '乡村', '群像'],
    logline: '年轻测绘员回乡验收一座新桥，发现最盼桥通的老人却坚持在通车前拆掉最后一段护栏。',
    description: '围绕旧渡口的记忆、现实需求与一项未完成的承诺组织矛盾。先让不同人物说清各自的实际困难，再通过调查、协商和劳动推进结果。群像人物数量可按制作预算缩减，保留清楚的主角行动线。',
  },
  {
    id: 'builtin-topic-running-lane', title: '逆风跑道', tags: ['青春', '竞技', '成长'],
    logline: '失去主力位置的短跑少年，被安排给从未参赛的同学做陪练，才发现对方报名的是自己最害怕的项目。',
    description: '以陪练过程中的技术差异、误会和共同训练建立关系。比赛结果来自已呈现的训练与选择，情绪转折落在人物如何面对失误和他人期待。动作镜头先明确跑道、方向和起终点。',
  },
  {
    id: 'builtin-topic-deep-space', title: '深空值班室', tags: ['科幻', '搭档', '记忆'],
    logline: '远航飞船只剩一人值班，船载系统却每天准时为第二名船员准备早餐。',
    description: '主角想查明第二名船员的身份，同时必须保证航行安全。以日志、餐具和舱内变化逐步揭示信息，技术规则前后一致；系统与人的关系通过具体协作呈现，避免仅靠解释性对白交代世界观。',
  },
  {
    id: 'builtin-topic-lantern-office', title: '灯会失物所', tags: ['古装', '轻喜剧', '搭档'],
    logline: '临时搭档的女捕快与灯笼匠，在灯会失物所收到一张写着明日失物的清单。',
    description: '两人边找失物边拆穿各自的偏见，每件物品串起一段城市小故事。让线索、误会和善意都可从前文找到依据，服装与器物设定保持统一，适合古装真人或剪纸剧场。',
  },
  {
    id: 'builtin-topic-moving-photo', title: '搬家前的合照', tags: ['家庭', '代际', '生活'],
    logline: '一家人在搬家前重拍旧合照，照片里一直空着的位置，却让三代人争论起同一段往事。',
    description: '以一顿打包中的晚饭为主要场景，让人物对照片、家具和旧物的不同记忆推动冲突。角色通过行动而非长篇自述表达在意，最后的选择回应开场留下的位置。适合有限演员和单一室内场景。',
  },
  {
    id: 'builtin-topic-temporary-partner', title: '临时搭档协议', tags: ['都市', '情感', '合作成长'],
    logline: '面临闭店的花艺师与隔壁修车师傅约定互相帮忙一个月，第一条协议却是不能替对方作决定。',
    description: '两个不同节奏的人因经营难题开始合作，从误判对方到尊重边界。感情由共同解决具体问题逐步建立，每集围绕一个真实的小目标展开。适合都市暖光、生活写实或风格化三维。',
  },
  {
    id: 'builtin-topic-archive-tomorrow', title: '明日收件箱', tags: ['科幻', '职场', '选择'],
    logline: '普通资料员发现收件箱能收到次日的退件通知，但每次改动都会让一位同事失去原本的机会。',
    description: '主角从只想避免工作失误，到主动承担选择的代价。用文件、签字和交接动作建立规则及结果，明确哪些未来信息可信、哪些仍可改变。悬念来自利益冲突和人物判断，适合少量办公室场景。',
  },
];

export const builtInDramaSkills = [
  {
    key: 'script', name: '短剧编剧', description: '将创意组织为人物目标、场次、对白和可续写的分集剧本。',
    instructions: [
      '根据用户的题材、受众、集数和制作条件开发故事，先明确主角目标、阻碍和行动代价。',
      '分清故事设定、分集大纲、剧本正文和镜头分镜，各层只写当前任务要求的内容。',
      '让人物的选择改变局势；新线索、情绪回报和集尾悬念须有前文依据。按实际内容安排节奏，不机械套用固定字数或反转次数。',
    ],
    guide: ['# 短剧编剧制作卡', '每场写清地点与时间、出场人物、人物想达成什么、发生的行动以及结果。对白推动关系或行动，静默、犹豫和反应也可以构成戏。', '原创练习：钟表铺即将关门，客人送来没有指针的表。主角先想拒收，却发现维修单上是祖父的字迹。用可见动作建立目标变化，不提前解释全部往事。'],
  },
  {
    key: 'adaptation', name: '小说改编', description: '从已有小说或剧本提取主线，改编为适合制作的分集内容。',
    instructions: [
      '阅读用户提供的原文，区分原文事实、合理推断与改编新增，保留角色动机、关键因果和用户锁定的设定。',
      '先提取主线、人物关系、重要事件与可视化场景，再按当前作品的集数和时长重组；不要直接把章节数当作集数。',
      '将内心叙述转化为可见行动或必要旁白，合并场景与角色时写清取舍。原文未包含的事实不得冒称原著设定。',
    ],
    guide: ['# 改编制作卡', '记录来源段落、保留的事件、调整的顺序和新增连接。长材料按段读取并累计人物与事件摘要，不用一次截断代替全文改编。', '原创练习：原文用三段回忆解释主角为什么不敢开门。可以用手停在门把上、旧伤痕与门外熟悉的敲门节奏表现，但须保留导致恐惧的核心事件。'],
  },
  {
    key: 'characters', name: '人物与视觉设定', description: '整理角色识别特征、形象变体、场景与道具参考。',
    instructions: [
      '为实际出镜人物记录稳定识别特征、人物动机与关系，再为服装、妆造或剧情状态建立明确变体。',
      '参考图和文字设定分开处理：只引用当前任务提供的有效资产与角色身份，不编造素材 ID 或不存在的参考图。',
      '为常用场景固定地标、布局、主光方向和关键道具。每镜只关联实际出镜的角色、场景、道具与形象。',
    ],
    guide: ['# 人物与视觉设定制作卡', '稳定信息包括脸型、发型、轮廓、主色和常用道具；可变信息包括本场服装、伤痕、湿润程度和情绪。人物身份与单次表演不要混写成同一种约束。', '原创练习：夜班员的固定特征是短发与圆框眼镜；雨夜形象另记深色雨衣、右袖潮湿。换镜头仍沿用该形象，剧情明确换装后再切换。'],
  },
  {
    key: 'storyboard', name: '导演分镜', description: '将场次拆成可生成、可剪辑并保持空间关系的镜头。',
    instructions: [
      '根据场次目标拆分镜头，写清初始画面、人物站位、主要动作、切出状态及声音。时长须容纳台词、动作和必要反应。',
      '先建立空间和视线关系，再使用近景、特写和反应镜头；每镜主要动作与相机运动应清楚可执行。',
      '遵循当前步骤要求的字段和身份白名单。保留锁定镜头与人工绑定，引用实际资产，禁止用解释性文字替代结构化结果。',
    ],
    guide: ['# 导演分镜制作卡', '核对人物入出画方向、视线、持物手、道具位置、动作起终点。需要跨镜变化时给出能看见的过程或明确省略依据。', '原创练习：钥匙进入锁孔、灯熄灭、手停住，可以分为手部动作与人物反应两镜。下一镜应延续钥匙仍在锁孔、人物尚未开门的状态。'],
  },
  {
    key: 'dialogue', name: '对白与声音表演', description: '按说话人组织对白、旁白、情绪与停顿。',
    instructions: [
      '区分人物对白、画外旁白、内心声音和环境声，逐句标明真实说话者；只使用任务提供的角色与音色身份。',
      '台词符合人物当时知道的信息、关系与目标，用动作和反应补充含义，避免所有人物使用相同口吻。',
      '安排能容纳台词的镜头时长、停顿和接话关系。声音描述是表演要求，不能声称仅凭描述就已完成音色锁定或口型同步。',
    ],
    guide: ['# 对白与声音制作卡', '每句记录说话者、文本、表达意图、情绪变化及必要停顿。两人争执时先确认谁先说、谁在听；无台词镜头可保留呼吸、脚步或器物声。', '原创练习：“你还修吗？”可以是催促、试探或告别。选择一种与人物目标一致的意图，并用放下维修单或收回手等动作支持。'],
  },
  {
    key: 'continuity', name: '连戏与逻辑检查', description: '检查人物、空间、物件、事件及跨集信息的一致性。',
    instructions: [
      '检查当前文本、镜头与已提供的前集信息，逐项核对人物身份、知识状态、服装、道具、时间和空间关系。',
      '每个问题给出具体位置、已有证据、影响与最小修复建议。区分可验证矛盾、待确认信息和创作偏好，不编造评分或保证模型效果。',
      '修改只覆盖用户要求和当前任务允许的字段。保留无关镜头、已锁定内容与有效资产，不为修复一处问题重写全片。',
    ],
    guide: ['# 连戏检查制作卡', '用进入状态、发生变化、离开状态核对相邻镜头。跨集记录已经发生的事件、未解问题和角色目前掌握的信息；伏笔未回收不自动等于漏洞。', '原创练习：前镜角色用右手持信封，后镜无交接却改为左手，应定位两镜并给出保持右手或补充换手动作的建议。'],
  },
  {
    key: 'video-prompts', name: '镜头生成提示词', description: '把分镜与实际参考素材整理为当前模型可执行的生成要求。',
    instructions: [
      '沿用已确认的分镜、画风与实际参考素材，明确起始构图、主要运动、结束状态、相机运动和声音要求。',
      '先确认当前模型支持的输入和参数，区分首帧、角色图、场景图、参考音频与参考视频；不把未提供或不支持的输入写成已绑定。',
      '参考图负责固定外观与构图，运动提示聚焦实际变化。保留镜头身份与素材引用，避免互相矛盾的动作和同时发生的过多相机运动。',
    ],
    guide: ['# 镜头生成制作卡', '提交前核对参考素材顺序、每张图片的用途、镜头时长和声音需求。缺少参考时说明缺口，让真实工作流决定补图或采用可用模式。', '原创练习：角色站在门外，右手扶信筒。相机缓推，角色听见屋内钟声后抬眼。结束仍在门外，信筒未打开；无需同时要求绕拍、俯冲和拉远。'],
  },
  {
    key: 'editing', name: '剧情剪辑', description: '根据行动、反应与声音安排剪切点和成片节奏。',
    instructions: [
      '读取已有真实素材、镜头顺序与时长，根据人物行动和信息揭示安排入出点。优先复用可用片段，保留锁定镜头和用户剪辑。',
      '核对相邻镜头动作、视线和声音衔接；对白、原声、旁白与音乐分别处理，避免重复发声或音乐遮蔽台词。',
      '只调用当前工具提供的剪辑能力。缺少素材时报告缺口，不能用时间轴描述冒称已生成、已混音或已导出。',
    ],
    guide: ['# 剧情剪辑制作卡', '在关键行动前建立期待，在反应后给出理解时间；切点服务剧情，不机械追求快切。字幕须对应最终台词与实际时间，交付前听看完整声画。', '原创练习：主角看见维修单签名后，可以保留短暂反应，再切到旧表。若先切物件再给反应，检查信息揭示是否仍然清楚。'],
  },
] satisfies Array<{ key: string; name: string; description: string; instructions: string[]; guide: string[] }>;

export function seedBuiltInDramaStudio(directory: string, store: DocumentStore): void {
  const marker = 'builtin-drama-studio';
  if ((store.get<{ version: number }>('metadata', marker)?.version ?? 0) >= builtInDramaStudioVersion) return;
  store.database.transaction(() => {
    if ((store.get<{ version: number }>('metadata', marker)?.version ?? 0) >= builtInDramaStudioVersion) return;
    const time = new Date().toISOString();
    for (const topic of builtInDramaTopics) {
      if (store.get('drama-topic', topic.id)) continue;
      const value = dramaTopicSchema.parse({ ...topic, revision: 1, createdAt: time, updatedAt: time });
      store.put('drama-topic', value.id, value);
    }
    const allSkillIds: string[] = [], addedSkillIds: string[] = [];
    for (const definition of builtInDramaSkills) {
      const id = `builtin-drama-${definition.key}`;
      allSkillIds.push(id);
      if (store.get('skill', id)) continue;
      const referenceDirectory = join(directory, 'skills', id, 'references');
      mkdirSync(referenceDirectory, { recursive: true });
      const guidePath = join(directory, 'skills', id, resourcePath);
      try { writeFileSync(guidePath, definition.guide.join('\n\n'), { encoding: 'utf8', flag: 'wx' }); }
      catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error; }
      const instructions = [...definition.instructions, `按需使用 ${resourcePath} 的制作卡和原创示例，遵循当前步骤的输出契约与用户要求。`].join('\n');
      const contentHash = createHash('sha256').update(instructions).update(readFileSync(guidePath)).digest('hex');
      const skill = skillSchema.parse({ id, name: `vq-drama-${definition.key}`, description: `${definition.name}：${definition.description}`, source,
        instructions, resources: [resourcePath], enabled: true, autoDiscover: false, contentHash, version: contentHash.slice(0, 12), importedAt: time });
      store.put('skill', id, skill); addedSkillIds.push(id);
    }
    const groupId = 'builtin-drama-studio-skills', previous = store.get<SkillGroup>('skill-group', groupId);
    if (!previous || addedSkillIds.some(id => !previous.skillIds.includes(id))) {
      const group = skillGroupSchema.parse({ ...previous, id: groupId, name: previous?.name ?? '短剧创作技能', source: previous?.source ?? source,
        skillIds: previous ? [...new Set([...previous.skillIds, ...addedSkillIds])] : allSkillIds, createdAt: previous?.createdAt ?? time, updatedAt: time });
      store.put('skill-group', group.id, group);
    }
    store.put('metadata', marker, { version: builtInDramaStudioVersion });
  }).immediate();
}
