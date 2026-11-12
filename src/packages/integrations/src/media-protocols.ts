import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { defaultVideoRequestSeconds, isVideoGenerationNode, providerReportedUsage, seedreamSingleImageV5, usesVideoSceneImage, videoAspectRatioPreset,
  type AssetRecord, type JsonValue, type ModelProfile, type ProjectDocument, type ProviderUsage, type Shot, type VideoReferenceImages,
} from '@video-quickly/contracts';
import { resolveReferenceAudio } from './audio-references.js';
import type { ResolvedCharacterReferences } from './character-references.js';
import type { resolveImageEdit } from './image-edit.js';
import type { MediaActivityContext, MediaDiagnosticEvent } from './media-context.js';
import { endpoint, nested, objectSchema, stringOrUndefined } from './media-http.js';

interface ProtocolRequest<Result> {
  url: string;
  init?: RequestInit;
  parse(payload: Record<string, unknown>): Result;
}

interface MediaSubmission {
  receipt: { state: 'submitted'; taskId: string; providerUsage?: ProviderUsage }
    | { state: 'download'; downloadUrl?: string; base64?: string; providerUsage?: ProviderUsage };
  taskIdToPersist?: string;
}

interface MediaSubmissionInput {
  context: MediaActivityContext;
  model: ModelProfile;
  shot: Shot;
  kind: 'image' | 'video';
  requestId: string;
  parameters: Record<string, JsonValue>;
  prompt: string;
  instruction: string;
  references: ResolvedCharacterReferences;
  imageEdit: Awaited<ReturnType<typeof resolveImageEdit>>;
  mappedImages: string[];
  seedanceBody: string;
  openAiFrame?: AssetRecord;
  openAiFrameBytes?: Buffer<ArrayBuffer>;
}

interface MediaPollResult {
  downloadUrl?: string;
  remoteStatus?: MediaDiagnosticEvent['remoteStatus'];
  providerUsage?: ProviderUsage;
  authenticatedContent?: true;
  error?: string;
}

const atPath = (value: unknown, path: unknown): unknown => typeof path === 'string' ? nested(value, ...path.split('.')) : undefined;

function generationStatus(value: unknown): MediaDiagnosticEvent['remoteStatus'] {
  if (['queued', 'pending', 'submitted'].includes(String(value))) return 'queued';
  if (['running', 'in_progress', 'processing', 'generating'].includes(String(value))) return 'generating';
  return undefined;
}

function customHttpSubmission({ context, model, shot, kind, requestId, prompt, instruction, mappedImages }: MediaSubmissionInput): ProtocolRequest<MediaSubmission> {
  const requestPath = z.string().min(1).parse(model.parameters.requestPath);
  const template = model.parameters.requestTemplate;
  if (template === undefined) throw new Error('请为自定义 HTTP 模型配置 requestTemplate');
  const { width, height, frameRate } = context.project.profile;
  return {
    url: endpoint(model.baseUrl, requestPath),
    init: {
      method: 'POST', headers: { 'Idempotency-Key': requestId },
      body: JSON.stringify(fillTemplate(template, {
        prompt, character_images: mappedImages, narration: shot.narration, instruction, model: model.model, width, height, duration: shot.durationUs / 1_000_000,
        ...(context.unifiedShotProfile && kind === 'video' ? { fps: frameRate.numerator / frameRate.denominator } : {}),
      })),
    },
    parse(result) {
      const taskId = stringOrUndefined(atPath(result, model.parameters.taskIdPath));
      const receipt: MediaSubmission['receipt'] = taskId ? { state: 'submitted', taskId } : {
        state: 'download',
        downloadUrl: stringOrUndefined(atPath(result, model.parameters.resultUrlPath)),
        base64: stringOrUndefined(atPath(result, model.parameters.resultBase64Path)),
      };
      receipt.providerUsage = providerReportedUsage(result);
      return { receipt };
    },
  };
}

function imageSubmission({ context, model, requestId, parameters, prompt, references, imageEdit }: MediaSubmissionInput): ProtocolRequest<MediaSubmission> {
  const imageParameters: Record<string, JsonValue> = { ...parameters, model: model.model, prompt, size: imageRequestSize(model, context.project.profile) };
  if (typeof context.node.config.groupReferenceImages === 'boolean') for (const key of ['sequential_image_generation', 'sequential_image_generation_options', 'stream', 'partial_images']) delete imageParameters[key];
  if (model.provider === 'seedream') delete imageParameters.n;
  else imageParameters.n = 1;
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
  return {
    url: endpoint(model.baseUrl, editing || imageEdit ? 'images/edits' : 'images/generations'),
    init: { method: 'POST', body: requestBody, headers: { 'Idempotency-Key': requestId } },
    parse(result) {
      const first = Array.isArray(result.data) ? objectSchema.parse(result.data[0]) : undefined;
      return { receipt: { state: 'download', downloadUrl: stringOrUndefined(first?.url), base64: stringOrUndefined(first?.b64_json), providerUsage: providerReportedUsage(result) } };
    },
  };
}

