import type { AssetRecord, CharacterProfile, JsonValue, ModelProfile, ProjectDocument, Shot, WorkflowNode } from './index.js';
import { formatFrameRate, VIDEO_FIT_MODE_LABELS, videoAspectRatioPreset, type VideoProfile } from './video-profile.js';
import { creativeEntityLabels, creativeReferenceAssetIds, hasCharacterAppearance, shotCreativePrompt } from './creative-context.js';
import { isVideoGenerationNode, nativeReferenceStep } from './production.js';
import { resolvePromptBindings } from './prompt-bindings.js';
import { seedance20DurationRange } from './model-parameters.js';

export function generationFramePrompt({ width, height, fitMode, frameRate }: VideoProfile, includeFrameRate = false): string {
  const ratio = videoAspectRatioPreset(width, height)?.label;
  const composition = {
    contain: '保持素材原比例，让主体和关键细节完整入画。',
    cover: '让画面铺满目标画幅，把主体和关键信息放在居中的裁切安全区。',
    blur: '保持前景和主体完整，构图预留可填充的背景区域。',
  }[fitMode];
  const global = includeFrameRate ? `分镜全局帧率为 ${formatFrameRate(frameRate)} fps，所有镜头沿用同一分辨率与帧率。` : '';
  return `按 ${width} × ${height} 像素${ratio ? `（${ratio}）` : ''}的目标画幅构图。${global}素材适配采用${VIDEO_FIT_MODE_LABELS[fitMode]}。${composition}`;
}

const outputSpecFields = [
  /^(?:分辨率[:：]\s*)?\d+\s*[×x]\s*\d+(?:\s*(?:px|像素))?$/i,
  /^(?:(?:比例|宽高比|画幅比例)[:：]\s*)?\d+\s*[:：]\s*\d+$/,
  /^(?:帧率[:：]\s*)?\d+(?:\.\d+)?\s*(?:fps|帧\/秒)$/i,
];
const fitModeText = new Set([...Object.values(VIDEO_FIT_MODE_LABELS), '等比完整显示', '裁切填满']);

export function stripVisualPromptOutputSpecs(prompt: string): string {
  // Only strip leading sentences or lines made up entirely of output settings.
  let remaining = prompt;
  while (remaining) {
    const text = remaining.trimStart();
    const prefix = /^([^。\r\n]+?)(?:。|\.(?=\s|$)|\r?\n|$)/.exec(text);
    if (!prefix) break;
    const fields = prefix[1].split(/[，,、；;]/).map(field => field.trim());
    if (!fields.every(field => outputSpecFields.some(pattern => pattern.test(field))
      || fitModeText.has(field.replace(/^(?:(?:画面|素材)?适配(?:方式)?[:：]|素材适配采用)\s*/, '')))) break;
    remaining = text.slice(prefix[0].length).trimStart();
  }
  return remaining;
}

export function characterReferencePrompt(selected: CharacterProfile[], referenceIds: readonly string[] = [...new Set(selected.flatMap(profile => profile.referenceAssetIds))]): string {
  if (!selected.length) return '';
  return ['角色一致性要求：', ...selected.map(profile => {
    const images = profile.referenceAssetIds.map(id => referenceIds.indexOf(id) + 1).filter(number => number > 0);
    return `角色「${profile.name}」：${profile.description || '保持同一角色身份。'}${images.length ? `\n参考图：${images.map(number => `图片 ${number}`).join('、')}。保留参考图中的人物外观、服装和辨识特征。` : ''}`;
  })].join('\n');
}

function creativeReferencePrompt(project: Pick<ProjectDocument, 'creativeContext'>, shot: Pick<Shot, 'creativeEntityKeys'>, referenceIds: readonly string[]): string {
  const selected = new Set(shot.creativeEntityKeys ?? []);
  const features = { character: '人物身份、发型与辨识特征', scene: '空间布局、建筑与光线', prop: '形状、颜色与材质' } as const;
  return (project.creativeContext?.entities ?? []).filter(entity => selected.has(entity.key)).flatMap(entity => {
    const numbers = (entity.referenceAssetIds ?? []).map(id => referenceIds.indexOf(id) + 1).filter(number => number > 0).map(number => `图片 ${number}`).join('、');
    if (!numbers) return [];
    const casting = entity.kind === 'character' ? '定妆图中的不同视角属于同一人物。按镜头要求描绘实际出镜人数。' : '';
    return `${creativeEntityLabels[entity.kind]}「${entity.name}」参考图：${numbers}。保持参考图中的${features[entity.kind]}，同时遵循文字设定。${casting}`;
  }).join('\n');
}

