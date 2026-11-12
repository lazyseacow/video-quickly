import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareGeneratedVideo, renderProject } from '@video-quickly/video/node';
import { buildMediaPrompt, characterSceneFirstFrame, getMediaAdapters, groupsNativeFirstFrames, groupsReferenceImages, hasTemplateValue, imageReferenceLimit, MediaRequestRejectedError, isVideoGenerationNode, planReferenceImageSequences, seedreamTextOnly, singleFrameVideoModel, singleImageRequestModel, validateCreativeReferences, videoReferenceImages, type VideoReferenceImages } from '@video-quickly/contracts';
import { providerReportedUsage, sumProviderUsage, requestModelParameters, validateModelParameters, type ProviderUsage, type AssetRecord, type JsonValue, type ModelProfile, type Shot } from '@video-quickly/contracts';
import { MediaRequestQueue } from './media-concurrency.js';
import { MAX_CHARACTER_REFERENCE_BYTES, MAX_CHARACTER_REFERENCE_TOTAL_BYTES, resolveCharacterReferences, type ResolvedCharacterReferences } from './character-references.js';
import { resolveReferenceAudio } from './audio-references.js';
import { resolveImageEdit } from './image-edit.js';
import { appendSkillContext } from '@video-quickly/contracts';
import type { MediaActivityContext, MediaDiagnosticEvent } from './media-context.js';
import { boundedResponseBytes, endpoint, MAX_MEDIA_BYTES, nested, objectSchema, requestJson, stringOrUndefined } from './media-http.js';
import { currentVideoImage, imageRequestSize, mediaPollRequest, mediaSubmissionRequest, seedanceVideoBody, videoFrameBytes } from './media-protocols.js';

export { createWaveformReader } from './waveform.js';

export type { MediaActivityContext, MediaDiagnosticEvent } from './media-context.js';

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

type ImageDownload = Pick<Receipt, 'downloadUrl' | 'base64'>;
type SequenceReceipt = { attempt: number } & (
  | { state: 'prepared' | 'unknown' | 'rejected' }
  | { state: 'invalid'; error: string }
  | { state: 'download'; images: ImageDownload[]; providerUsage?: ProviderUsage }
  | { state: 'completed'; providerUsage?: ProviderUsage }
);

function visualPrompt(context: MediaActivityContext, shot: Shot, references: ResolvedCharacterReferences, videoReferences?: VideoReferenceImages): string {
  if (context.promptOverride !== undefined) return context.promptOverride;
  const hasFrame = Boolean(videoReferences ? videoReferences.frame : currentVideoImage(context, shot));
  return appendSkillContext(buildMediaPrompt(context.project, context.node, shot, references.characters, context.model, hasFrame, context.promptUpstream, videoReferences), context.node, context.skills ?? []);
}

type MediaPreflightContext = Pick<MediaActivityContext, 'project' | 'node' | 'assets' | 'model' | 'characters' | 'legacyVideoReferences'> & Partial<Pick<MediaActivityContext, 'operationId' | 'dataDirectory' | 'signal'>> & { pendingVideoInput?: boolean };

function mediaRequestModel({ project, node, model }: Pick<MediaPreflightContext, 'project' | 'node' | 'model'>): ModelProfile | undefined {
  const firstFrames = groupsNativeFirstFrames(project.workflow, node) || node.config.useFirstShotReference === true && groupsReferenceImages(node);
  return model && firstFrames ? singleImageRequestModel(model) : model;
}

const mediaActivityDirectory = (dataDirectory: string, projectId: string, operationId: string) => resolve(dataDirectory, 'projects', projectId, 'activities', createHash('sha256').update(operationId).digest('hex').slice(0, 24));
const mediaShotFileId = (shotId: string) => createHash('sha256').update(shotId).digest('hex').slice(0, 24);
const sequenceReceiptPath = (directory: string, shots: readonly Shot[]) => join(directory, `sequence-${mediaShotFileId(JSON.stringify(shots.map(shot => shot.id)))}.receipt.json`);
const imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp'];
function planVideoReferences(context: MediaPreflightContext, shot: Shot) {
  if (context.legacyVideoReferences || !context.model || !isVideoGenerationNode(context.node)) return undefined;
  return videoReferenceImages(context.project, context.node, context.model, shot, context.characters ?? [], context.assets);
}

