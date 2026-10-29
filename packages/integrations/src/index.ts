import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { renderProject } from '@video-quickly/video/node';
import { requestModelParameters, validateModelParameters, type AssetRecord, type CharacterProfile, type JsonValue, type ModelProfile, type PreparedAudioMix, type ProjectDocument, type Shot, type WorkflowNode } from '@video-quickly/contracts';
import { transcribeAudio } from './transcription.js';
import { resolveCharacterReferences, type ResolvedCharacterReferences } from './character-references.js';

export { createWaveformReader } from './waveform.js';
export { readResearchSource, searchWikipedia, selectResearchPassages, parseResearchResult } from './research.js';

export interface MediaActivityContext {
  project: ProjectDocument;
  node: WorkflowNode;
  runId: string;
  operationId: string;
  signal: AbortSignal;
  dataDirectory: string;
  assets: AssetRecord[];
  characters?: CharacterProfile[];
  onProgress?: (value: number) => void;
  preparedAudioMix?: PreparedAudioMix;
  model?: ModelProfile;
  apiKey?: string;
  remoteTaskId?: string;
  persistRemoteTask(id: string): void;
}

interface Receipt {
  state: 'prepared' | 'submitted' | 'download' | 'completed' | 'unknown';
  taskId?: string;
  asset?: AssetRecord;
  downloadUrl?: string;
  base64?: string;
  error?: string;
  pollDeadlineAt?: number;
  authenticatedContent?: boolean;
}

const objectSchema = z.record(z.string(), z.unknown());
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const stringOrUndefined = (value: unknown) => typeof value === 'string' ? value : undefined;
const nested = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => current && typeof current === 'object' ? Reflect.get(current, key) : undefined, value);
const atPath = (value: unknown, path: unknown): unknown => typeof path === 'string' ? nested(value, ...path.split('.')) : undefined;

async function boundedResponseBytes(response: Response, maximum = MAX_MEDIA_BYTES): Promise<Uint8Array> {
  const declaredSize = Number(response.headers.get('content-length'));
  if (declaredSize > maximum) { await response.body?.cancel(); throw new Error('素材结果超出单文件限制'); }
  if (!response.body) throw new Error('服务未返回素材内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('素材结果超出单文件限制'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function fillTemplate(value: JsonValue, values: Record<string, JsonValue>): JsonValue {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{(\w+)\}\}$/)?.[1];
    if (exact && exact in values) return values[exact];
    return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key] ?? ''));
  }
  if (Array.isArray(value)) return value.map(item => fillTemplate(item, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillTemplate(item, values)]));
  return value;
}

function comfyPrompt(context: MediaActivityContext, shot: Shot, references: ResolvedCharacterReferences): Record<string, unknown> {
  const model = context.model!;
  const workflow = structuredClone(objectSchema.parse(model.parameters.workflow));
  const values: Record<string, JsonValue> = {
    prompt: [context.project.style, shot.visualPrompt, references.prompt].filter(Boolean).join('\n'), narration: shot.narration,
    character_images: references.images.map(image => image.dataUrl),
    width: context.project.profile.width, height: context.project.profile.height,
    seed: parseInt(createHash('sha256').update(`${context.operationId}:${shot.id}`).digest('hex').slice(0, 10), 16),
  };
  const mapping = model.parameters.inputMapping;
  if (mapping && typeof mapping === 'object' && !Array.isArray(mapping)) {
    for (const [name, target] of Object.entries(mapping)) {
      if (!(name in values) || typeof target !== 'string') continue;
      const [nodeId, inputName, ...extra] = target.split('.');
      if (extra.length || !nodeId || !inputName || ['__proto__', 'constructor', 'prototype'].includes(inputName)) throw new Error('ComfyUI 输入映射须使用“节点编号.输入名称”');
      const node = objectSchema.parse(workflow[nodeId]);
      const inputs = objectSchema.parse(node.inputs);
      inputs[inputName] = values[name];
      node.inputs = inputs; workflow[nodeId] = node;
    }
  }
  return workflow;
}