export function singleFrameVideoModel(model: ModelProfile | undefined, project: Pick<ProjectDocument, 'workflow'>): boolean {
  return model?.provider === 'openai-compatible' || model?.provider === 'seedance'
    && model.parameters.characterReferenceMode !== 'reference_image' && !project.workflow.production.referenceAudioAssetIds?.length;
}

export interface VideoReferenceImages {
  mode: 'text' | 'single' | 'multiple';
  referenceIds: string[];
  frame?: AssetRecord;
}

export function videoReferenceImages(project: ProjectDocument, node: WorkflowNode, model: ModelProfile, shot: Shot, characters: readonly CharacterProfile[], assets: readonly AssetRecord[]): VideoReferenceImages {
  if (node.config.operation === 'generate-native-video' && node.config.requiresShotFirstFrame === true) {
    const frame = assets.find(asset => asset.id === shot.assetId && asset.active && asset.kind === 'image' && (!asset.projectId || asset.projectId === project.id));
    if (!frame) throw new Error(`镜头「${shot.title}」缺少可用的首帧，请先运行「参考素材准备」并应用结果。`);
    const mode = model.provider === 'seedance' && project.workflow.production.referenceAudioAssetIds?.length ? 'multiple' : 'single';
    return { mode, referenceIds: [], frame };
  }
  const groups = [
    ...(shot.characterIds ?? []).map(id => characters.find(profile => profile.id === id)?.referenceAssetIds ?? []),
    ...(project.creativeContext?.entities ?? []).filter(entity => shot.creativeEntityKeys?.includes(entity.key)).map(entity => entity.referenceAssetIds ?? []),
  ].filter(group => group.length > 0);
  const referenceIds = [...new Set(groups.flat())];
  const supportsFrame = model.provider === 'openai-compatible' || model.provider === 'seedance'
    || (model.provider === 'comfyui' || model.provider === 'custom-http') && node.id === 'video' && Boolean(nativeReferenceStep(project.workflow));
  const frameId = supportsFrame && (project.workflow.production.referenceMode !== 'none' || node.config.operation === 'regenerate' && !referenceIds.length) ? shot.assetId : undefined;
  const frame = frameId ? assets.find(asset => asset.id === frameId && asset.active && asset.kind === 'image' && (!asset.projectId || asset.projectId === project.id)) : undefined;
  if (frameId && !frame) throw new Error(`镜头「${shot.title}」的参考画面不可用，请恢复或重新选择图片。`);
  const referenceAudio = model.provider === 'seedance' && Boolean(project.workflow.production.referenceAudioAssetIds?.length);
  if (referenceAudio && /seedance[-_.]?2[-_.]0(?:[-_.]|$)/i.test(model.model) && !frame && !referenceIds.length) {
    throw new Error(`镜头「${shot.title}」使用 Seedance 2.0 参考音频时需要一张参考图。请添加镜头画面、选择图片模型，或选用支持纯音频参考的 Seedance 2.5。`);
  }
  if (singleFrameVideoModel(model, project)) {
    if (frame) return { mode: 'single', referenceIds: [], frame };
    if (!groups.length) return { mode: 'text', referenceIds: [] };
    // A single attachment can cover several bindings if they explicitly share an image.
    const primary = groups[0].find(id => groups.every(group => group.includes(id)));
    if (!primary) throw new Error(`镜头「${shot.title}」绑定了多组参考图。当前视频连接每镜头接收一张图，请添加包含所需主体的镜头画面、选择图片模型，或切换到多图参考连接。`);
    return { mode: 'single', referenceIds: [primary] };
  }
  if (frame && !referenceAudio && !referenceIds.length) return { mode: 'single', referenceIds, frame };
  return { mode: referenceIds.length || frame ? 'multiple' : 'text', referenceIds, frame };
}

export function needsComposedSceneFrame(project: ProjectDocument, shot: Shot, characters: CharacterProfile[] = []): boolean {
  if (hasCharacterAppearance(project, shot)) return true;
  const references = new Set(creativeReferenceAssetIds(project, shot));
  for (const profile of characters) {
    if (shot.characterIds?.includes(profile.id)) for (const id of profile.referenceAssetIds) references.add(id);
  }
  return references.size > 1;
}

export function usesVideoSceneImage(project: ProjectDocument, node: WorkflowNode, model: ModelProfile | undefined, shot: Shot, characters: CharacterProfile[] = []): boolean {
  if (!isVideoGenerationNode(node)) return false;
  if (project.workflow.production.referenceMode !== 'none') return true;
  if (!singleFrameVideoModel(model, project)) return false;
  if (node.config.operation === 'regenerate' && shot.assetId) return true;
  return node.config.automaticCasting === true ? needsComposedSceneFrame(project, shot, characters) : hasCharacterAppearance(project, shot);
}