function comfyVideoSubmission({ context, model, shot, requestId, prompt, mappedImages }: MediaSubmissionInput): ProtocolRequest<MediaSubmission> {
  const workflow = comfyVideoPrompt(context, shot, prompt, mappedImages);
  return {
    url: endpoint(model.baseUrl, 'prompt'),
    init: { method: 'POST', body: JSON.stringify({ prompt: workflow, client_id: requestId }) },
    parse(result) {
      const taskId = z.string().parse(result.prompt_id);
      return { receipt: { state: 'submitted', taskId, providerUsage: providerReportedUsage(result) }, taskIdToPersist: taskId };
    },
  };
}

function videoSubmission({ context, model, shot, requestId, parameters, prompt, references, seedanceBody, openAiFrame, openAiFrameBytes }: MediaSubmissionInput): ProtocolRequest<MediaSubmission> {
  const seedance = model.provider === 'seedance';
  let body: string | FormData = seedanceBody;
  if (!seedance) {
    const form = formParameters(parameters);
    form.set('model', model.model); form.set('prompt', prompt);
    form.set('seconds', String(parameters.seconds ?? defaultVideoRequestSeconds(model.model, shot.durationUs)));
    form.set('size', String(parameters.size ?? `${context.project.profile.width}x${context.project.profile.height}`));
    if (openAiFrame && openAiFrameBytes) form.set('input_reference', new Blob([openAiFrameBytes], { type: openAiFrame.mimeType }), `reference${extname(openAiFrame.path)}`);
    else if (references.images[0]) form.set('input_reference', referenceBlob(references.images[0].dataUrl, references.images[0].mimeType), 'character-reference.png');
    body = form;
  }
  return {
    url: endpoint(model.baseUrl, seedance ? 'contents/generations/tasks' : 'videos'),
    init: { method: 'POST', headers: { 'Idempotency-Key': requestId }, body },
    parse(result) {
      const taskId = z.string().parse(result.id ?? result.task_id);
      return { receipt: { state: 'submitted', taskId, providerUsage: providerReportedUsage(result) }, taskIdToPersist: taskId };
    },
  };
}

export function mediaSubmissionRequest(input: MediaSubmissionInput): ProtocolRequest<MediaSubmission> {
  if (input.model.provider === 'custom-http') return customHttpSubmission(input);
  if (input.kind === 'image') return imageSubmission(input);
  if (input.model.provider === 'comfyui') return comfyVideoSubmission(input);
  if (input.kind === 'video') return videoSubmission(input);
  throw new Error('该服务协议尚不支持此素材类型');
}

function customHttpPoll(model: ModelProfile, taskId: string): ProtocolRequest<MediaPollResult> {
  const pollPath = z.string().min(1).parse(model.parameters.pollPath).replaceAll('{{taskId}}', encodeURIComponent(taskId));
  return {
    url: endpoint(model.baseUrl, pollPath),
    parse(result) {
      const providerUsage = providerReportedUsage(result);
      const status = atPath(result, model.parameters.statusPath);
      const remoteStatus = generationStatus(status);
      if (['failed', 'canceled', 'cancelled', 'expired', 'error'].includes(String(status))) {
        return { providerUsage, remoteStatus, error: '模型任务失败，请核对服务端任务记录' };
      }
      return { providerUsage, remoteStatus, downloadUrl: stringOrUndefined(atPath(result, model.parameters.resultUrlPath)) };
    },
  };
}

function comfyVideoPoll(model: ModelProfile, taskId: string): ProtocolRequest<MediaPollResult> {
  return {
    url: endpoint(model.baseUrl, `history/${encodeURIComponent(taskId)}`),
    parse(history) {
      const item = nested(history, taskId);
      if (nested(item, 'status', 'status_str') === 'error') return { error: 'ComfyUI 工作流失败，请检查任务记录' };
      const outputs = nested(item, 'outputs');
      if (outputs && typeof outputs === 'object') {
        for (const output of Object.values(outputs)) {
          const files = nested(output, 'gifs');
          if (Array.isArray(files) && files[0]) {
            const file = objectSchema.parse(files[0]);
            const query = new URLSearchParams({ filename: z.string().parse(file.filename), subfolder: stringOrUndefined(file.subfolder) ?? '', type: stringOrUndefined(file.type) ?? 'output' });
            return { downloadUrl: endpoint(model.baseUrl, `view?${query}`) };
          }
        }
      }
      return {};
    },
  };
}

