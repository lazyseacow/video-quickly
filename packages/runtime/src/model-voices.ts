import { z } from 'zod';
import { getModelVoiceCatalog, supportsAccountVoices, type ModelProfile, type VoiceDiscovery } from '@video-quickly/contracts';
import { modelEndpoint, readModelResponse } from './providers.js';

const listSchema = z.object({ output: z.object({ voice_list: z.array(z.object({ voice_id: z.string().min(1), status: z.string(), target_model: z.string().optional() })) }) });
const detailSchema = z.object({ output: z.object({ target_model: z.string(), status: z.string() }) });

/** Only list/query actions are sent; voice creation, training and synthesis are separate operations. */
export async function discoverModelVoices(model: ModelProfile, secret?: string): Promise<VoiceDiscovery> {
  const presets = getModelVoiceCatalog(model);
  if (!model.capabilities.includes('tts') || !supportsAccountVoices(model) || !secret?.trim()) return presets;
  const signal = AbortSignal.timeout(15_000);
  async function query(input: Record<string, string | number>) {
    const response = await fetch(modelEndpoint(model.baseUrl, 'services/audio/tts/customization'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model: 'voice-enrollment', input }), signal,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`音色查询返回 HTTP ${response.status}。`); }
    return readModelResponse(response);
  }
  const matches = new Map<string, { id: string; label: string }>(); let inspected = 0, limited = false;
  for (let page = 0; page < 4; page++) {
    const data = listSchema.parse(await query({ action: 'list_voice', page_index: page, page_size: 50 }));
    const rows = data.output.voice_list.filter(voice => voice.status === 'OK');
    for (let start = 0; start < rows.length; start += 4) {
      const details = await Promise.all(rows.slice(start, start + 4).map(async voice => {
        const detail = voice.target_model ? { output: voice } : detailSchema.parse(await query({ action: 'query_voice', voice_id: voice.voice_id }));
        return detail.output.status === 'OK' && detail.output.target_model === model.model ? { id: voice.voice_id, label: `账号音色 · ${voice.voice_id}` } : undefined;
      }));
      for (const voice of details) if (voice) matches.set(voice.id, voice);
    }
    inspected += data.output.voice_list.length;
    if (data.output.voice_list.length < 50) break;
    if (page === 3) limited = true;
  }
  const items = new Map(presets.items.map(voice => [voice.id, voice]));
  for (const voice of matches.values()) items.set(voice.id, voice);
  return { ...presets, source: presets.items.length ? 'mixed' : 'remote', items: [...items.values()],
    message: `${presets.items.length ? '包含官方公共音色预设；' : ''}已读取 ${matches.size} 个匹配当前模型的账号音色。${limited ? `已检查前 ${inspected} 条账号记录，其他音色可自定义填写。` : ''}`,
  };
}