type MediaPreflightContext = Pick<MediaActivityContext, 'project' | 'node' | 'assets' | 'model' | 'characters'>;
const imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];
function currentVideoImage(context: MediaPreflightContext, shot: Shot): AssetRecord | undefined {
  return context.assets.find(asset => asset.id === shot.assetId && asset.kind === 'image' && asset.active)
    ?? (context.node.config.operation === 'regenerate' ? undefined : context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === 'image' && asset.active));
}
function hasExactTemplateValue(value: JsonValue | undefined, placeholder: string): boolean {
  if (typeof value === 'string') return value === placeholder;
  if (Array.isArray(value)) return value.some(item => hasExactTemplateValue(item, placeholder));
  return Boolean(value && typeof value === 'object' && Object.values(value).some(item => hasExactTemplateValue(item, placeholder)));
}
function validateReferenceProtocol(context: MediaPreflightContext, shot: Shot, references: ResolvedCharacterReferences): void {
  const model = context.model;
  if (!model || !references.images.length) return;
  const count = references.images.length;
  if (model.provider === 'custom-http') {
    if (!hasExactTemplateValue(model.parameters.requestTemplate, '{{character_images}}')) throw new Error('自定义 HTTP 角色参考须在 requestTemplate 中显式配置完整的 {{character_images}} 数组占位符。');
    return;
  }
  if (model.provider === 'comfyui') {
    const mapping = model.parameters.inputMapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || typeof mapping.character_images !== 'string') throw new Error('ComfyUI 角色参考须在 inputMapping.character_images 映射到接收图片 Data URL 数组的节点输入。');
    const [nodeId, inputName, ...extra] = mapping.character_images.split('.');
    if (extra.length || !nodeId || !inputName || ['__proto__', 'constructor', 'prototype'].includes(inputName)) throw new Error('ComfyUI 角色参考映射须使用“节点编号.输入名称”。');
    objectSchema.parse(nested(model.parameters.workflow, nodeId, 'inputs'));
    return;
  }
  if (references.images.some(image => !imageMimeTypes.includes(image.mimeType))) throw new Error('当前图像参考接口仅接受 PNG、JPEG 或 WebP，请转换角色参考图。');
  if (context.node.kind === 'assets') {
    if (model.provider === 'openai-compatible') {
      if (/dall-e/i.test(model.model)) throw new Error('当前角色参考使用 GPT Image 图像编辑协议，请选择支持该协议的模型。');
      if (count > 16) throw new Error('所选图像编辑模型最多支持 16 张角色参考图，请减少参考图。');
      if (references.images.some(image => image.dataUrl.length > 20_971_520)) throw new Error('图像编辑接口的单张参考图 Data URL 超过 20 MiB，请压缩图片。');
    } else if (model.provider === 'seedream') {
      if (/seedream[-_.]?3/i.test(model.model)) throw new Error('Seedream 3.0 文生图模型不支持参考图，请选择支持图像输入的模型。');
      if (count > 14) throw new Error('Seedream 本次最多支持 14 张角色参考图，请减少参考图。');
    } else throw new Error('所选图片协议尚未支持角色参考图。');
    return;
  }
  const image = currentVideoImage(context, shot);
  const total = count + (image ? 1 : 0);
  if (model.provider === 'openai-compatible' && total !== 1) throw new Error('当前 OpenAI 视频接口仅支持一张输入参考图；请仅保留一张角色图并移除镜头首帧，或改用支持多图的模型。');
  if (model.provider === 'seedance') {
    if (model.parameters.characterReferenceMode === 'reference_image') {
      if (/seedance[-_.]?1/i.test(model.model)) throw new Error('Seedance 1.x 不支持多模态 reference_image，请选择支持该模式的 2.x 模型。');
      const maximum = /seedance[-_.]?2[._-]?5/i.test(model.model) ? 30 : 9;
      if (total > maximum) throw new Error(`当前 Seedance 参考模式最多支持 ${maximum} 张图片（含当前画面），请减少参考图。`);
    } else if (total !== 1) throw new Error('Seedance 首帧模式仅支持一张图；多图角色参考须选择支持多模态参考的模型并将“角色参考方式”设为 reference_image。');
  } else if (model.provider !== 'openai-compatible') throw new Error('所选视频协议尚未支持角色参考图。');
}

