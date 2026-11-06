import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { probeMedia, renderProject } from '@video-quickly/video/node';
import { buildMediaPrompt, MediaRequestRejectedError, VideoGenerationError, isVideoGenerationNode, validateCreativeReferences } from '@video-quickly/contracts';
import { providerReportedUsage, sumProviderUsage, requestModelParameters, validateModelParameters, type ProviderUsage, type AssetRecord, type CharacterProfile, type JsonValue, type ModelProfile, type PreparedAudioMix, type ProjectDocument, type Shot, type WorkflowNode } from '@video-quickly/contracts';
import { MediaRequestQueue, mapMediaShots } from './media-concurrency.js';
import { resolveCharacterReferences, type ResolvedCharacterReferences } from './character-references.js';
import { resolveReferenceAudio } from './audio-references.js';
import { resolveImageEdit } from './image-edit.js';
import { appendSkillContext, type SkillPackage } from '@video-quickly/contracts';

export { createWaveformReader } from './waveform.js';
export { readResearchSource, searchWikipedia, selectResearchPassages, parseResearchResult } from './research.js';

export interface MediaDiagnosticEvent {
  event: `media.${'queued' | 'started' | 'completed' | 'failed' | 'canceled' | 'reused' | 'receipt_loaded' | 'request_started' | 'request_completed' | 'request_failed' | 'status_received' | 'poll_started' | 'poll_completed' | 'poll_retry_scheduled' | 'poll_recovered' | 'download_started' | 'download_completed' | 'validation_started' | 'validation_completed' | 'render_started' | 'render_completed'}`;
  level: 'debug' | 'info' | 'warn' | 'error';
  phase?: 'queue' | 'generate' | 'submit' | 'poll' | 'download' | 'validate' | 'render';
  shotId?: string;
  assetId?: string;
  state?: 'prepared' | 'submitted' | 'download' | 'completed' | 'unknown' | 'rejected';
  durationMs?: number;
  queueMs?: number;
  byteSize?: number;
  statusCode?: number;
  pollCount?: number;
  retryCount?: number;
  retryDelayMs?: number;
  cached?: boolean;
  resumed?: boolean;
  hasRemoteId?: boolean;
  remoteStatus?: 'queued' | 'generating';
  error?: unknown;
}

export interface MediaActivityContext {
  skills?: SkillPackage[];
  project: ProjectDocument;
  node: WorkflowNode;
  runId: string;
  operationId: string;
  signal: AbortSignal;
  queueSignal?: AbortSignal;
  onFailure?: (error: unknown) => void;
  dataDirectory: string;
  assets: AssetRecord[];
  characters?: CharacterProfile[];
  promptUpstream?: Record<string, JsonValue>;
  onProgress?: (value: number) => void;
  onAsset?: (asset: AssetRecord) => void;
  onDiagnostic?: (event: MediaDiagnosticEvent) => void;
  preparedAudioMix?: PreparedAudioMix;
  model?: ModelProfile;
  apiKey?: string;
  ffprobePath?: string;
  remoteTaskId?: string;
  persistRemoteTask(id: string): void;
}

interface Receipt {
  state: 'prepared' | 'submitted' | 'download' | 'completed' | 'unknown' | 'rejected';
  attempt?: number;
  rejection?: { status: number };
  taskId?: string;
  asset?: AssetRecord;
  downloadUrl?: string;
  base64?: string;
  error?: string;
  pollDeadlineAt?: number;
  authenticatedContent?: boolean;
  providerUsage?: ProviderUsage;
}

