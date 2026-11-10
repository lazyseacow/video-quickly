import { formatFrameRate, VIDEO_FIT_MODE_LABELS, videoAspectRatioPreset, type CharacterProfile, type JsonValue, type ModelProfile, type ProjectDocument, type Shot, type VideoProfile, type WorkflowNode } from './index.js';
import { creativeEntityLabels, creativeReferenceAssetIds, hasCharacterAppearance, shotCreativePrompt } from './creative-context.js';
import { isVideoGenerationNode } from './production.js';
import { resolvePromptBindings } from './prompt-bindings.js';

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
  return (project.creativeContext?.entities ?? []).filter(entity => selected.has(entity.key) && entity.referenceAssetIds?.length).map(entity => {
    const numbers = (entity.referenceAssetIds ?? []).map(id => `图片 ${referenceIds.indexOf(id) + 1}`).join('、');
    const casting = entity.kind === 'character' ? '定妆图中的不同视角属于同一人物。按镜头要求描绘实际出镜人数。' : '';
    return `${creativeEntityLabels[entity.kind]}「${entity.name}」参考图：${numbers}。保持参考图中的${features[entity.kind]}，同时遵循文字设定。${casting}`;
  }).join('\n');
}

export function singleFrameVideoModel(model: ModelProfile | undefined, project: Pick<ProjectDocument, 'workflow'>): boolean {
  return model?.provider === 'openai-compatible' || model?.provider === 'seedance'
    && model.parameters.characterReferenceMode !== 'reference_image' && !project.workflow.production.referenceAudioAssetIds?.length;
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

/** This is also used by offline preview; protocol adapters add no hidden prose. */
export function buildMediaPrompt(project: ProjectDocument, node: WorkflowNode, shot: Shot, characters: CharacterProfile[] = [], model?: ModelProfile, hasSceneImage = false, upstream: Record<string, JsonValue> = {}, unifiedShotProfile = true): string {
  const selected = (shot.characterIds ?? []).map(id => {
    const profile = characters.find(profile => profile.id === id);
    if (!profile) throw new Error('缺少镜头所选角色的快照。');
    return profile;
  });
  const edit = node.config.imageEdit;
  const sourceId = edit && typeof edit === 'object' && !Array.isArray(edit) && typeof edit.sourceAssetId === 'string' ? edit.sourceAssetId : undefined;
  const sceneFirstFrame = hasSceneImage && characterSceneFirstFrame(project, node, model, shot, characters);
  const references = sceneFirstFrame ? [] : [...new Set([...(sourceId ? [sourceId] : []), ...selected.flatMap(profile => profile.referenceAssetIds), ...creativeReferenceAssetIds(project, shot)])];
  const multimodal = Boolean(project.workflow.production?.referenceAudioAssetIds?.length) || references.length > 0 && model?.parameters.characterReferenceMode === 'reference_image';
  const video = isVideoGenerationNode(node);
  const prompt = [sourceId ? '图片 1 为待修改原图，保留未要求修改的部分。' : '', project.style, shot.visualPrompt, shotCreativePrompt(project, shot), resolvePromptBindings(node, project, shot, upstream).prompt, characterReferencePrompt(selected, references), sceneFirstFrame ? '以镜头首帧中的人物形象和构图为准。' : creativeReferencePrompt(project, shot, references), generationFramePrompt(project.profile, video && unifiedShotProfile),
    ...(video ? [shot.narration.trim() ? `实际台词（只朗读以下正文）：${JSON.stringify(shot.narration)}` : '本镜头不需要人声。',
      `声音要求：${[node.config.soundPrompt, shot.soundPrompt].filter(Boolean).join('\n')}`,
      '画面不生成字幕或文字；台词、人声和环境音直接包含在视频音轨中。'] : []),
  ].filter(Boolean).join('\n');
  return prompt + (model?.provider === 'seedance' && multimodal && hasSceneImage ? `\n图片 ${references.length + 1} 为当前场景构图参考。` : '');
}