/** Local preflight runs before the external-operation journal or estimated-cost reservation. */
export async function validateMediaActivity(context: MediaPreflightContext): Promise<void> {
  const model = context.model;
  if (!model) return;
  validateModelParameters(model);
  if (context.node.config.operation === 'transcribe') return;
  const capability = context.node.kind === 'assets' ? 'image' : context.node.kind === 'voice' ? 'tts' : context.node.kind === 'animation' ? 'video' : undefined;
  if (capability && !model.capabilities.includes(capability)) throw new Error(`所选模型不具备${capability === 'image' ? '图片' : capability === 'tts' ? '配音' : '视频'}生成能力`);
  const protocols: Record<string, string[]> = { assets: ['openai-compatible', 'seedream', 'comfyui', 'custom-http'], voice: ['openai-compatible', 'qwen-tts', 'custom-http'], animation: ['openai-compatible', 'seedance', 'comfyui', 'custom-http'] };
  if (protocols[context.node.kind] && !protocols[context.node.kind].includes(model.provider)) throw new Error('所选模型的服务协议不适用于此制作步骤');
  if (context.node.kind === 'voice' && model.provider === 'qwen-tts' && context.node.config.operation === 'regenerate' && typeof context.node.config.instruction === 'string' && context.node.config.instruction.trim()) throw new Error('当前 Qwen-TTS 接口不支持单镜头调整要求，请留空或改用支持语音指令的模型。');
  if (!['assets', 'animation'].includes(context.node.kind)) return;
  for (const shot of context.project.shots) {
    const kind = context.node.kind === 'assets' ? 'image' : 'video';
    const existing = context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === kind && asset.active);
    if (context.node.config.operation !== 'regenerate' && shot.locked && existing && await validAsset(existing)) continue;
    const references = await resolveCharacterReferences({ shot, characters: context.characters, assets: context.assets });
    validateReferenceProtocol(context, shot, references);
  }
}