export function characterSceneFirstFrame(project: ProjectDocument, node: WorkflowNode, model: ModelProfile | undefined, shot: Shot, characters: CharacterProfile[] = []): boolean {
  return isVideoGenerationNode(node) && singleFrameVideoModel(model, project) && (creativeReferenceAssetIds(project, shot).length > 0
    || characters.some(profile => profile.referenceAssetIds.length && shot.characterIds?.includes(profile.id)));
}

function videoVisualPrompt(shot: Shot, model?: ModelProfile): string {
  const visual = stripVisualPromptOutputSpecs(shot.visualPrompt);
  if (!model || !['openai-compatible', 'seedance'].includes(model.provider)) return visual;
  const configured = model.provider === 'seedance' ? model.parameters.duration : model.parameters.seconds;
  const range = seedance20DurationRange(model.model);
  if (configured !== undefined || !range || shot.durationUs <= range.max * 1_000_000) return visual;

  const heading = '\n\n动作时间轴\n';
  const start = visual.indexOf(heading);
  if (start < 0) return visual;
  const offset = start + heading.length;
  const scale = range.max * 1_000_000 / shot.durationUs;
  const seconds = (value: string) => (Number(value) * scale).toFixed(9).replace(/\.?0+$/, '');
  // Retain the saved storyboard and fit its generated time labels to the requested clip.
  return visual.slice(0, offset) + visual.slice(offset).replace(/^(\d+(?:\.\d+)?)–(\d+(?:\.\d+)?) 秒 /gm,
    (_label, begin: string, end: string) => `${seconds(begin)}–${seconds(end)} 秒 `);
}

/** Builds the per-shot prompt for both offline preview and generation. */
export function buildMediaPrompt(project: ProjectDocument, node: WorkflowNode, shot: Shot, characters: CharacterProfile[] = [], model?: ModelProfile, hasSceneImage = false, upstream: Record<string, JsonValue> = {}, videoReferences?: VideoReferenceImages): string {
  const selected = (shot.characterIds ?? []).map(id => {
    const profile = characters.find(profile => profile.id === id);
    if (!profile) throw new Error('缺少镜头所选角色的快照。');
    return profile;
  });
  const edit = node.config.imageEdit;
  const sourceId = edit && typeof edit === 'object' && !Array.isArray(edit) && typeof edit.sourceAssetId === 'string' ? edit.sourceAssetId : undefined;
  const sceneFirstFrame = videoReferences ? videoReferences.mode === 'single' && Boolean(videoReferences.frame) : hasSceneImage && characterSceneFirstFrame(project, node, model, shot, characters);
  const references = videoReferences?.referenceIds ?? (sceneFirstFrame ? [] : [...new Set([...(sourceId ? [sourceId] : []), ...selected.flatMap(profile => profile.referenceAssetIds), ...creativeReferenceAssetIds(project, shot)])]);
  const multimodal = videoReferences ? videoReferences.mode === 'multiple' : Boolean(project.workflow.production?.referenceAudioAssetIds?.length) || references.length > 0 && model?.parameters.characterReferenceMode === 'reference_image';
  const video = isVideoGenerationNode(node);
  const prompt = [
    sourceId ? '图片 1 为待修改原图，保留未要求修改的部分。' : '',
    project.style,
    video ? videoVisualPrompt(shot, model) : shot.visualPrompt,
    shotCreativePrompt(project, shot),
    resolvePromptBindings(node, project, shot, upstream).prompt,
    characterReferencePrompt(selected, references),
    sceneFirstFrame ? '以镜头首帧中的人物形象和构图为准。' : creativeReferencePrompt(project, shot, references),
    ...(video ? [
      videoReferences && videoReferences.mode !== 'text' ? '全镜头保持参考人物的身份、五官比例、发型和关键辨识特征。动作与运镜按分镜推进。仅在明确要求时改变服装或造型。' : '',
      shot.narration.trim() ? `实际台词（只朗读以下正文）：${JSON.stringify(shot.narration)}` : '本镜头不需要人声。',
      `声音要求：${[node.config.soundPrompt, shot.soundPrompt].filter(Boolean).join('\n')}`,
      '画面不生成字幕或文字；台词、人声和环境音直接包含在视频音轨中。'] : [generationFramePrompt(project.profile)]),
  ].filter(Boolean).join('\n');
  const sceneIndex = videoReferences?.frame ? references.indexOf(videoReferences.frame.id) + 1 : 0;
  return prompt + (model?.provider === 'seedance' && multimodal && hasSceneImage
    ? `\n图片 ${sceneIndex || references.length + 1} ${node.config.requiresShotFirstFrame === true && node.config.operation === 'generate-native-video' ? '为本镜头的首帧，从该画面开始。' : '为当前场景构图参考。'}` : '');
}
