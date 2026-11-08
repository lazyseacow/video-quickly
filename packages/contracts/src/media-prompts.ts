import type { CharacterProfile, JsonValue, ModelProfile, ProjectDocument, Shot, WorkflowNode } from './index.js';
import { creativeReferenceAssetIds, shotCreativePrompt } from './creative-context.js';
import { isVideoGenerationNode } from './production.js';
import { resolvePromptBindings } from './prompt-bindings.js';

export function characterReferencePrompt(selected: CharacterProfile[], referenceIds: readonly string[] = [...new Set(selected.flatMap(profile => profile.referenceAssetIds))]): string {
  if (!selected.length) return '';
  return ['角色一致性要求：', ...selected.map(profile => `角色「${profile.name}」：${profile.description || '保持同一角色身份。'}${profile.referenceAssetIds.length ? `\n参考图：${profile.referenceAssetIds.map(id => `图片 ${referenceIds.indexOf(id) + 1}`).join('、')}。保留参考图中的人物外观、服装和辨识特征。` : ''}`)].join('\n');
}

function creativeReferencePrompt(project: Pick<ProjectDocument, 'creativeContext'>, shot: Pick<Shot, 'creativeEntityKeys'>, referenceIds: readonly string[]): string {
  const selected = new Set(shot.creativeEntityKeys ?? []);
  return (project.creativeContext?.entities ?? []).filter(entity => selected.has(entity.key) && entity.referenceAssetIds?.length).map(entity => `${entity.kind === 'scene' ? '场景' : '道具'}「${entity.name}」参考图：${(entity.referenceAssetIds ?? []).map(id => `图片 ${referenceIds.indexOf(id) + 1}`).join('、')}。保持参考图中的${entity.kind === 'scene' ? '空间布局、建筑与光线' : '形状、颜色与材质'}，同时遵循文字设定。`).join('\n');
}

/** This is also used by offline preview; protocol adapters add no hidden prose. */
export function buildMediaPrompt(project: ProjectDocument, node: WorkflowNode, shot: Shot, characters: CharacterProfile[] = [], model?: ModelProfile, hasSceneImage = false, upstream: Record<string, JsonValue> = {}): string {
  const selected = (shot.characterIds ?? []).map(id => {
    const profile = characters.find(profile => profile.id === id);
    if (!profile) throw new Error('缺少镜头所选角色的快照。');
    return profile;
  });
  const edit = node.config.imageEdit;
  const sourceId = edit && typeof edit === 'object' && !Array.isArray(edit) && typeof edit.sourceAssetId === 'string' ? edit.sourceAssetId : undefined;
  const references = [...new Set([...(sourceId ? [sourceId] : []), ...selected.flatMap(profile => profile.referenceAssetIds), ...creativeReferenceAssetIds(project, shot)])];
  const multimodal = Boolean(project.workflow.production?.referenceAudioAssetIds?.length) || references.length > 0 && model?.parameters.characterReferenceMode === 'reference_image';
  const prompt = [sourceId ? '图片 1 为待修改原图，保留未要求修改的部分。' : '', project.style, shot.visualPrompt, shotCreativePrompt(project, shot), resolvePromptBindings(node, project, shot, upstream).prompt, characterReferencePrompt(selected, references), creativeReferencePrompt(project, shot, references),
    ...(isVideoGenerationNode(node) ? [shot.narration.trim() ? `实际台词（只朗读以下正文）：${JSON.stringify(shot.narration)}` : '本镜头不需要人声。',
      `声音要求：${[node.config.soundPrompt, shot.soundPrompt].filter(Boolean).join('\n')}`,
      '画面不生成字幕或文字；台词、人声和环境音直接包含在视频音轨中。'] : []),
  ].filter(Boolean).join('\n');
  return prompt + (model?.provider === 'seedance' && multimodal && hasSceneImage ? `\n图片 ${references.length + 1} 为当前场景构图参考。` : '');
}