function mediaReferences(context: MediaPreflightContext, shot: Shot, plan?: VideoReferenceImages) {
  if (plan) return resolveCharacterReferences({ project: context.project, shot, characters: context.characters, assets: context.assets, referenceIds: plan.referenceIds });
  const sceneFrame = characterSceneFirstFrame(context.project, context.node, context.model, shot, context.characters);
  const includeImages = !sceneFrame || !currentVideoImage(context, shot);
  return resolveCharacterReferences({ project: context.project, shot, characters: context.characters, assets: context.assets, includeImages });
}
function validateReferenceProtocol(context: MediaPreflightContext, shot: Shot, references: ResolvedCharacterReferences, plan?: VideoReferenceImages, needsAnchor = false): void {
  const model = context.model;
  if (!model || !references.images.length && !plan?.frame && !context.node.config.imageEdit && !needsAnchor) return;
  const editSourceId = context.node.config.imageEdit && typeof context.node.config.imageEdit === 'object' && !Array.isArray(context.node.config.imageEdit) ? context.node.config.imageEdit.sourceAssetId : undefined;
  const count = references.images.length + Number(needsAnchor) + Number(typeof editSourceId === 'string' && !references.images.some(image => image.assetId === editSourceId));
  if (model.provider === 'custom-http') {
    if (!hasTemplateValue(model.parameters.requestTemplate, '{{character_images}}')) throw new Error('自定义 HTTP 图片参考须在 requestTemplate 中配置完整的 {{character_images}} 数组占位符。');
    if (needsAnchor && !hasTemplateValue(model.parameters.requestTemplate, '{{prompt}}', false)) throw new Error('自定义 HTTP 首帧组图须在 requestTemplate 中配置 {{prompt}}。');
    return;
  }
  if (model.provider === 'comfyui') {
    const mapping = model.parameters.inputMapping;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || typeof mapping.character_images !== 'string') throw new Error('ComfyUI 视频参考图须在 inputMapping.character_images 映射到接收图片 Data URL 数组的节点输入。');
    const [nodeId, inputName, ...extra] = mapping.character_images.split('.');
    if (extra.length || !nodeId || !inputName || ['__proto__', 'constructor', 'prototype'].includes(inputName)) throw new Error('ComfyUI 输入映射须使用“节点编号.输入名称”。');
    objectSchema.parse(nested(model.parameters.workflow, nodeId, 'inputs'));
    return;
  }
  if (references.images.some(image => !imageMimeTypes.includes(image.mimeType))) throw new Error('当前图像参考接口仅接受 PNG、JPEG 或 WebP，请转换角色参考图。');
  if (context.node.kind === 'assets') {
    if (seedreamTextOnly.test(model.model)) throw new Error('Seedream 3.0 文生图模型不支持参考图，请选择支持图像输入的模型。');
    const maximum = imageReferenceLimit(model);
    if (maximum === undefined) throw new Error('所选图片协议尚未支持角色参考图。');
    if (count > maximum) throw new Error(`所选图片模型最多支持 ${maximum} 张参考图，请减少参考图。`);
    if (model.provider === 'openai-compatible') {
      if (/dall-e/i.test(model.model)) throw new Error('当前角色参考使用 GPT Image 图像编辑协议，请选择支持该协议的模型。');
      if (references.images.some(image => image.dataUrl.length > 20_971_520)) throw new Error('图像编辑接口的单张参考图 Data URL 超过 20 MiB，请压缩图片。');
    }
    return;
  }
  const image = plan ? plan.frame : currentVideoImage(context, shot);
  const total = count + (image && !plan?.referenceIds.includes(image.id) ? 1 : 0);
  if (model.provider === 'openai-compatible' && total !== 1) throw new Error('当前连接使用 OpenAI 兼容视频接口，每个镜头仅支持一张输入图。请配置图片模型并重新开始制作，以生成包含出镜角色的镜头首帧。');
  if (model.provider === 'seedance') {
    const referenceImages = model.parameters.characterReferenceMode === 'reference_image';
    if (referenceImages || context.project.workflow.production.referenceAudioAssetIds?.length) {
      if (referenceImages && /seedance[-_.]?1/i.test(model.model)) throw new Error('Seedance 1.x 不支持多模态 reference_image，请选择支持该模式的 2.x 模型。');
      const maximum = /seedance[-_.]?2[._-]?5/i.test(model.model) ? 30 : 9;
      if (total > maximum) throw new Error(`当前 Seedance 参考模式最多支持 ${maximum} 张图片（含当前画面），请减少参考图。`);
    } else if (total !== 1) throw new Error('Seedance 首帧模式仅支持一张图；多图角色参考须选择支持多模态参考的模型并将“角色参考方式”设为 reference_image。');
  } else if (model.provider !== 'openai-compatible') throw new Error('所选视频协议尚未支持角色参考图。');
}