function formParameters(parameters: Record<string, JsonValue>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(parameters)) form.set(key, value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
  return form;
}
function referenceBlob(dataUrl: string, mimeType: string): Blob { return new Blob([Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')], { type: mimeType }); }

function endpoint(base: string, path: string): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('模型地址须为不含内嵌凭据的 HTTP(S) 地址');
  return `${url.toString().replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}

function aspectRatio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

async function readReceipt(path: string): Promise<Receipt | undefined> {
  if (!existsSync(path)) return;
  return JSON.parse(await readFile(path, 'utf8')) as Receipt;
}

async function assetFor(path: string, context: MediaActivityContext, kind: AssetRecord['kind'], shot?: Shot): Promise<AssetRecord> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { signal: context.signal })) { hash.update(chunk); size += chunk.length; }
  return {
    id: `asset-${createHash('sha256').update(context.operationId + (shot?.id ?? '') + path).digest('hex').slice(0, 24)}`,
    projectId: context.project.id, shotId: shot?.id, name: path.split(/[\\/]/).at(-1) ?? '媒体', kind, path,
    mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : kind === 'subtitle' ? 'application/x-subrip' : 'application/json',
    size, sha256: hash.digest('hex'), version: 1,
    createdAt: new Date().toISOString(), provenance: context.model ? `${context.model.provider}/${context.model.model}` : '本地渲染', retained: false, active: true,
  };
}

async function validAsset(asset: AssetRecord): Promise<boolean> {
  if (!existsSync(asset.path)) return false;
  return createHash('sha256').update(await readFile(asset.path)).digest('hex') === asset.sha256;
}

async function requestJson(url: string, context: MediaActivityContext, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : {}), ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    signal: AbortSignal.any([context.signal, AbortSignal.timeout(120000)]),
  });
  if (!response.ok) throw new Error(`模型请求未完成（HTTP ${response.status}），请检查服务配置`);
  return objectSchema.parse(JSON.parse(new TextDecoder().decode(await boundedResponseBytes(response, 64 * 1024 * 1024))));
}

async function downloadReceipt(path: string, receiptPath: string, receipt: Receipt, context: MediaActivityContext, kind: AssetRecord['kind'], shot: Shot): Promise<AssetRecord> {
  let bytes: Uint8Array;
  if (receipt.base64) {
    if (receipt.base64.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4) throw new Error('素材结果超出单文件限制');
    bytes = Buffer.from(receipt.base64, 'base64');
  }
  else {
    if (!receipt.downloadUrl) throw new Error('生成任务未返回可下载的结果');
    const url = new URL(receipt.downloadUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('模型返回了不支持的素材地址');
    // Download hosts do not receive the model API credential.
    const apiOrigin = context.model ? new URL(context.model.baseUrl).origin : undefined;
    const response = await fetch(url, { headers: receipt.authenticatedContent && apiOrigin === url.origin && context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : undefined, signal: AbortSignal.any([context.signal, AbortSignal.timeout(120000)]) });
    if (!response.ok) throw new Error(`素材下载失败（HTTP ${response.status}），继续执行会恢复原下载`);
    bytes = await boundedResponseBytes(response);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('素材结果为空或超出单文件限制');
  const temporary = `${path}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  const asset = await assetFor(path, context, kind, shot);
  await atomicJson(receiptPath, { state: 'completed', taskId: receipt.taskId, asset });
  return asset;
}

async function generateMedia(context: MediaActivityContext, directory: string, shot: Shot, kind: 'image' | 'video' | 'audio'): Promise<AssetRecord> {
  const model = context.model;
  if (!model) throw new Error('请为此步骤选择相应的生成模型，或先导入素材');
  const parameters = requestModelParameters(model, kind === 'audio' ? 'tts' : kind);
  const references = kind === 'audio' ? { characters: [], prompt: '', images: [] } : await resolveCharacterReferences({ shot, characters: context.characters, assets: context.assets });
  validateReferenceProtocol(context, shot, references);
  const prompt = [context.project.style, shot.visualPrompt, references.prompt].filter(Boolean).join('\n');
  const instruction = context.node.config.operation === 'regenerate' && typeof context.node.config.instruction === 'string' ? context.node.config.instruction : '';
  if (kind === 'audio' && model.provider === 'qwen-tts' && instruction.trim()) throw new Error('当前 Qwen-TTS 接口不支持单镜头调整要求，请留空或改用支持语音指令的模型。');
  const extension = kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.mp3';
  const fileId = createHash('sha256').update(shot.id).digest('hex').slice(0, 24);
  const destination = join(directory, `${fileId}${extension}`);
  const receiptPath = join(directory, `${fileId}.receipt.json`);
  let receipt = await readReceipt(receiptPath);
  if (receipt?.state === 'completed' && receipt.asset) {
    if (await validAsset(receipt.asset)) return receipt.asset;
    throw new Error('已完成素材缺失或损坏，请显式重新生成此镜头');
  }
  if (receipt?.state === 'download') return downloadReceipt(destination, receiptPath, receipt, context, kind, shot);
  if (receipt?.state === 'unknown' || receipt?.state === 'prepared') throw new Error('该镜头上次提交结果不明确，请核对服务端任务后再重新生成');

  if (!receipt) {
    receipt = { state: 'prepared' };
    await atomicJson(receiptPath, receipt);
    try {
      if (model.provider === 'custom-http') {
        const requestPath = z.string().min(1).parse(model.parameters.requestPath);
        const template = model.parameters.requestTemplate;
        if (template === undefined) throw new Error('请为自定义 HTTP 模型配置 requestTemplate');
        const result = await requestJson(endpoint(model.baseUrl, requestPath), context, {
          method: 'POST', headers: { 'Idempotency-Key': `${context.operationId}:${shot.id}` },
          body: JSON.stringify(fillTemplate(template, { prompt, character_images: references.images.map(image => image.dataUrl), narration: shot.narration, instruction, model: model.model, width: context.project.profile.width, height: context.project.profile.height, duration: shot.durationUs / 1_000_000 })),
        });
        const taskId = stringOrUndefined(atPath(result, model.parameters.taskIdPath));
        receipt = taskId ? { state: 'submitted', taskId } : { state: 'download', downloadUrl: stringOrUndefined(atPath(result, model.parameters.resultUrlPath)), base64: stringOrUndefined(atPath(result, model.parameters.resultBase64Path)) };
      } else if (kind === 'image' && model.provider !== 'comfyui') {
        const imageParameters = { ...parameters, model: model.model, prompt, n: 1, size: parameters.size ?? `${context.project.profile.width}x${context.project.profile.height}` };
        const editing = references.images.length > 0 && model.provider === 'openai-compatible';
        const imageBody = JSON.stringify({ ...imageParameters, ...(editing ? { images: references.images.map(image => ({ image_url: image.dataUrl })) } : references.images.length && model.provider === 'seedream' ? { image: references.images.map(image => image.dataUrl) } : {}) });
        const result = await requestJson(endpoint(model.baseUrl, editing ? 'images/edits' : 'images/generations'), context, {
          method: 'POST', body: imageBody,
          headers: { 'Idempotency-Key': `${context.operationId}:${shot.id}` },
        });
        const first = Array.isArray(result.data) ? objectSchema.parse(result.data[0]) : undefined;
        receipt = { state: 'download', downloadUrl: stringOrUndefined(first?.url), base64: stringOrUndefined(first?.b64_json) };
      } else if (kind === 'audio' && model.provider === 'qwen-tts') {
        const result = await requestJson(endpoint(model.baseUrl, 'services/aigc/multimodal-generation/generation'), context, {
          method: 'POST', body: JSON.stringify({ model: model.model, input: { ...parameters, text: shot.narration, voice: parameters.voice ?? 'Cherry', language_type: parameters.language_type ?? 'Chinese' } }),
        });
        receipt = { state: 'download', downloadUrl: stringOrUndefined(nested(result, 'output', 'audio', 'url')) };
      } else if (kind === 'audio') {
        const response = await fetch(endpoint(model.baseUrl, 'audio/speech'), {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : {}), 'Idempotency-Key': `${context.operationId}:${shot.id}` },
          body: JSON.stringify({ ...parameters, model: model.model, input: shot.narration, voice: parameters.voice ?? 'alloy', response_format: 'mp3', ...(instruction ? { instructions: [typeof parameters.instructions === 'string' ? parameters.instructions : '', instruction].filter(Boolean).join('\n') } : {}) }),
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(120000)]),
        });
        if (!response.ok) throw new Error(`配音请求未完成（HTTP ${response.status}）`);
        receipt = { state: 'download', base64: Buffer.from(await boundedResponseBytes(response)).toString('base64') };
      } else if (model.provider === 'comfyui') {
        const workflow = comfyPrompt(context, shot, references);
        const result = await requestJson(endpoint(model.baseUrl, 'prompt'), context, { method: 'POST', body: JSON.stringify({ prompt: workflow, client_id: `${context.operationId}:${shot.id}` }) });
        const taskId = z.string().parse(result.prompt_id);
        receipt = { state: 'submitted', taskId };
        context.persistRemoteTask(taskId);
      } else if (kind === 'video') {
        const image = currentVideoImage(context, shot);
        const imageUrl = image ? `data:${image.mimeType};base64,${(await readFile(image.path)).toString('base64')}` : undefined;
        const seedance = model.provider === 'seedance';
        let body: string | FormData;
        if (seedance) {
          const multimodal = references.images.length > 0 && model.parameters.characterReferenceMode === 'reference_image';
          const images = [...references.images.map(reference => reference.dataUrl), ...(imageUrl ? [imageUrl] : [])];
          const videoPrompt = prompt + (multimodal && imageUrl ? `\n图片 ${images.length} 为当前场景构图参考。` : '');
          body = JSON.stringify({ ...parameters, model: model.model, content: [{ type: 'text', text: videoPrompt }, ...images.map(url => ({ type: 'image_url', image_url: { url }, role: multimodal ? 'reference_image' : 'first_frame' }))], duration: parameters.duration ?? Math.max(1, Math.ceil(shot.durationUs / 1_000_000)), ratio: parameters.ratio ?? aspectRatio(context.project.profile.width, context.project.profile.height) });
        }
        else {
          const form = formParameters(parameters);
          form.set('model', model.model); form.set('prompt', prompt);
          form.set('seconds', String(parameters.seconds ?? Math.ceil(shot.durationUs / 1_000_000)));
          form.set('size', String(parameters.size ?? `${context.project.profile.width}x${context.project.profile.height}`));
          if (image) form.set('input_reference', new Blob([await readFile(image.path)], { type: image.mimeType }), `reference${extname(image.path)}`);
          else if (references.images[0]) form.set('input_reference', referenceBlob(references.images[0].dataUrl, references.images[0].mimeType), 'character-reference.png');
          body = form;
        }
        const result = await requestJson(endpoint(model.baseUrl, seedance ? 'contents/generations/tasks' : 'videos'), context, {
          method: 'POST', headers: { 'Idempotency-Key': `${context.operationId}:${shot.id}` },
          body,
        });
        const taskId = z.string().parse(result.id ?? result.task_id);
        receipt = { state: 'submitted', taskId };
        context.persistRemoteTask(taskId);
      } else throw new Error('该服务协议尚不支持此素材类型');
      if (receipt.state === 'submitted') receipt.pollDeadlineAt = Date.now() + Math.max(30, Math.min(86400, Number(model.parameters.pollTimeoutSeconds) || 1800)) * 1000;
      await atomicJson(receiptPath, receipt);
      if (!receipt.taskId) context.persistRemoteTask(`receipt:${context.operationId}:${shot.id}`);
    } catch (error) {
      await atomicJson(receiptPath, { ...receipt, state: 'unknown', error: '提交结果需要核对' });
      throw error;
    }
  }

  if (receipt.state === 'submitted') {
    while (!context.signal.aborted) {
      if (receipt.pollDeadlineAt && Date.now() >= receipt.pollDeadlineAt) throw new Error('等待生成结果已超过本次查询时限，请在服务端核对原任务');
      let completed: string | undefined;
      if (model.provider === 'custom-http') {
        const pollPath = z.string().min(1).parse(model.parameters.pollPath).replaceAll('{{taskId}}', encodeURIComponent(receipt.taskId!));
        const result = await requestJson(endpoint(model.baseUrl, pollPath), context);
        const status = atPath(result, model.parameters.statusPath);
        if (['failed', 'canceled', 'cancelled', 'expired', 'error'].includes(String(status))) throw new Error('模型任务失败，请核对服务端任务记录');
        completed = stringOrUndefined(atPath(result, model.parameters.resultUrlPath));
      } else if (model.provider === 'comfyui') {
        const history = await requestJson(endpoint(model.baseUrl, `history/${encodeURIComponent(receipt.taskId!)}`), context);
        const item = nested(history, receipt.taskId!) as Record<string, unknown> | undefined;
        if (nested(item, 'status', 'status_str') === 'error') throw new Error('ComfyUI 工作流失败，请检查任务记录');
        const outputs = nested(item, 'outputs');
        if (outputs && typeof outputs === 'object') {
          for (const output of Object.values(outputs)) {
            const files = nested(output, kind === 'image' ? 'images' : 'gifs');
            if (Array.isArray(files) && files[0]) {
              const file = objectSchema.parse(files[0]);
              const query = new URLSearchParams({ filename: z.string().parse(file.filename), subfolder: stringOrUndefined(file.subfolder) ?? '', type: stringOrUndefined(file.type) ?? 'output' });
              completed = endpoint(model.baseUrl, `view?${query}`);
              break;
            }
          }
        }
      } else {
        const result = await requestJson(endpoint(model.baseUrl, `${model.provider === 'seedance' ? 'contents/generations/tasks' : 'videos'}/${encodeURIComponent(receipt.taskId!)}`), context);
        const status = result.status;
        if (['failed', 'canceled', 'cancelled', 'expired'].includes(String(status))) throw new Error('视频任务未完成，请检查服务端任务状态');
        completed = stringOrUndefined(nested(result, 'content', 'video_url')) ?? stringOrUndefined(result.url) ?? stringOrUndefined(nested(result, 'output', 'url'));
        if (!completed && status === 'completed' && model.provider === 'openai-compatible') {
          completed = endpoint(model.baseUrl, `videos/${encodeURIComponent(receipt.taskId!)}/content`);
          receipt.authenticatedContent = true;
        } else if (!completed && ['succeeded', 'completed'].includes(String(status))) {
          throw new Error('生成任务已完成，但该服务未返回支持的结果地址，请配置自定义响应映射');
        }
      }
      if (completed) { receipt = { ...receipt, state: 'download', downloadUrl: completed }; await atomicJson(receiptPath, receipt); break; }
      await delay(2000, undefined, { signal: context.signal });
    }
    context.signal.throwIfAborted();
  }
  return downloadReceipt(destination, receiptPath, receipt, context, kind, shot);
}