function videoPoll(model: ModelProfile, taskId: string): ProtocolRequest<MediaPollResult> {
  return {
    url: endpoint(model.baseUrl, `${model.provider === 'seedance' ? 'contents/generations/tasks' : 'videos'}/${encodeURIComponent(taskId)}`),
    parse(result) {
      const providerUsage = providerReportedUsage(result);
      const status = result.status;
      const remoteStatus = generationStatus(status);
      if (['failed', 'canceled', 'cancelled', 'expired'].includes(String(status))) {
        return { providerUsage, remoteStatus, error: '视频任务未完成，请检查服务端任务状态' };
      }
      const downloadUrl = stringOrUndefined(nested(result, 'content', 'video_url')) ?? stringOrUndefined(result.url) ?? stringOrUndefined(nested(result, 'output', 'url'));
      if (!downloadUrl && status === 'completed' && model.provider === 'openai-compatible') {
        return { providerUsage, remoteStatus, downloadUrl: endpoint(model.baseUrl, `videos/${encodeURIComponent(taskId)}/content`), authenticatedContent: true };
      }
      if (!downloadUrl && ['succeeded', 'completed'].includes(String(status))) {
        return { providerUsage, remoteStatus, error: '生成任务已完成，但该服务未返回支持的结果地址，请配置自定义响应映射' };
      }
      return { providerUsage, remoteStatus, downloadUrl };
    },
  };
}