/** Local preflight runs before the external-operation journal or estimated-cost reservation. */
export async function validateMediaActivity(context: MediaPreflightContext): Promise<void> {
  validateCreativeReferences(context.project);
  const model = mediaRequestModel(context);
  if (!model) return;
  context = { ...context, model };
  validateModelParameters(model);
  const capability = context.node.kind === 'assets' ? 'image' : context.node.kind === 'animation' ? 'video' : undefined;
  if (capability && !model.capabilities.includes(capability)) throw new Error(`所选模型不具备${capability === 'image' ? '图片' : '视频'}生成能力`);
  if (capability && !getMediaAdapters([capability]).some(adapter => adapter.id === model.provider)) throw new Error('所选模型的服务协议不适用于此制作步骤');
  if (capability === 'image' && ['openai-compatible', 'seedream'].includes(model.provider)) imageRequestSize(model, context.project.profile);
  const nativeFirstFrames = groupsNativeFirstFrames(context.project.workflow, context.node);
  const sequences = capability === 'image' ? planReferenceImageSequences(context) : [];
  const nativeShots = new Set<string>(), anchoredShots = new Set<string>();
  for (const { seedream, batches } of sequences) {
    for (const [index, batch] of batches.entries()) for (const shot of batch) {
      if (seedream) nativeShots.add(shot.id);
      if (index > 0) anchoredShots.add(shot.id);
    }
  }
  if (capability && context.operationId && context.dataDirectory) {
    // Check the frozen batch before native tasks are replayed. A queued sibling
    // can run before the failed task; its own missing receipt is not permission
    // to create more paid work while another submission remains ambiguous.
    const directory = mediaActivityDirectory(context.dataDirectory, context.project.id, context.operationId);
    for (const shot of context.project.shots) {
      context.signal?.throwIfAborted();
      if (nativeFirstFrames && shot.locked) continue;
      const receipt = await readReceipt(join(directory, `${mediaShotFileId(shot.id)}.receipt.json`));
      if (receipt && ['prepared', 'unknown'].includes(receipt.state)) throw new Error('有镜头上次提交结果不明确，核对服务端任务后再继续。');
    }
    for (const sequence of sequences) if (sequence.seedream) for (const batch of sequence.batches) {
      context.signal?.throwIfAborted();
      checkSequenceReceipt(await readReceipt<SequenceReceipt>(sequenceReceiptPath(directory, batch)));
    }
  }
  if (!['assets', 'animation'].includes(context.node.kind)) return;
  await resolveImageEdit(context);
  if (model.provider === 'seedance' && isVideoGenerationNode(context.node)) await resolveReferenceAudio({ assetIds: context.project.workflow.production.referenceAudioAssetIds ?? [], assets: context.assets, projectId: context.project.id, signal: context.signal });
  if (isVideoGenerationNode(context.node) && context.pendingVideoInput) return;
  for (const shot of context.project.shots) {
    context.signal?.throwIfAborted();
    const kind = context.node.kind === 'assets' ? 'image' : 'video';
    if (shot.locked && kind === 'image' && (nativeFirstFrames || context.node.config.useFirstShotReference === true && groupsReferenceImages(context.node))) continue;
    const existing = context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === kind && asset.active);
    if (context.node.config.operation !== 'regenerate' && shot.locked && existing && await validAsset(existing)) continue;
    const plan = planVideoReferences(context, shot);
    if (plan?.frame) {
      if (!imageMimeTypes.includes(plan.frame.mimeType) || plan.frame.size > MAX_CHARACTER_REFERENCE_BYTES) throw new Error(`镜头「${shot.title}」的参考画面须为 20 MiB 以内的 PNG、JPEG 或 WebP。`);
      if (!await validAsset(plan.frame)) throw new Error(`镜头「${shot.title}」的参考画面缺失或损坏，请恢复素材或重新选择图片。`);
    } else if (context.legacyVideoReferences && kind === 'video' && context.node.config.operation === 'regenerate' && shot.assetId && singleFrameVideoModel(model, context.project)) {
      const frame = currentVideoImage(context, shot);
      if (!frame || !await validAsset(frame)) throw new Error('已确认的镜头首帧缺失或损坏，请恢复素材或重新选择首帧。');
    }
    const references = await mediaReferences(context, shot, plan);
    context.signal?.throwIfAborted();
    const referenceContext = nativeShots.has(shot.id) ? { ...context, model: { ...model, provider: 'seedream' as const } } : context;
    validateReferenceProtocol(referenceContext, shot, references, plan, anchoredShots.has(shot.id));
  }
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

