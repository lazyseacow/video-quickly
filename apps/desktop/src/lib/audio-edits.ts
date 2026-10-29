import { audioMixSettingsSchema, audioProcessingSchema, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, type AudioMixSettings, type AudioProcessing, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { resolveShotSpans } from '@video-quickly/video/clip-edits';
import { sameContent, type EditContent } from './project-edits';

export type AudioProcessingValue = { scope: 'project'; mix: AudioMixSettings } | { scope: 'shot'; shot: { id: string; processing: AudioProcessing } };

function audioInputs(shot: Shot, context: Pick<ProjectDocument, 'clipEditSources' | 'clipEditPlans'>) {
  return { audioAssetId: shot.audioAssetId, durationUs: shot.durationUs, spans: resolveShotSpans(shot, context).map(span => ({ startUs: span.outputStartUs, endUs: span.outputEndUs, audioInUs: span.audioInUs })) };
}

export function applyAudioProcessingEdit(current: EditContent, baseline: ProjectDocument, value: AudioProcessingValue, submitted?: AudioProcessingValue): EditContent {
  if (value.scope === 'project') {
    const mix = audioMixSettingsSchema.parse(value.mix), before = baseline.audioMix ?? DEFAULT_AUDIO_MIX_SETTINGS, live = current.audioMix ?? DEFAULT_AUDIO_MIX_SETTINGS;
    if (!sameContent(live, before) && !(submitted?.scope === 'project' && sameContent(live, submitted.mix))) throw new Error('项目混音设置已在其他视图更新，输入已保留，请重新打开后核对。');
    return { ...current, audioMix: structuredClone(mix) };
  }
  const processing = audioProcessingSchema.parse(value.shot.processing), shot = current.shots.find(shot => shot.id === value.shot.id), before = baseline.shots.find(shot => shot.id === value.shot.id);
  if (!shot || !before) throw new Error('准备处理的镜头已移除，请重新选择。');
  if (shot.locked) throw new Error('请先解锁镜头，再修改声音处理。');
  if (!sameContent(audioInputs(shot, current), audioInputs(before, baseline))) throw new Error('镜头音频来源或剪辑范围已变化，输入已保留，请重新打开后核对。');
  const live = shot.audioProcessing ?? DEFAULT_AUDIO_PROCESSING, original = before.audioProcessing ?? DEFAULT_AUDIO_PROCESSING;
  if (!sameContent(live, original) && !(submitted?.scope === 'shot' && submitted.shot.id === shot.id && sameContent(live, submitted.shot.processing))) throw new Error('镜头声音处理已在其他视图更新，输入已保留，请重新打开后核对。');
  return { ...current, shots: current.shots.map(shot => shot.id === value.shot.id ? { ...shot, audioProcessing: structuredClone(processing) } : shot) };
}