export function mediaPollRequest(model: ModelProfile, taskId: string): ProtocolRequest<MediaPollResult> {
  if (model.provider === 'custom-http') return customHttpPoll(model, taskId);
  if (model.provider === 'comfyui') return comfyVideoPoll(model, taskId);
  return videoPoll(model, taskId);
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

function comfyVideoPrompt(context: MediaActivityContext, shot: Shot, prompt: string, images: string[]): Record<string, unknown> {
  const model = context.model!;
  const workflow = structuredClone(objectSchema.parse(model.parameters.workflow));
  const { width, height, frameRate } = context.project.profile;
  const values: Record<string, JsonValue> = {
    prompt, narration: shot.narration,
    character_images: images,
    width, height,
    ...(context.unifiedShotProfile && isVideoGenerationNode(context.node) ? { fps: frameRate.numerator / frameRate.denominator } : {}),
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

export function imageRequestSize(model: ModelProfile, profile: ProjectDocument['profile']): JsonValue {
  const configured = model.parameters.size;
  const version = /seedream[-_.](?:image[-_.])?v?(4[-_.][05]|5[-_.]0)(?:[-_.]|$)/i.exec(model.model)?.[1];
  if (!version) {
    // GPT Image chooses a supported canvas independently of the export profile.
    return configured ?? (model.provider === 'openai-compatible' && (model.model.startsWith('gpt-image-') || model.model === 'chatgpt-image-latest') ? 'auto' : `${profile.width}x${profile.height}`);
  }
  const singleImageV5 = seedreamSingleImageV5.test(model.model);
  const v4 = version.startsWith('4'), v40 = v4 && version.endsWith('0');
  const presets = singleImageV5 ? ['1K', '1.5K', '2K'] : v4 ? (v40 ? ['1K', '2K', '4K'] : ['2K', '4K']) : ['2K', '3K', '4K'];
  if (typeof configured === 'string' && presets.includes(configured)) return configured;
  const minimumPixels = singleImageV5 || v40 ? 921_600 : 3_686_400;
  const maximumPixels = singleImageV5 ? 4_624_220 : 16_777_216;
  let width = profile.width, height = profile.height;
  if (configured !== undefined) {
    const dimensions = typeof configured === 'string' && /^(\d+)x(\d+)$/.exec(configured);
    if (!dimensions) throw new Error(`Seedream 的图片尺寸 size 须填写宽x高，或使用 ${presets.join('、')}。`);
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
    throw new Error(`图片尺寸 size=${width}x${height} 不符合该 Seedream 型号要求：总像素须为 ${minimumPixels.toLocaleString('en-US')}–${maximumPixels.toLocaleString('en-US')}，宽高比须为 1:16–16:1。`);
  }
  return `${width}x${height}`;
}

function formParameters(parameters: Record<string, JsonValue>): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(parameters)) form.set(key, value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));
  return form;
}
function referenceBlob(dataUrl: string, mimeType: string): Blob { return new Blob([Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')], { type: mimeType }); }

export function currentVideoImage(context: Pick<MediaActivityContext, 'project' | 'node' | 'assets' | 'model' | 'characters'>, shot: Shot): AssetRecord | undefined {
  if (isVideoGenerationNode(context.node) && !usesVideoSceneImage(context.project, context.node, context.model, shot, context.characters)) return;
  return context.assets.find(asset => asset.id === shot.assetId && asset.kind === 'image' && asset.active)
    ?? (context.node.config.operation === 'regenerate' ? undefined : context.assets.find(asset => asset.projectId === context.project.id && asset.shotId === shot.id && asset.kind === 'image' && asset.active));
}

function seedanceProjectResolution(modelId: string, shortSide: number): string | undefined {
  if (shortSide < 480) return undefined;
  if (shortSide < 720) return '480p';
  if (shortSide < 1080) return '720p';
  // Above 720p, only infer tiers for model IDs with documented support.
  const standard20 = /^doubao-seedance-2-0(?:-\d+)?$/i.test(modelId);
  if (standard20 && shortSide >= 2160) return '4k';
  if (standard20 || /^doubao-seedance-(?:2-5|1-[05]-pro(?:-fast)?)(?:-\d+)?$/i.test(modelId)) return '1080p';
  if (/^doubao-seedance-2-0-(?:fast|mini)(?:-\d+)?$/i.test(modelId)) return '720p';
  return undefined;
}

export async function videoFrameBytes(frame: AssetRecord, verify: boolean) {
  const bytes = await readFile(frame.path);
  if (verify && (bytes.length !== frame.size || createHash('sha256').update(bytes).digest('hex') !== frame.sha256)) throw new Error('镜头参考画面内容已变化，请恢复素材后重新生成。');
  return bytes;
}

export async function seedanceVideoBody(context: MediaActivityContext & { model: ModelProfile }, shot: Shot, references: ResolvedCharacterReferences, parameters: Record<string, JsonValue>, plan: VideoReferenceImages | undefined, buildPrompt: (context: MediaActivityContext) => string): Promise<string> {
  const audio = await resolveReferenceAudio({ assetIds: context.project.workflow.production.referenceAudioAssetIds ?? [], assets: context.assets, projectId: context.project.id, signal: context.signal });
  const image = plan ? plan.frame : currentVideoImage(context, shot);
  const imageUrl = image && !plan?.referenceIds.includes(image.id) ? `data:${image.mimeType};base64,${(await videoFrameBytes(image, Boolean(plan))).toString('base64')}` : undefined;
  const multimodal = audio.length > 0 || (plan ? plan.mode === 'multiple' : references.images.length > 0 && context.model.parameters.characterReferenceMode === 'reference_image');
  const images = [...references.images.map(reference => reference.dataUrl), ...(imageUrl ? [imageUrl] : [])];
  const prompt = buildPrompt(context);
  const { width, height } = context.project.profile;
  const targetRatio = videoAspectRatioPreset(width, height)?.label;
  const adaptiveFirstFrame = images.length > 0 && !multimodal && /seedance[-_.]?2[._-]?5/i.test(context.model.model);
  const ratio = parameters.ratio ?? (adaptiveFirstFrame || targetRatio === '4:5' ? 'adaptive' : targetRatio ?? 'adaptive');
  const resolution = parameters.resolution ?? (parameters.draft === true ? undefined : seedanceProjectResolution(context.model.model, Math.min(width, height)));
  const body = JSON.stringify({ ...parameters, model: context.model.model, content: [
    { type: 'text', text: prompt },
    ...images.map(url => ({ type: 'image_url', image_url: { url }, role: multimodal ? 'reference_image' : 'first_frame' })),
    ...audio.map(reference => ({ type: 'audio_url', audio_url: { url: reference.dataUrl }, role: 'reference_audio' })),
  ], duration: parameters.duration ?? defaultVideoRequestSeconds(context.model.model, shot.durationUs), ratio, resolution });
  if (Buffer.byteLength(body) > 64_000_000) throw new Error('参考素材与提示词编码后超过 64 MB 请求限制，请压缩或减少素材。');
  return body;
}