const objectSchema = z.record(z.string(), z.unknown());
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const rejectedPostStatuses = new Set([400, 401, 402, 403, 404, 405, 406, 410, 413, 414, 415, 422, 429]);
const stringOrUndefined = (value: unknown) => typeof value === 'string' ? value : undefined;
const nested = (value: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((current, key) => current && typeof current === 'object' ? Reflect.get(current, key) : undefined, value);
const atPath = (value: unknown, path: unknown): unknown => typeof path === 'string' ? nested(value, ...path.split('.')) : undefined;
function generationStatus(value: unknown): MediaDiagnosticEvent['remoteStatus'] {
  if (['queued', 'pending', 'submitted'].includes(String(value))) return 'queued';
  if (['running', 'in_progress', 'processing', 'generating'].includes(String(value))) return 'generating';
}

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

function visualPrompt(context: MediaActivityContext, shot: Shot, references: ResolvedCharacterReferences): string {
  return appendSkillContext(buildMediaPrompt(context.project, context.node, shot, references.characters, context.model, Boolean(currentVideoImage(context, shot)), context.promptUpstream), context.node, context.skills ?? []);
}

function comfyPrompt(context: MediaActivityContext, shot: Shot, references: ResolvedCharacterReferences): Record<string, unknown> {
  const model = context.model!;
  const workflow = structuredClone(objectSchema.parse(model.parameters.workflow));
  const values: Record<string, JsonValue> = {
    prompt: visualPrompt(context, shot, references), narration: shot.narration,
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

type MediaPreflightContext = Pick<MediaActivityContext, 'project' | 'node' | 'assets' | 'model' | 'characters'> & Partial<Pick<MediaActivityContext, 'operationId' | 'dataDirectory' | 'signal'>>;
const mediaActivityDirectory = (dataDirectory: string, projectId: string, operationId: string) => resolve(dataDirectory, 'projects', projectId, 'activities', createHash('sha256').update(operationId).digest('hex').slice(0, 24));
const mediaShotFileId = (shotId: string) => createHash('sha256').update(shotId).digest('hex').slice(0, 24);
const imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];
function currentVideoImage(context: MediaPreflightContext, shot: Shot): AssetRecord | undefined {
  if (isVideoGenerationNode(context.node) && context.project.workflow.production?.referenceMode === 'none') return;
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
  if (!model || !references.images.length && !context.node.config.imageEdit) return;
  const editSourceId = context.node.config.imageEdit && typeof context.node.config.imageEdit === 'object' && !Array.isArray(context.node.config.imageEdit) ? context.node.config.imageEdit.sourceAssetId : undefined;
  const count = references.images.length + (typeof editSourceId === 'string' && !references.images.some(image => image.assetId === editSourceId) ? 1 : 0);
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
      if (count > 16) throw new Error('所选图像编辑模型最多支持 16 张参考图，请减少参考图。');
      if (references.images.some(image => image.dataUrl.length > 20_971_520)) throw new Error('图像编辑接口的单张参考图 Data URL 超过 20 MiB，请压缩图片。');
    } else if (model.provider === 'seedream') {
      if (/seedream[-_.]?3/i.test(model.model)) throw new Error('Seedream 3.0 文生图模型不支持参考图，请选择支持图像输入的模型。');
      if (count > 14) throw new Error('Seedream 本次最多支持 14 张参考图，请减少参考图。');
    } else throw new Error('所选图片协议尚未支持角色参考图。');
    return;
  }
  const image = currentVideoImage(context, shot);
  const total = count + (image ? 1 : 0);
  if (model.provider === 'openai-compatible' && total !== 1) throw new Error('当前 OpenAI 视频接口仅支持一张输入参考图；请仅保留一张角色图并移除镜头首帧，或改用支持多图的模型。');
  if (model.provider === 'seedance') {
    const referenceImages = model.parameters.characterReferenceMode === 'reference_image';
    if (referenceImages || context.project.workflow.production.referenceAudioAssetIds?.length) {
      if (referenceImages && /seedance[-_.]?1/i.test(model.model)) throw new Error('Seedance 1.x 不支持多模态 reference_image，请选择支持该模式的 2.x 模型。');
      const maximum = /seedance[-_.]?2[._-]?5/i.test(model.model) ? 30 : 9;
      if (total > maximum) throw new Error(`当前 Seedance 参考模式最多支持 ${maximum} 张图片（含当前画面），请减少参考图。`);
    } else if (total !== 1) throw new Error('Seedance 首帧模式仅支持一张图；多图角色参考须选择支持多模态参考的模型并将“角色参考方式”设为 reference_image。');
  } else if (model.provider !== 'openai-compatible') throw new Error('所选视频协议尚未支持角色参考图。');
}

function imageRequestSize(model: ModelProfile, profile: ProjectDocument['profile']): JsonValue {
  const configured = model.parameters.size;
  if (!/seedream[-_.](?:image[-_.])?v?5[-_.]0(?:[-_.]|$)/i.test(model.model)) {
    // GPT Image chooses a supported canvas independently of the export profile.
    return configured ?? (model.provider === 'openai-compatible' && (model.model.startsWith('gpt-image-') || model.model === 'chatgpt-image-latest') ? 'auto' : `${profile.width}x${profile.height}`);
  }
  const minimumPixels = 3_686_400, maximumPixels = 16_777_216;
  let width = profile.width, height = profile.height;
  if (configured !== undefined) {
    const dimensions = typeof configured === 'string' && /^(\d+)x(\d+)$/.exec(configured);
    if (!dimensions) throw new Error('Seedream 5 的图片尺寸 size 须填写宽x高，例如 2560x1440。');
    width = Number(dimensions[1]); height = Number(dimensions[2]);
  } else {
    const pixels = width * height;
    if (pixels < minimumPixels || pixels > maximumPixels) {
      const scale = Math.sqrt((pixels < minimumPixels ? minimumPixels : maximumPixels) / pixels);
      const round = pixels < minimumPixels ? Math.ceil : Math.floor;
      width = round(width * scale); height = round(height * scale);
    }
  }
  if (width * height < minimumPixels || width * height > maximumPixels || width / height < 1 / 16 || width / height > 16) {
    throw new Error(`图片尺寸 size=${width}x${height} 不符合 Seedream 5 要求：总像素须为 3,686,400–16,777,216，宽高比须为 1:16–16:1。`);
  }
  return `${width}x${height}`;
}