async function readReceipt<T = Receipt>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return;
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function checkSequenceReceipt(receipt?: SequenceReceipt): void {
  if (receipt?.state === 'invalid') throw new Error(receipt.error);
  if (receipt?.state === 'prepared' || receipt?.state === 'unknown') throw new Error('有首帧组图的提交结果不明确，请先核对服务端任务。');
}

const imageOutputTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

function generatedImagePath(path: string, bytes: Uint8Array): string {
  const header = Buffer.from(bytes.subarray(0, 12));
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return path.replace(/\.png$/, '.jpg');
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return path.replace(/\.png$/, '.webp');
  return path;
}

async function assetFor(path: string, context: MediaActivityContext, kind: AssetRecord['kind'], shot?: Shot, video?: Pick<AssetRecord, 'width' | 'height' | 'durationUs'>): Promise<AssetRecord> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path, { signal: context.signal })) { hash.update(chunk); size += chunk.length; }
  return {
    id: `asset-${createHash('sha256').update(context.operationId + (shot?.id ?? '') + path).digest('hex').slice(0, 24)}`,
    projectId: context.project.id, shotId: shot?.id, name: path.split(/[\\/]/).at(-1) ?? '媒体', kind, path,
    mimeType: kind === 'image' ? imageOutputTypes[extname(path)] ?? 'image/png' : kind === 'video' ? 'video/mp4' : kind === 'subtitle' ? 'application/x-subrip' : 'application/json',
    size, sha256: hash.digest('hex'), version: 1,
    ...video,
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

async function downloadReceipt(path: string, receiptPath: string, receipt: Receipt, context: MediaActivityContext, kind: AssetRecord['kind'], shot: Shot, verifyImage = false): Promise<AssetRecord> {
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
  const destination = kind === 'image' ? generatedImagePath(path, bytes) : path;
  if (verifyImage) {
    const { imageDimensions } = await import('@video-quickly/video/image-tools');
    try {
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (destination === path && buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('图片格式不受支持');
      await imageDimensions(buffer);
    }
    catch (error) { throw new Error(`镜头「${shot.title}」返回的图片无法读取，请核对模型结果。`, { cause: error }); }
  }
  const temporary = `${destination}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, destination);
  context.onDiagnostic?.({ event: 'media.download_completed', level: 'info', phase: 'download', byteSize: bytes.byteLength, durationMs: performance.now() - started });
  const validationStarted = performance.now();
  context.onDiagnostic?.({ event: 'media.validation_started', level: 'info', phase: 'validate' });
  const video = kind === 'video' && isVideoGenerationNode(context.node) ? await prepareGeneratedVideo(path, context.project.profile, {
    conform: context.unifiedShotProfile, ffmpegPath: context.ffmpegPath, ffprobePath: context.ffprobePath, signal: context.signal,
  }) : undefined;
  const asset = await assetFor(destination, context, kind, shot, video);
  await atomicJson(receiptPath, { state: 'completed', attempt: receipt.attempt, taskId: receipt.taskId, asset, providerUsage: receipt.providerUsage });
  context.onDiagnostic?.({ event: 'media.validation_completed', level: 'info', phase: 'validate', assetId: asset.id, byteSize: asset.size, durationMs: performance.now() - validationStarted });
  return asset;
}

async function appendSequenceAnchor(references: ResolvedCharacterReferences, anchor: AssetRecord | undefined, signal: AbortSignal): Promise<ResolvedCharacterReferences> {
  if (!anchor) return references;
  const referenceBytes = references.images.reduce((sum, image) => sum + Buffer.byteLength(image.dataUrl.slice(image.dataUrl.indexOf(',') + 1), 'base64'), 0);
  if (!imageMimeTypes.includes(anchor.mimeType) || anchor.size > MAX_CHARACTER_REFERENCE_BYTES || referenceBytes + anchor.size > MAX_CHARACTER_REFERENCE_TOTAL_BYTES) {
    throw new Error('首镜与绑定参考图超出图片输入限制。请减小图片尺寸或减少参考图后重新开始制作。');
  }
  const bytes = await readFile(anchor.path, { signal });
  if (bytes.length !== anchor.size || createHash('sha256').update(bytes).digest('hex') !== anchor.sha256) throw new Error('首镜图片已更改，请恢复原图后继续制作。');
  return { ...references, images: [...references.images, { assetId: anchor.id, mimeType: anchor.mimeType, dataUrl: `data:${anchor.mimeType};base64,${bytes.toString('base64')}` }] };
}

function anchorPrompt(references: ResolvedCharacterReferences, anchor?: AssetRecord, useFirstShotReference = false): string {
  if (!anchor) return '';
  const image = `\n图片 ${references.images.length}`;
  return useFirstShotReference
    ? `${image} 是第一镜首帧。沿用再次出镜人物的五官、发型和服装，以及延续场景的辨识特征。出镜人物、道具状态、动作、机位与构图以当前分镜为准。`
    : `${image} 是本组首镜。沿用同一人物的五官、发型、服装和场景辨识特征。按当前分镜调整动作、机位与构图，明确指定的造型或环境变化以当前分镜为准。`;
}

function sequenceImage(item: unknown): ImageDownload | undefined {
  if (nested(item, 'error')) return;
  const base64 = stringOrUndefined(nested(item, 'b64_json'));
  if (base64?.trim()) return { base64 };
  const downloadUrl = stringOrUndefined(nested(item, 'url'));
  if (downloadUrl && URL.canParse(downloadUrl) && ['http:', 'https:'].includes(new URL(downloadUrl).protocol)) return { downloadUrl };
  return undefined;
}

async function generateSeedreamBatch(context: MediaActivityContext & { model: ModelProfile }, directory: string, shots: readonly Shot[], onUsage: (usage?: ProviderUsage) => void, anchor?: AssetRecord): Promise<AssetRecord[]> {
  const { model } = context;
  const receiptPath = sequenceReceiptPath(directory, shots);
  let receipt = await readReceipt<SequenceReceipt>(receiptPath);
  checkSequenceReceipt(receipt);
  if (receipt?.state !== 'download' && receipt?.state !== 'completed') {
    const references = await appendSequenceAnchor(await mediaReferences(context, shots[0]), anchor, context.signal);
    const settingsKey = (shot: Shot) => JSON.stringify([...(shot.creativeEntityKeys ?? [])].sort());
    const sharedSettings = settingsKey(shots[0]);
    const shotSpecific = context.promptOverride !== undefined || Object.values(context.node.promptBindings ?? {}).some(binding => 'shotPath' in binding)
      || shots.some(shot => settingsKey(shot) !== sharedSettings);
    const sharedPrompt = shotSpecific ? '' : visualPrompt(context, { ...shots[0], visualPrompt: '' }, references);
    const prompt = [
      `按下列镜头编号顺序生成恰好 ${shots.length} 张独立图片。每个镜头只对应一张完整首帧，不拼接、不添加编号和文字。保持同一人物的五官、发型和服装，画面动作、机位和环境变化遵循各镜头描述。${anchorPrompt(references, anchor)}`,
      sharedPrompt,
      ...shots.map((shot, index) => `镜头 ${index + 1}「${shot.title}」\n${shotSpecific ? visualPrompt(context, shot, references) : shot.visualPrompt}`),
    ].filter(Boolean).join('\n\n');
    const { n: _n, quality: _quality, input_fidelity: _fidelity, stream: _stream, partial_images: _partial, images: _images, image: _image,
      sequential_image_generation: _sequence, sequential_image_generation_options: _options, ...parameters } = requestModelParameters(model, 'image');
    const body = JSON.stringify({ ...parameters, model: model.model, size: imageRequestSize(model, context.project.profile), prompt,
      ...(references.images.length ? { image: references.images.map(image => image.dataUrl) } : {}),
      stream: false,
      sequential_image_generation: shots.length > 1 ? 'auto' : 'disabled',
      ...(shots.length > 1 ? { sequential_image_generation_options: { max_images: shots.length } } : {}),
    });
    const attempt = (receipt?.attempt ?? 0) + 1;
    const requestId = `${context.operationId}:${basename(receiptPath, '.receipt.json')}:${attempt}`;
    context.signal.throwIfAborted();
    await atomicJson(receiptPath, { state: 'prepared', attempt });
    let result: Record<string, unknown>;
    try {
      result = await requestJson(endpoint(model.baseUrl, 'images/generations'), context, { method: 'POST', body, headers: { 'Idempotency-Key': requestId } }, 300_000);
    } catch (error) {
      const rejected = error instanceof MediaRequestRejectedError;
      await atomicJson(receiptPath, { state: rejected ? 'rejected' : 'unknown', attempt });
      if (rejected && !error.reason && [400, 404, 422].includes(error.status)) error.message += ' 若连接使用代理，请确认其转发 Seedream 组图参数，或将首帧组图接口改为「使用首镜续图」后重新开始制作。';
      throw error;
    }
    const items: unknown[] = Array.isArray(result.data) ? result.data : [];
    const images = items.map(sequenceImage).filter(image => image !== undefined);
    if (items.length !== shots.length || images.length !== items.length) {
      const error = `首帧组图需要 ${shots.length} 张图片，服务返回 ${items.length} 项结果，其中 ${images.length} 张可用，无法按顺序分配。请核对模型或代理后重新开始制作。`;
      await atomicJson(receiptPath, { state: 'invalid', attempt, error });
      throw new Error(error);
    }
    receipt = { state: 'download', attempt, images, providerUsage: providerReportedUsage(result) };
    await atomicJson(receiptPath, receipt);
  }
  const assets: AssetRecord[] = [];
  for (const [index, shot] of shots.entries()) {
    context.signal.throwIfAborted();
    const fileId = mediaShotFileId(shot.id), shotReceiptPath = join(directory, `${fileId}.receipt.json`);
    const completed = await readReceipt(shotReceiptPath);
    if (completed?.state === 'completed' && completed.asset && await validAsset(completed.asset)) { assets.push(completed.asset); continue; }
    if (receipt.state === 'completed') throw new Error(`镜头「${shot.title}」的组图素材缺失或损坏，请显式重新生成此镜头。`);
    const shotContext = { ...context, onDiagnostic: (event: MediaDiagnosticEvent) => context.onDiagnostic?.({ ...event, shotId: shot.id }) };
    assets.push(await downloadReceipt(join(directory, `${fileId}.png`), shotReceiptPath, { state: 'download', ...receipt.images[index] }, shotContext, 'image', shot, true));
  }
  if (receipt.state === 'download') await atomicJson(receiptPath, { state: 'completed', attempt: receipt.attempt, providerUsage: receipt.providerUsage });
  onUsage(receipt.providerUsage);
  return assets;
}

async function generateMedia(context: MediaActivityContext, directory: string, shot: Shot, kind: 'image' | 'video', onUsage: (usage?: ProviderUsage) => void, sequence?: { anchor?: AssetRecord }): Promise<AssetRecord> {
  const model = context.model;
  if (!model) throw new Error('请为此步骤选择相应的生成模型，或先导入素材');
  const parameters = requestModelParameters(model, kind);
  if (kind === 'video') parameters.generate_audio = true;
  const verifyImage = kind === 'image' && (Boolean(sequence) || groupsNativeFirstFrames(context.project.workflow, context.node)
    || context.node.config.useFirstShotReference === true && groupsReferenceImages(context.node));
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
  if (receipt?.state === 'download') { const asset = await downloadReceipt(destination, receiptPath, receipt, context, kind, shot, verifyImage); onUsage(receipt.providerUsage); return asset; }
  if (receipt?.state === 'unknown' || receipt?.state === 'prepared') throw new Error('该镜头上次提交结果不明确，请核对服务端任务后再重新生成');
  const attempt = (receipt?.attempt ?? 1) + (receipt?.state === 'rejected' ? 1 : 0);
  if (receipt?.state === 'rejected') receipt = undefined;
  const requestId = `${context.operationId}:${shot.id}${attempt > 1 ? `:attempt:${attempt}` : ''}`;

  const plan = planVideoReferences(context, shot);
  const anchor = sequence?.anchor;
  const references = await appendSequenceAnchor(await mediaReferences(context, shot, plan), anchor, context.signal);
  const imageEdit = await resolveImageEdit(context);
  validateReferenceProtocol(context, shot, references, plan);
  const prompt = visualPrompt(context, shot, references, plan) + anchorPrompt(references, anchor, context.node.config.useFirstShotReference === true);
  const adjustment = context.node.config.operation === 'regenerate' && typeof context.node.config.instruction === 'string' ? context.node.config.instruction : '';
  const instruction = context.node.prompt.trim().endsWith(adjustment.trim()) ? context.node.prompt : [context.node.prompt, adjustment].filter(Boolean).join('\n');

  // Local file and request-size failures remain retryable before recording a submission.
  const seedanceBody = !receipt && kind === 'video' && model.provider === 'seedance'
    ? await seedanceVideoBody({ ...context, model }, shot, references, parameters, plan, preparedContext => visualPrompt(preparedContext, shot, references, plan))
    : '';
  const openAiFrame = !receipt && kind === 'video' && model.provider === 'openai-compatible' ? (plan ? plan.frame : currentVideoImage(context, shot)) : undefined;
  const openAiFrameBytes = openAiFrame ? await videoFrameBytes(openAiFrame, Boolean(plan)) : undefined;
  const mappedFrame = !receipt && (model.provider === 'custom-http' || model.provider === 'comfyui') ? plan?.frame : undefined;
  const mappedImages = references.images.map(image => image.dataUrl);
  if (mappedFrame && !plan?.referenceIds.includes(mappedFrame.id)) mappedImages.push(`data:${mappedFrame.mimeType};base64,${(await videoFrameBytes(mappedFrame, true)).toString('base64')}`);
  if (!receipt) {
    receipt = { state: 'prepared', attempt };
    await atomicJson(receiptPath, receipt);
    try {
      const request = mediaSubmissionRequest({ context, model, shot, kind, requestId, parameters, prompt, instruction,
        references, imageEdit, mappedImages, seedanceBody, openAiFrame, openAiFrameBytes });
      const submission = request.parse(await requestJson(request.url, context, request.init));
      receipt = submission.receipt;
      if (submission.taskIdToPersist !== undefined) context.persistRemoteTask(submission.taskIdToPersist);
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
        const request = mediaPollRequest(model, receipt.taskId!);
        const result = request.parse(await requestJson(request.url, pollContext, request.init));
        receipt.providerUsage = result.providerUsage ?? receipt.providerUsage;
        if (result.error) throw new Error(result.error);
        remoteStatus = result.remoteStatus;
        completed = result.downloadUrl;
        if (result.authenticatedContent) receipt.authenticatedContent = true;
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
  const asset = await downloadReceipt(destination, receiptPath, receipt, context, kind, shot, verifyImage);
  onUsage(receipt.providerUsage);
  return asset;
}

export function createActivityExecutor(options: { ffmpegPath?: string } = {}) {
  const requests = new MediaRequestQueue();
  return async (context: MediaActivityContext): Promise<JsonValue> => {
    const ffmpeg = options.ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG;
    context = { ...context, model: mediaRequestModel(context), ffmpegPath: ffmpeg, ffprobePath: process.env.VIDEO_QUICKLY_FFPROBE ?? (ffmpeg ? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : undefined) };
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
    // Media receipts own ambiguous submit recovery; allow the parent graph
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
        assetFor(output.subtitlePath, context, 'subtitle'),
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
      return { assets: assets as unknown as JsonValue, videoPath, coverPath: output.coverPath, subtitlePath: output.subtitlePath, warnings: output.warnings };
    }
    const kind = context.node.kind === 'assets' ? 'image' : 'video';
    if (!context.model) {
      const assets = context.project.shots.map(shot => context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === kind && asset.active));
      if (assets.some(asset => !asset)) throw new Error(`请为每个镜头导入${'画面'}素材，或为此步骤选择模型`);
      for (const asset of assets) if (asset && !(await validAsset(asset))) throw new Error('已引用素材缺失或损坏，请重新导入');
      return { assets: assets as unknown as JsonValue, source: 'imported' };
    }
    const usages: Array<ProviderUsage | undefined> = [];
    const model = context.model;
    const regenerating = context.node.config.operation === 'regenerate';
    if (regenerating && (context.project.shots.length !== 1 || context.project.shots[0].id !== context.node.config.shotId || context.project.shots[0].locked)) throw new Error('重新生成须仅包含一个未锁定的目标镜头。');
    const sequences = planReferenceImageSequences(context);
    const assets: AssetRecord[] = [];
    const queueSignal = context.queueSignal ? AbortSignal.any([context.signal, context.queueSignal]) : context.signal;
    for (const { batches, seedream } of sequences) {
      let anchor: AssetRecord | undefined;
      for (const batch of batches) {
        queueSignal.throwIfAborted();
        const shot = batch[0];
        let phase: MediaDiagnosticEvent['phase'] = 'queue';
        const diagnostic = (event: MediaDiagnosticEvent) => {
          phase = event.phase ?? phase;
          if (event.shotId) context.onDiagnostic?.(event);
          else for (const member of batch) context.onDiagnostic?.({ ...event, shotId: member.id });
        };
        if (!regenerating && shot.locked) {
          const existing = context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === kind && asset.active);
          if (existing && await validAsset(existing)) {
            assets.push(existing); context.onAsset?.(existing);
            diagnostic({ event: 'media.reused', level: 'info', cached: true, assetId: existing.id });
            continue;
          }
        }
        const instruction = regenerating && typeof context.node.config.instruction === 'string' ? context.node.config.instruction : '';
        const generationShot = instruction && !context.node.prompt.trim().endsWith(instruction.trim()) ? { ...shot, visualPrompt: `${shot.visualPrompt}\n\n本次调整要求：${instruction}` } : shot;
        const queued = performance.now(); let started: number | undefined;
        diagnostic({ event: 'media.queued', level: 'info', phase: 'queue' });
        try {
          const batchAssets = await requests.run(model.id, queueSignal, async () => {
            const generationContext = { ...context, model, onDiagnostic: diagnostic };
            started = performance.now();
            diagnostic({ event: 'media.started', level: 'info', phase: 'generate', queueMs: started - queued });
            try {
              const onUsage = (usage?: ProviderUsage) => usages.push(usage);
              const generated = seedream ? await generateSeedreamBatch(generationContext, directory, batch, onUsage, anchor)
                : [await generateMedia(generationContext, directory, generationShot, kind, onUsage, anchor || batches.length > 1 ? { anchor } : undefined)];
              for (const asset of generated) {
                context.onAsset?.(asset);
                diagnostic({ event: 'media.completed', level: 'info', phase: 'generate', shotId: asset.shotId, assetId: asset.id, byteSize: asset.size, durationMs: performance.now() - started });
              }
              return generated;
            } catch (error) { context.onFailure?.(error); throw error; }
          });
          assets.push(...batchAssets);
          anchor ??= batchAssets[0];
        } catch (error) {
          const canceled = context.signal.aborted || started === undefined && queueSignal.aborted;
          diagnostic({ event: canceled ? 'media.canceled' : 'media.failed', level: canceled ? 'warn' : 'error', phase, durationMs: performance.now() - (started ?? queued), error });
          throw error;
        }
      }
    }
    const usage = sumProviderUsage(usages);
    return { assets: assets as unknown as JsonValue, source: 'model', modelId: model.id, ...(usage ? { providerUsage: usage as unknown as JsonValue } : {}) };
  };
}
