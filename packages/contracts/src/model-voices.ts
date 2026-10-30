import catalog from './voice-catalog.json' with { type: 'json' };
import type { ModelProfile, VoiceDiscovery } from './index.js';

type VoiceContext = Pick<ModelProfile, 'provider' | 'platform' | 'baseUrl' | 'model'>;

/** Public presets are tied to documented models; they do not represent account permissions. */
export function getModelVoiceCatalog(model: VoiceContext): VoiceDiscovery {
  let voices: { id: string; name: string }[] = [], sourceUrl: string | undefined;
  if (model.provider === 'volcengine-tts' && model.model.startsWith('seed-tts-')) {
    voices = model.model === 'seed-tts-2.0' ? catalog.volcengine.v2 : model.model.startsWith('seed-tts-1.0') ? catalog.volcengine.v1 : [];
    sourceUrl = catalog.sources.volcengine;
  } else if (model.provider === 'qwen-tts' && /^qwen3-tts-flash(?:$|-\d)/.test(model.model)) {
    voices = catalog.qwen; sourceUrl = catalog.sources.qwen;
  } else if (model.provider === 'openai-compatible' && (model.platform === 'openai' || !model.platform && new URL(model.baseUrl).hostname === 'api.openai.com')) {
    if (/^tts-1(?:-hd)?(?:$|-\d)/.test(model.model)) voices = catalog.openai.filter(voice => catalog.openaiLegacy.includes(voice.id));
    else if (/^gpt-4o-mini-tts(?:$|-\d)/.test(model.model)) voices = catalog.openai;
    sourceUrl = catalog.sources.openai;
  }
  return { source: 'preset', items: voices.map(voice => ({ id: voice.id, label: voice.name })), sourceUrl,
    message: voices.length ? '官方公共音色预设，已按当前模型筛选；服务权限以平台为准。' : model.model ? '此模型暂无公共音色预设，可使用自定义音色。' : '选择模型后显示对应音色。',
  };
}

export function supportsAccountVoices(model: Pick<ModelProfile, 'provider' | 'model'>): boolean {
  return model.provider === 'qwen-tts' && /^(qwen(?:3|-audio)[\w.-]*-tts[\w.-]*|cosyvoice[\w.-]*)$/.test(model.model);
}