/** Local preflight runs before the external-operation journal or estimated-cost reservation. */
export async function validateMediaActivity(context: MediaPreflightContext): Promise<void> {
  validateCreativeReferences(context.project);
  const model = context.model;
  if (!model) return;
  validateModelParameters(model);
  const capability = context.node.kind === 'assets' ? 'image' : context.node.kind === 'animation' ? 'video' : undefined;
  if (capability && !model.capabilities.includes(capability)) throw new Error(`所选模型不具备${capability === 'image' ? '图片' : '视频'}生成能力`);
  const protocols: Record<string, string[]> = { assets: ['openai-compatible', 'seedream', 'comfyui', 'custom-http'], animation: ['openai-compatible', 'seedance', 'comfyui', 'custom-http'] };
  if (protocols[context.node.kind] && !protocols[context.node.kind].includes(model.provider)) throw new Error('所选模型的服务协议不适用于此制作步骤');
  if (capability === 'image' && ['openai-compatible', 'seedream'].includes(model.provider)) imageRequestSize(model, context.project.profile);
  if (capability && context.operationId && context.dataDirectory) {
    // Check the frozen batch before native tasks are replayed. A queued sibling
    // can run before the failed task; its own missing receipt is not permission
    // to create more paid work while another submission remains ambiguous.
    const directory = mediaActivityDirectory(context.dataDirectory, context.project.id, context.operationId);
    for (const shot of context.project.shots) {
      context.signal?.throwIfAborted();
      const receipt = await readReceipt(join(directory, `${mediaShotFileId(shot.id)}.receipt.json`));
      if (receipt && ['prepared', 'unknown'].includes(receipt.state)) throw new Error('有镜头上次提交结果不明确，核对服务端任务后再继续。');
    }
  }
  if (!['assets', 'animation'].includes(context.node.kind)) return;
  await resolveImageEdit(context);
  if (model.provider === 'seedance' && isVideoGenerationNode(context.node)) await resolveReferenceAudio({ assetIds: context.project.workflow.production.referenceAudioAssetIds ?? [], assets: context.assets, projectId: context.project.id, signal: context.signal });
  for (const shot of context.project.shots) {
    context.signal?.throwIfAborted();
    const kind = context.node.kind === 'assets' ? 'image' : 'video';
    const existing = context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === kind && asset.active);
    if (context.node.config.operation !== 'regenerate' && shot.locked && existing && await validAsset(existing)) continue;
    const references = await resolveCharacterReferences({ project: context.project, shot, characters: context.characters, assets: context.assets });
    context.signal?.throwIfAborted();
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
  // Windows file sharing/permission errors can clear after a handle closes.
  // Retry only this local replacement, keeping the same temporary file and
  // the previous receipt intact; external requests never enter this loop.
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, path); return; }
    catch (error) {
      const retryable = error instanceof Error && 'code' in error && typeof error.code === 'string' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      if (!retryable || attempt === 5) throw error;
      await delay(50 * (attempt + 1));
    }
  }
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
    mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : kind === 'subtitle' ? 'application/x-subrip' : 'application/json',
    size, sha256: hash.digest('hex'), version: 1,
    ...(kind === 'video' && isVideoGenerationNode(context.node) ? await (async () => {
      const metadata = await probeMedia(path, context.ffprobePath, context.signal);
      if (!metadata.width || !metadata.height || !metadata.audio) throw new VideoGenerationError();
      return { width: metadata.width, height: metadata.height, durationUs: Math.round((metadata.videoDuration ?? metadata.duration) * 1_000_000) };
    })() : {}),
    createdAt: new Date().toISOString(), provenance: context.model ? `${context.model.provider}/${context.model.model}` : '本地渲染', retained: false, active: true,
  };
}

async function validAsset(asset: AssetRecord): Promise<boolean> {
  if (!existsSync(asset.path)) return false;
  return createHash('sha256').update(await readFile(asset.path)).digest('hex') === asset.sha256;
}

const retryablePollCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ENETDOWN', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH']);
function retryablePollError(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 3) return false;
  if ('status' in error && typeof error.status === 'number') return [408, 429, 500, 502, 503, 504].includes(error.status);
  if (error.name === 'TimeoutError' || 'code' in error && typeof error.code === 'string' && retryablePollCodes.has(error.code)) return true;
  if (error instanceof AggregateError && error.errors.length) return error.errors.every(cause => retryablePollError(cause, depth + 1));
  return retryablePollError(error.cause, depth + 1);
}
function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function requestJson(url: string, context: MediaActivityContext, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const started = performance.now(), phase = init.method === 'POST' ? 'submit' : 'poll';
  const level = phase === 'poll' ? 'debug' : 'info';
  let statusCode: number | undefined;
  context.onDiagnostic?.({ event: 'media.request_started', level, phase });
  try {
    const response = await fetch(url, {
      ...init,
      headers: { ...(context.apiKey ? { Authorization: `Bearer ${context.apiKey}` } : {}), ...(init.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(120000)]),
    });
    statusCode = response.status;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (phase === 'submit' && rejectedPostStatuses.has(response.status)) throw new MediaRequestRejectedError(response.status);
      throw Object.assign(new Error(`模型请求未完成（HTTP ${response.status}），请检查服务配置`), { status: response.status, retryAfterMs: retryAfterMilliseconds(response.headers.get('retry-after')) });
    }
    const bytes = await boundedResponseBytes(response, 64 * 1024 * 1024);
    const result = objectSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    context.onDiagnostic?.({ event: 'media.request_completed', level, phase, statusCode, byteSize: bytes.byteLength, durationMs: performance.now() - started });
    return result;
  } catch (error) {
    context.onDiagnostic?.({ event: 'media.request_failed', level: context.signal.aborted ? 'warn' : 'error', phase, statusCode, durationMs: performance.now() - started, error });
    throw error;
  }
}