export function createActivityExecutor(options: { ffmpegPath?: string } = {}) {
  return async (context: MediaActivityContext): Promise<JsonValue> => {
    await validateMediaActivity(context);
    if (context.node.config.operation === 'transcribe') return transcribeAudio(context);
    if (context.model) {
      const capability = context.node.kind === 'assets' ? 'image' : context.node.kind === 'voice' ? 'tts' : context.node.kind === 'animation' ? 'video' : undefined;
      if (capability && !context.model.capabilities.includes(capability)) throw new Error(`所选模型不具备${capability === 'image' ? '图片' : capability === 'tts' ? '配音' : '视频'}生成能力`);
      const protocols: Record<string, string[]> = { assets: ['openai-compatible', 'seedream', 'comfyui', 'custom-http'], voice: ['openai-compatible', 'qwen-tts', 'custom-http'], animation: ['openai-compatible', 'seedance', 'comfyui', 'custom-http'] };
      if (protocols[context.node.kind] && !protocols[context.node.kind].includes(context.model.provider)) throw new Error('所选模型的服务协议不适用于此制作步骤');
    }
    // Per-shot receipts own ambiguous submit recovery; allow the parent graph
    // to enter this adapter again and inspect them after a process restart.
    if (context.model) context.persistRemoteTask(`media-receipts:${context.operationId}`);
    const directory = resolve(context.dataDirectory, 'projects', context.project.id, 'activities', createHash('sha256').update(context.operationId).digest('hex').slice(0, 24));
    await mkdir(directory, { recursive: true });
    if (context.node.kind === 'export') {
      const output = await renderProject({ project: context.project, assets: context.assets, outputDirectory: directory, ffmpegPath: options.ffmpegPath, signal: context.signal, onProgress: context.onProgress, preparedAudioMix: context.preparedAudioMix });
      const assets = await Promise.all([
        assetFor(output.videoPath, context, 'video'), assetFor(output.coverPath, context, 'image'),
        assetFor(output.subtitlePath, context, 'subtitle'), assetFor(output.timelinePath, context, 'document'),
      ]);
      let videoPath = output.videoPath;
      if (typeof context.node.config.destination === 'string' && context.node.config.destination.trim()) {
        const destination = resolve(context.node.config.destination);
        if (extname(destination).toLowerCase() !== '.mp4') throw new Error('导出文件路径须以 .mp4 结尾');
        await mkdir(resolve(destination, '..'), { recursive: true });
        // An explicitly selected output path is created exclusively.
        const bytes = await readFile(output.videoPath);
        try { await writeFile(destination, bytes, { flag: 'wx' }); }
        catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
          const existing = await readFile(destination);
          if (!existing.equals(bytes)) throw new Error('输出位置已有不同文件，请选择新的文件名');
        }
        videoPath = destination;
      }
      return { assets: assets as unknown as JsonValue, videoPath, coverPath: output.coverPath, subtitlePath: output.subtitlePath, timelinePath: output.timelinePath, warnings: output.warnings };
    }
    if (context.node.kind === 'animation' && !context.model) {
      return { source: 'local', shots: context.project.shots.length, message: '动画与运镜参数已就绪，导出步骤将按当前时间轴渲染' };
    }
    const kind = context.node.kind === 'assets' ? 'image' : context.node.kind === 'voice' ? 'audio' : 'video';
    if (!context.model) {
      const assets = context.project.shots.map(shot => context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === kind && asset.active));
      if (assets.some(asset => !asset)) throw new Error(`请为每个镜头导入${kind === 'audio' ? '配音' : '画面'}素材，或为此步骤选择模型`);
      for (const asset of assets) if (asset && !(await validAsset(asset))) throw new Error('已引用素材缺失或损坏，请重新导入');
      return { assets: assets as unknown as JsonValue, source: 'imported' };
    }
    const assets: AssetRecord[] = [];
    const regenerating = context.node.config.operation === 'regenerate';
    if (regenerating && (context.project.shots.length !== 1 || context.project.shots[0].id !== context.node.config.shotId || context.project.shots[0].locked)) throw new Error('重新生成须仅包含一个未锁定的目标镜头。');
    for (const shot of context.project.shots) {
      context.signal.throwIfAborted();
      const existing = context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === kind && asset.active);
      if (!regenerating && shot.locked && existing && await validAsset(existing)) assets.push(existing);
      else {
        const instruction = regenerating && typeof context.node.config.instruction === 'string' ? context.node.config.instruction : '';
        const generationShot = kind !== 'audio' && instruction ? { ...shot, visualPrompt: `${shot.visualPrompt}\n\n本次调整要求：${instruction}` } : shot;
        assets.push(await generateMedia(context, directory, generationShot, kind));
      }
    }
    return { assets: assets as unknown as JsonValue, source: 'model', modelId: context.model.id };
  };
}