async function downloadReceipt(path: string, receiptPath: string, receipt: Receipt, context: MediaActivityContext, kind: AssetRecord['kind'], shot: Shot): Promise<AssetRecord> {
  const started = performance.now();
  context.onDiagnostic?.({ event: 'media.download_started', level: 'info', phase: 'download' });
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
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`素材下载失败（HTTP ${response.status}），继续执行会恢复原下载`), { status: response.status }); }
    bytes = await boundedResponseBytes(response);
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('素材结果为空或超出单文件限制');
  const temporary = `${path}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
  context.onDiagnostic?.({ event: 'media.download_completed', level: 'info', phase: 'download', byteSize: bytes.byteLength, durationMs: performance.now() - started });
  const validationStarted = performance.now();
  context.onDiagnostic?.({ event: 'media.validation_started', level: 'info', phase: 'validate' });
  const asset = await assetFor(path, context, kind, shot);
  await atomicJson(receiptPath, { state: 'completed', attempt: receipt.attempt, taskId: receipt.taskId, asset, providerUsage: receipt.providerUsage });
  context.onDiagnostic?.({ event: 'media.validation_completed', level: 'info', phase: 'validate', assetId: asset.id, byteSize: asset.size, durationMs: performance.now() - validationStarted });
  return asset;
}

async function seedanceVideoBody(context: MediaActivityContext & { model: ModelProfile }, shot: Shot, references: ResolvedCharacterReferences, parameters: Record<string, JsonValue>): Promise<string> {
  const audio = await resolveReferenceAudio({ assetIds: context.project.workflow.production.referenceAudioAssetIds ?? [], assets: context.assets, projectId: context.project.id, signal: context.signal });
  const image = currentVideoImage(context, shot);
  const imageUrl = image ? `data:${image.mimeType};base64,${(await readFile(image.path)).toString('base64')}` : undefined;
  const multimodal = audio.length > 0 || references.images.length > 0 && context.model.parameters.characterReferenceMode === 'reference_image';
  const images = [...references.images.map(reference => reference.dataUrl), ...(imageUrl ? [imageUrl] : [])];
  const prompt = visualPrompt(context, shot, references);
  const body = JSON.stringify({ ...parameters, model: context.model.model, content: [
    { type: 'text', text: prompt },
    ...images.map(url => ({ type: 'image_url', image_url: { url }, role: multimodal ? 'reference_image' : 'first_frame' })),
    ...audio.map(reference => ({ type: 'audio_url', audio_url: { url: reference.dataUrl }, role: 'reference_audio' })),
  ], duration: parameters.duration ?? Math.max(1, Math.ceil(shot.durationUs / 1_000_000)), ratio: parameters.ratio ?? aspectRatio(context.project.profile.width, context.project.profile.height) });
  if (Buffer.byteLength(body) > 64_000_000) throw new Error('参考素材与提示词编码后超过 64 MB 请求限制，请压缩或减少素材。');
  return body;
}

async function generateMedia(context: MediaActivityContext, directory: string, shot: Shot, kind: 'image' | 'video', onUsage: (usage?: ProviderUsage) => void): Promise<AssetRecord> {
  const model = context.model;
  if (!model) throw new Error('请为此步骤选择相应的生成模型，或先导入素材');
  const parameters = requestModelParameters(model, kind);
  if (kind === 'video') parameters.generate_audio = true;
  const references = await resolveCharacterReferences({ project: context.project, shot, characters: context.characters, assets: context.assets });
  const imageEdit = await resolveImageEdit(context);
  validateReferenceProtocol(context, shot, references);
  const prompt = visualPrompt(context, shot, references);
  const adjustment = context.node.config.operation === 'regenerate' && typeof context.node.config.instruction === 'string' ? context.node.config.instruction : '';
  const instruction = context.node.prompt.trim().endsWith(adjustment.trim()) ? context.node.prompt : [context.node.prompt, adjustment].filter(Boolean).join('\n');
  const extension = kind === 'image' ? '.png' : '.mp4';
  const fileId = mediaShotFileId(shot.id);
  const destination = join(directory, `${fileId}${extension}`);
  const receiptPath = join(directory, `${fileId}.receipt.json`);
  let receipt = await readReceipt(receiptPath);
  if (receipt) context.onDiagnostic?.({ event: 'media.receipt_loaded', level: 'info', state: receipt.state, resumed: true, hasRemoteId: Boolean(receipt.taskId) });
  if (receipt?.state === 'completed' && receipt.asset) {
    if (await validAsset(receipt.asset)) { context.onDiagnostic?.({ event: 'media.reused', level: 'info', cached: true, assetId: receipt.asset.id }); onUsage(receipt.providerUsage); return receipt.asset; }
    throw new Error('已完成素材缺失或损坏，请显式重新生成此镜头');
  }
  if (receipt?.state === 'download') { const asset = await downloadReceipt(destination, receiptPath, receipt, context, kind, shot); onUsage(receipt.providerUsage); return asset; }
  if (receipt?.state === 'unknown' || receipt?.state === 'prepared') throw new Error('该镜头上次提交结果不明确，请核对服务端任务后再重新生成');
  const attempt = (receipt?.attempt ?? 1) + (receipt?.state === 'rejected' ? 1 : 0);
  if (receipt?.state === 'rejected') receipt = undefined;
  const requestId = `${context.operationId}:${shot.id}${attempt > 1 ? `:attempt:${attempt}` : ''}`;

  // Local file and request-size failures remain retryable before recording a submission.
  const seedanceBody = !receipt && kind === 'video' && model.provider === 'seedance' ? await seedanceVideoBody({ ...context, model }, shot, references, parameters) : '';
  if (!receipt) {
    receipt = { state: 'prepared', attempt };
    await atomicJson(receiptPath, receipt);
    try {
      if (model.provider === 'custom-http') {
        const requestPath = z.string().min(1).parse(model.parameters.requestPath);
        const template = model.parameters.requestTemplate;
        if (template === undefined) throw new Error('请为自定义 HTTP 模型配置 requestTemplate');
        const result = await requestJson(endpoint(model.baseUrl, requestPath), context, {
          method: 'POST', headers: { 'Idempotency-Key': requestId },
          body: JSON.stringify(fillTemplate(template, { prompt, character_images: references.images.map(image => image.dataUrl), narration: shot.narration, instruction, model: model.model, width: context.project.profile.width, height: context.project.profile.height, duration: shot.durationUs / 1_000_000 })),
        });
        const taskId = stringOrUndefined(atPath(result, model.parameters.taskIdPath));
        receipt = taskId ? { state: 'submitted', taskId } : { state: 'download', downloadUrl: stringOrUndefined(atPath(result, model.parameters.resultUrlPath)), base64: stringOrUndefined(atPath(result, model.parameters.resultBase64Path)) };
        receipt.providerUsage = providerReportedUsage(result);
      } else if (kind === 'image' && model.provider !== 'comfyui') {
        const imageParameters = { ...parameters, model: model.model, prompt, n: 1, size: imageRequestSize(model, context.project.profile) };
        const editing = references.images.length > 0 && model.provider === 'openai-compatible';
        const imageBody = JSON.stringify({ ...imageParameters, ...(editing ? { images: references.images.map(image => ({ image_url: image.dataUrl })) } : references.images.length && model.provider === 'seedream' ? { image: references.images.map(image => image.dataUrl) } : {}) });
        let requestBody: string | FormData = imageBody;
        if (imageEdit) {
          const form = formParameters(imageParameters);
          form.set('image[]', new Blob([imageEdit.source.bytes], { type: imageEdit.source.asset.mimeType }), 'source' + extname(imageEdit.source.asset.path));
          for (const image of references.images.filter(image => image.assetId !== imageEdit.source.asset.id)) form.append('image[]', referenceBlob(image.dataUrl, image.mimeType), `reference-${form.getAll('image[]').length}.png`);
          if (imageEdit.mask) form.set('mask', new Blob([imageEdit.mask.bytes], { type: 'image/png' }), 'mask.png');
          requestBody = form;
        }
        const result = await requestJson(endpoint(model.baseUrl, editing || imageEdit ? 'images/edits' : 'images/generations'), context, {
          method: 'POST', body: requestBody,
          headers: { 'Idempotency-Key': requestId },
        });
        const first = Array.isArray(result.data) ? objectSchema.parse(result.data[0]) : undefined;
        receipt = { state: 'download', downloadUrl: stringOrUndefined(first?.url), base64: stringOrUndefined(first?.b64_json), providerUsage: providerReportedUsage(result) };
      } else if (model.provider === 'comfyui') {
        const workflow = comfyPrompt(context, shot, references);
        const result = await requestJson(endpoint(model.baseUrl, 'prompt'), context, { method: 'POST', body: JSON.stringify({ prompt: workflow, client_id: requestId }) });
        const taskId = z.string().parse(result.prompt_id);
        receipt = { state: 'submitted', taskId, providerUsage: providerReportedUsage(result) };
        context.persistRemoteTask(taskId);
      } else if (kind === 'video') {
        const seedance = model.provider === 'seedance';
        let body: string | FormData;
        if (seedance) {
          body = seedanceBody;
        }
        else {
          const image = currentVideoImage(context, shot);
          const form = formParameters(parameters);
          form.set('model', model.model); form.set('prompt', prompt);
          form.set('seconds', String(parameters.seconds ?? Math.ceil(shot.durationUs / 1_000_000)));
          form.set('size', String(parameters.size ?? `${context.project.profile.width}x${context.project.profile.height}`));
          if (image) form.set('input_reference', new Blob([await readFile(image.path)], { type: image.mimeType }), `reference${extname(image.path)}`);
          else if (references.images[0]) form.set('input_reference', referenceBlob(references.images[0].dataUrl, references.images[0].mimeType), 'character-reference.png');
          body = form;
        }
        const result = await requestJson(endpoint(model.baseUrl, seedance ? 'contents/generations/tasks' : 'videos'), context, {
          method: 'POST', headers: { 'Idempotency-Key': requestId },
          body,
        });
        const taskId = z.string().parse(result.id ?? result.task_id);
        receipt = { state: 'submitted', taskId, providerUsage: providerReportedUsage(result) };
        context.persistRemoteTask(taskId);
      } else throw new Error('该服务协议尚不支持此素材类型');
      receipt.attempt = attempt;
      await atomicJson(receiptPath, receipt);
      if (!receipt.taskId) context.persistRemoteTask(`receipt:${context.operationId}:${shot.id}`);
    } catch (error) {
      await atomicJson(receiptPath, error instanceof MediaRequestRejectedError
        ? { ...receipt, attempt, state: 'rejected', rejection: { status: error.status }, error: error.message }
        : { ...receipt, attempt, state: 'unknown', error: '提交结果需要核对' });
      throw error;
    }
  }

  if (receipt.state === 'submitted') {
    context.signal.throwIfAborted();
    const pollStarted = performance.now(); let pollCount = 0, retryCount = 0;
    context.onDiagnostic?.({ event: 'media.poll_started', level: 'info', phase: 'poll', hasRemoteId: Boolean(receipt.taskId) });
    // Transient GET failures stay inside this query window and never replay POST.
    const pollDeadlineAt = Date.now() + Math.max(30, Math.min(86400, Number(model.parameters.pollTimeoutSeconds) || 1800)) * 1000;
    receipt.pollDeadlineAt = pollDeadlineAt;
    await atomicJson(receiptPath, receipt);
    const pollContext = { ...context, signal: AbortSignal.any([context.signal, AbortSignal.timeout(Math.max(0, Math.ceil(pollDeadlineAt - Date.now())))]) };
    while (!context.signal.aborted) {
      if (Date.now() >= pollDeadlineAt) throw new Error('等待生成结果已超过本次查询时限，原任务已保留');
      pollCount++;
      let completed: string | undefined, remoteStatus: MediaDiagnosticEvent['remoteStatus'];
      try {
        if (model.provider === 'custom-http') {
          const pollPath = z.string().min(1).parse(model.parameters.pollPath).replaceAll('{{taskId}}', encodeURIComponent(receipt.taskId!));
          const result = await requestJson(endpoint(model.baseUrl, pollPath), pollContext);
          receipt.providerUsage = providerReportedUsage(result) ?? receipt.providerUsage;
          const status = atPath(result, model.parameters.statusPath);
          remoteStatus = generationStatus(status);
          if (['failed', 'canceled', 'cancelled', 'expired', 'error'].includes(String(status))) throw new Error('模型任务失败，请核对服务端任务记录');
          completed = stringOrUndefined(atPath(result, model.parameters.resultUrlPath));
        } else if (model.provider === 'comfyui') {
          const history = await requestJson(endpoint(model.baseUrl, `history/${encodeURIComponent(receipt.taskId!)}`), pollContext);
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
          const result = await requestJson(endpoint(model.baseUrl, `${model.provider === 'seedance' ? 'contents/generations/tasks' : 'videos'}/${encodeURIComponent(receipt.taskId!)}`), pollContext);
          receipt.providerUsage = providerReportedUsage(result) ?? receipt.providerUsage;
          const status = result.status;
          remoteStatus = generationStatus(status);
          if (['failed', 'canceled', 'cancelled', 'expired'].includes(String(status))) throw new Error('视频任务未完成，请检查服务端任务状态');
          completed = stringOrUndefined(nested(result, 'content', 'video_url')) ?? stringOrUndefined(result.url) ?? stringOrUndefined(nested(result, 'output', 'url'));
          if (!completed && status === 'completed' && model.provider === 'openai-compatible') {
            completed = endpoint(model.baseUrl, `videos/${encodeURIComponent(receipt.taskId!)}/content`);
            receipt.authenticatedContent = true;
          } else if (!completed && ['succeeded', 'completed'].includes(String(status))) {
            throw new Error('生成任务已完成，但该服务未返回支持的结果地址，请配置自定义响应映射');
          }
        }
        if (retryCount) context.onDiagnostic?.({ event: 'media.poll_recovered', level: 'info', phase: 'poll', retryCount });
        retryCount = 0;
      } catch (error) {
        context.signal.throwIfAborted();
        const remaining = pollDeadlineAt - Date.now();
        if (remaining <= 0 || pollContext.signal.aborted) throw new Error('等待生成结果已超过本次查询时限，原任务已保留', { cause: error });
        if (!retryablePollError(error)) throw error;
        retryCount++;
        const retryAfterMs = error instanceof Error && 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' ? error.retryAfterMs : 0;
        const retryDelayMs = Math.min(remaining, Math.max(Math.min(30_000, 1000 * 2 ** Math.min(retryCount - 1, 5)), retryAfterMs));
        const statusCode = error instanceof Error && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
        context.onDiagnostic?.({ event: 'media.poll_retry_scheduled', level: 'warn', phase: 'poll', retryCount, retryDelayMs, statusCode, error });
        await delay(retryDelayMs, undefined, { signal: context.signal });
        continue;
      }
      context.onDiagnostic?.({ event: 'media.status_received', level: 'debug', phase: 'poll', remoteStatus });
      if (completed) { receipt = { ...receipt, state: 'download', downloadUrl: completed }; await atomicJson(receiptPath, receipt); break; }
      await delay(Math.min(2000, Math.max(0, pollDeadlineAt - Date.now())), undefined, { signal: context.signal });
    }
    context.signal.throwIfAborted();
    context.onDiagnostic?.({ event: 'media.poll_completed', level: 'info', phase: 'poll', pollCount, durationMs: performance.now() - pollStarted });
  }
  const asset = await downloadReceipt(destination, receiptPath, receipt, context, kind, shot);
  onUsage(receipt.providerUsage);
  return asset;
}

export function createActivityExecutor(options: { ffmpegPath?: string } = {}) {
  const requests = new MediaRequestQueue();
  return async (context: MediaActivityContext): Promise<JsonValue> => {
    const ffmpeg = options.ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG;
    context = { ...context, ffprobePath: process.env.VIDEO_QUICKLY_FFPROBE ?? (ffmpeg ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : undefined) };
    if (context.node.config.operation === 'prepare-edit') {
      if (context.model) throw new Error('剪辑准备使用本地时间轴，请移除此步骤的模型。');
      return { source: 'local', shots: context.project.shots.length, message: '动画与运镜参数已就绪，导出步骤将按当前时间轴渲染' };
    }
    if (isVideoGenerationNode(context.node) && !context.model) throw new Error('请选择视频模型。');
    await validateMediaActivity(context);
    if (context.node.config.operation === 'prepare-references' && context.node.config.referenceMode !== 'generate') {
      const assets = context.node.config.referenceMode === 'none' ? [] : context.project.shots.flatMap(shot => {
        const asset = context.assets.find(asset => asset.id === shot.assetId && asset.active && asset.kind === 'image');
        return asset ? [asset] : [];
      });
      for (const asset of assets) if (!await validAsset(asset)) throw new Error('参考素材缺失或损坏，请重新导入。');
      return { source: 'local', references: assets.length, referenceAssetIds: assets.map(asset => asset.id) };
    }
    if (context.model) {
      const capability = context.node.kind === 'assets' ? 'image' : context.node.kind === 'animation' ? 'video' : undefined;
      if (capability && !context.model.capabilities.includes(capability)) throw new Error(`所选模型不具备${capability === 'image' ? '图片' : '视频'}生成能力`);
      const protocols: Record<string, string[]> = { assets: ['openai-compatible', 'seedream', 'comfyui', 'custom-http'], animation: ['openai-compatible', 'seedance', 'comfyui', 'custom-http'] };
      if (protocols[context.node.kind] && !protocols[context.node.kind].includes(context.model.provider)) throw new Error('所选模型的服务协议不适用于此制作步骤');
    }
    // Per-shot receipts own ambiguous submit recovery; allow the parent graph
    // to enter this adapter again and inspect them after a process restart.
    if (context.model) context.persistRemoteTask(`media-receipts:${context.operationId}`);
    const directory = mediaActivityDirectory(context.dataDirectory, context.project.id, context.operationId);
    await mkdir(directory, { recursive: true });
    if (context.node.kind === 'export') {
      const started = performance.now();
      context.onDiagnostic?.({ event: 'media.render_started', level: 'info', phase: 'render' });
      const output = await renderProject({ project: context.project, assets: context.assets, outputDirectory: directory, ffmpegPath: options.ffmpegPath, signal: context.signal, onProgress: context.onProgress, preparedAudioMix: context.preparedAudioMix });
      context.onDiagnostic?.({ event: 'media.render_completed', level: 'info', phase: 'render', durationMs: performance.now() - started });
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
    const kind = context.node.kind === 'assets' ? 'image' : 'video';
    if (!context.model) {
      const assets = context.project.shots.map(shot => context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === kind && asset.active));
      if (assets.some(asset => !asset)) throw new Error(`请为每个镜头导入${'画面'}素材，或为此步骤选择模型`);
      for (const asset of assets) if (asset && !(await validAsset(asset))) throw new Error('已引用素材缺失或损坏，请重新导入');
      return { assets: assets as unknown as JsonValue, source: 'imported' };
    }
    const usages: Array<ProviderUsage | undefined> = [];
    const regenerating = context.node.config.operation === 'regenerate';
    if (regenerating && (context.project.shots.length !== 1 || context.project.shots[0].id !== context.node.config.shotId || context.project.shots[0].locked)) throw new Error('重新生成须仅包含一个未锁定的目标镜头。');
    const execution = context.project.workflow.execution;
    const concurrency = execution?.maxConcurrentShots ?? 1;
    const modelLimit = execution?.modelLimits[context.model.id] ?? concurrency;
    const assets = await mapMediaShots(context.project.shots, concurrency, context.signal, async (shot, _index, queueSignal, fail) => {
      const existing = context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === kind && asset.active);
      let phase: MediaDiagnosticEvent['phase'] = 'queue';
      const diagnostic = (event: MediaDiagnosticEvent) => { phase = event.phase ?? phase; context.onDiagnostic?.({ ...event, shotId: shot.id }); };
      if (!regenerating && shot.locked && existing && await validAsset(existing)) { context.onAsset?.(existing); diagnostic({ event: 'media.reused', level: 'info', cached: true, assetId: existing.id }); return existing; }
      const instruction = regenerating && typeof context.node.config.instruction === 'string' ? context.node.config.instruction : '';
      const generationShot = instruction && !context.node.prompt.trim().endsWith(instruction.trim()) ? { ...shot, visualPrompt: `${shot.visualPrompt}\n\n本次调整要求：${instruction}` } : shot;
      const queued = performance.now(); let started: number | undefined;
      diagnostic({ event: 'media.queued', level: 'info', phase: 'queue' });
      try {
        return await requests.run(context.model!.id, modelLimit, context.queueSignal ? AbortSignal.any([queueSignal, context.queueSignal]) : queueSignal, async () => {
          started = performance.now();
          diagnostic({ event: 'media.started', level: 'info', phase: 'generate', queueMs: started - queued });
          try {
            const asset = await generateMedia({ ...context, onDiagnostic: diagnostic }, directory, generationShot, kind, usage => usages.push(usage));
            context.onAsset?.(asset);
            diagnostic({ event: 'media.completed', level: 'info', phase: 'generate', assetId: asset.id, byteSize: asset.size, durationMs: performance.now() - started });
            return asset;
          } catch (error) { context.onFailure?.(error); fail(error); throw error; }
        });
      } catch (error) {
        const canceled = context.signal.aborted || started === undefined && (queueSignal.aborted || context.queueSignal?.aborted);
        diagnostic({ event: canceled ? 'media.canceled' : 'media.failed', level: canceled ? 'warn' : 'error', phase, durationMs: performance.now() - (started ?? queued), error });
        throw error;
      }
    });
    const usage = sumProviderUsage(usages);
    return { assets: assets as unknown as JsonValue, source: 'model', modelId: context.model.id, ...(usage ? { providerUsage: usage as unknown as JsonValue } : {}) };
  };
}
