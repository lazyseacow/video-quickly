import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { audioLevelWindowSchema, audioMixSettingsSchema, audioProcessingSchema, DEFAULT_AUDIO_MIX_SETTINGS, DEFAULT_AUDIO_PROCESSING, preparedAudioMixSchema, silenceDetectionSchema, type AssetRecord, type AudioLevelWindow, type PreparedAudioMix, type ProjectDocument, type Shot, type SilenceDetection } from '@video-quickly/contracts';
import { clipEditSource, resolveShotSpans } from './clip-edits.js';
import { audioMixProjection, AUDIO_MIX_ALGORITHM } from './audio-projection.js';
import { probeMedia, runMedia, runMediaCapture } from './media-process.js';

const ALGORITHM = AUDIO_MIX_ALGORITHM;
const SAMPLE_RATE = 48_000, WINDOW_SAMPLES = 480, LEVEL_BYTES = 16, CHUNK_WINDOWS = 6000;
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sampleAt = (us: number) => Math.round(us * SAMPLE_RATE / 1_000_000);
const mixDuration = (project: Pick<ProjectDocument, 'shots'>) => project.shots.reduce((sum, shot) => sum + shot.durationUs, 0);

export interface PrepareAudioMixOptions {
  project: ProjectDocument; assets: readonly AssetRecord[]; outputDirectory: string;
  ffmpegPath?: string; ffprobePath?: string; signal?: AbortSignal; onProgress?: (value: number) => void;
}

function audioAsset(id: string, projectId: string, assets: readonly AssetRecord[], label = '音频'): AssetRecord {
  const asset = assets.find(value => value.id === id);
  if (!asset || asset.kind !== 'audio' || !asset.active || (asset.projectId !== undefined && asset.projectId !== projectId)) throw new Error(`${label}必须引用当前项目或共享素材库中的有效音频。`);
  return asset;
}

export function audioMixProjectionKey(project: ProjectDocument, assets: readonly AssetRecord[]): string { return digest(audioMixProjection(project, assets)); }

async function fileHash(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  signal?.throwIfAborted(); return hash.digest('hex');
}

async function verifyAudio(asset: AssetRecord, signal?: AbortSignal) {
  if (await fileHash(asset.path, signal) !== asset.sha256) throw new Error(`素材“${asset.name}”校验失败，请重新导入文件。`);
}

/** Resolve legacy full-recording lengths once, shared by preview metadata and the video renderer. */
export async function resolveAudioProject(options: PrepareAudioMixOptions): Promise<ProjectDocument> {
  const ffprobe = options.ffprobePath ?? process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(options.ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg'), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const durations = new Map<string, number>();
  const shots: Shot[] = [];
  for (const shot of options.project.shots) {
    let durationUs = shot.durationUs;
    if (shot.audioAssetId && !shot.clipEdit && shot.sourceInUs === undefined && shot.audioInUs === undefined) {
      const asset = audioAsset(shot.audioAssetId, options.project.id, options.assets);
      let duration = durations.get(asset.id);
      if (duration === undefined) {
        await verifyAudio(asset, options.signal);
        const metadata = await probeMedia(asset.path, ffprobe, options.signal);
        if (!metadata.audio) throw new Error(`“${asset.name}”没有音轨。`);
        duration = Math.ceil((metadata.audioDuration ?? metadata.duration) * 1_000_000); durations.set(asset.id, duration);
      }
      durationUs = Math.max(durationUs, duration);
    }
    shots.push({ ...shot, durationUs });
  }
  return { ...options.project, shots };
}

interface MixManifest { result: PreparedAudioMix; levels: { count: number; chunks: string[] } }
function parseManifest(value: unknown): MixManifest {
  if (!value || typeof value !== 'object' || !('result' in value) || !('levels' in value) || !value.levels || typeof value.levels !== 'object' || !('count' in value.levels) || !('chunks' in value.levels)) throw new SyntaxError('无效混音缓存。');
  const result = preparedAudioMixSchema.parse(value.result), count = audioLevelWindowSchema.shape.startUs.parse(value.levels.count), chunks = preparedAudioMixSchema.shape.sha256.array().parse(value.levels.chunks);
  if (chunks.length !== Math.ceil(count / CHUNK_WINDOWS) || count !== Math.ceil(sampleAt(result.durationUs) / WINDOW_SAMPLES)) throw new SyntaxError('无效电平缓存。');
  return { result, levels: { count, chunks } };
}
const manifestPath = (path: string) => `${path}.json`;
const levelsPath = (path: string) => `${path}.levels`;

async function cached(path: string, key: string, signal?: AbortSignal): Promise<PreparedAudioMix | undefined> {
  try {
    const manifest = parseManifest(JSON.parse(await readFile(manifestPath(path), 'utf8')));
    if (manifest.result.key !== key || manifest.result.path !== path || await fileHash(path, signal) !== manifest.result.sha256) return undefined;
    const handle = await open(levelsPath(path), 'r');
    try {
      if ((await handle.stat()).size !== manifest.levels.count * LEVEL_BYTES) return undefined;
      for (let index = 0; index < manifest.levels.chunks.length; index++) {
        const count = Math.min(CHUNK_WINDOWS, manifest.levels.count - index * CHUNK_WINDOWS), bytes = Buffer.alloc(count * LEVEL_BYTES);
        const read = await handle.read(bytes, 0, bytes.length, index * CHUNK_WINDOWS * LEVEL_BYTES);
        if (read.bytesRead !== bytes.length || digest(bytes) !== manifest.levels.chunks[index]) return undefined;
      }
    } finally { await handle.close(); }
    return manifest.result;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error && error.name === 'ZodError' || error instanceof SyntaxError || error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function loudnessStats(stderr: string): Record<string, string> {
  const start = stderr.lastIndexOf('{'), end = stderr.indexOf('}', start);
  if (start < 0 || end < 0) throw new Error('响度分析未返回测量结果。');
  const value: unknown = JSON.parse(stderr.slice(start, end + 1));
  if (!value || typeof value !== 'object' || Object.values(value).some(item => typeof item !== 'string')) throw new Error('响度分析数据无效。');
  return value as Record<string, string>;
}
async function measure(path: string, ffmpeg: string, signal?: AbortSignal, target = DEFAULT_AUDIO_MIX_SETTINGS.loudness) {
  const result = await runMediaCapture(ffmpeg, ['-nostdin', '-hide_banner', '-i', path, '-af', `loudnorm=I=${target.targetLufs}:TP=${target.truePeakDb}:LRA=11:print_format=json`, '-f', 'null', '-'], { signal });
  return loudnessStats(result.stderr);
}

async function buildLevels(pcmPath: string, outputPath: string, signal?: AbortSignal): Promise<MixManifest['levels']> {
  const handle = await open(outputPath, 'w'), chunks: string[] = [];
  let remainder = Buffer.alloc(0), peakLeft = 0, peakRight = 0, squaresLeft = 0, squaresRight = 0, samples = 0, count = 0;
  let block = Buffer.alloc(CHUNK_WINDOWS * LEVEL_BYTES), blockCount = 0;
  async function flush() {
    if (!blockCount) return;
    const bytes = block.subarray(0, blockCount * LEVEL_BYTES); await handle.write(bytes); chunks.push(digest(bytes));
    block = Buffer.alloc(CHUNK_WINDOWS * LEVEL_BYTES); blockCount = 0;
  }
  async function window() {
    const offset = blockCount * LEVEL_BYTES;
    block.writeFloatLE(peakLeft, offset); block.writeFloatLE(peakRight, offset + 4);
    block.writeFloatLE(Math.sqrt(squaresLeft / samples), offset + 8); block.writeFloatLE(Math.sqrt(squaresRight / samples), offset + 12);
    peakLeft = peakRight = squaresLeft = squaresRight = samples = 0; count++; blockCount++;
    if (blockCount === CHUNK_WINDOWS) await flush();
  }
  try {
    for await (const chunk of createReadStream(pcmPath, { signal })) {
      const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk, end = bytes.length - bytes.length % 8;
      for (let offset = 0; offset < end; offset += 8) {
        const left = bytes.readFloatLE(offset), right = bytes.readFloatLE(offset + 4);
        if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error('混音包含无效采样。');
        peakLeft = Math.max(peakLeft, Math.abs(left)); peakRight = Math.max(peakRight, Math.abs(right)); squaresLeft += left * left; squaresRight += right * right; samples++;
        if (samples === WINDOW_SAMPLES) await window();
      }
      remainder = Buffer.from(bytes.subarray(end));
    }
    if (remainder.length) throw new Error('混音采样长度无效。');
    if (samples) await window(); await flush();
  } finally { await handle.close(); }
  return { count, chunks };
}

async function prepare(options: PrepareAudioMixOptions, key: string): Promise<PreparedAudioMix> {
  const ffmpeg = options.ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
  const ffprobe = options.ffprobePath ?? process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const signal = options.signal;
  const project = await resolveAudioProject({ ...options, ffprobePath: ffprobe });
  const durationUs = mixDuration(project);
  if (durationUs <= 0) throw new Error('请先添加镜头，再准备声音。');
  const voices = project.shots.filter(shot => shot.audioAssetId).map(shot => audioAsset(shot.audioAssetId!, project.id, options.assets));
  const music = (project.musicClips ?? []).filter(clip => clip.startUs < durationUs).map(clip => ({ clip, asset: audioAsset(clip.assetId, project.id, options.assets, '背景音乐') }));
  const used = [...new Map([...voices, ...music.map(value => value.asset)].map(asset => [asset.id, asset])).values()];
  for (const asset of used) await verifyAudio(asset, signal);
  for (const shot of project.shots) {
    const source = clipEditSource(shot, project), frozen = source?.assetHashes.find(value => value.assetId === shot.audioAssetId);
    if (frozen && frozen.sha256 !== audioAsset(frozen.assetId, project.id, options.assets).sha256) throw new Error('剪辑来源音频已变化，请恢复原素材或重新建立剪辑。');
  }
  await mkdir(options.outputDirectory, { recursive: true });
  const path = join(options.outputDirectory, `mix-${key}.wav`), hit = await cached(path, key, signal);
  if (hit) { for (const asset of used) await verifyAudio(asset, signal); options.onProgress?.(1); return hit; }
  const temporary = await mkdtemp(join(options.outputDirectory, '.mix-'));
  const totalSamples = sampleAt(durationUs), settings = audioMixSettingsSchema.parse(project.audioMix ?? DEFAULT_AUDIO_MIX_SETTINGS), warnings: string[] = [];
  const stems = new Map<string, { path: string; samples: number }>();
  async function stem(asset: AssetRecord, denoise: boolean, reduction: number) {
    const stemKey = digest(JSON.stringify([asset.sha256, denoise, denoise ? reduction : 0, ALGORITHM]));
    const found = stems.get(stemKey); if (found) return found;
    const output = join(options.outputDirectory, `source-${stemKey}.wav`), metadataPath = `${output}.json`;
    try {
      const saved: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (saved && typeof saved === 'object' && 'sha256' in saved && 'samples' in saved && typeof saved.samples === 'number' && Number.isSafeInteger(saved.samples) && saved.samples > 0 && saved.sha256 === await fileHash(output, signal)) {
        const result = { path: output, samples: saved.samples }; stems.set(stemKey, result); return result;
      }
    } catch (error) { signal?.throwIfAborted(); if (!(error instanceof SyntaxError || error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const pending = join(temporary, `source-${stemKey}.wav`);
    const filters = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', ...(denoise ? [`afftdn=nr=${reduction}:nf=-50`] : [])];
    await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', asset.path, '-map', '0:a:0', '-vn', '-af', filters.join(','), '-c:a', 'pcm_f32le', pending], { signal });
    const metadata = await probeMedia(pending, ffprobe, signal), result = { path: output, samples: Math.round((metadata.audioDuration ?? metadata.duration) * SAMPLE_RATE) };
    const pendingMetadata = join(temporary, `source-${stemKey}.json`); await writeFile(pendingMetadata, JSON.stringify({ samples: result.samples, sha256: await fileHash(pending, signal) }));
    await rename(pending, output); await rename(pendingMetadata, metadataPath);
    stems.set(stemKey, result); return result;
  }
  try {
    const voiceFiles: string[] = []; let cursorUs = 0;
    for (const [index, shot] of project.shots.entries()) {
      const output = join(temporary, `voice-${index}.wav`), processing = audioProcessingSchema.parse(shot.audioProcessing ?? DEFAULT_AUDIO_PROCESSING);
      const source = shot.audioAssetId ? await stem(audioAsset(shot.audioAssetId, project.id, options.assets), processing.denoise, processing.noiseReductionDb) : undefined;
      if (!source) warnings.push(`“${shot.title}”尚未添加配音，本镜头使用静音音轨。`);
      const spans = resolveShotSpans(shot, project), args = ['-nostdin', '-v', 'error', '-y'];
      if (source) args.push('-i', source.path);
      const filters: string[] = [], labels: string[] = [];
      for (const [part, span] of spans.entries()) {
        const count = sampleAt(cursorUs + span.outputEndUs) - sampleAt(cursorUs + span.outputStartUs), first = sampleAt(span.audioInUs), label = `s${part}`;
        if (count <= 0) continue;
        const input = source && first < source.samples ? `[0:a]atrim=start_sample=${first}:end_sample=${first + count}` : 'anullsrc=r=48000:cl=stereo';
        filters.push(`${input},asetpts=N/SR/TB,apad=whole_len=${count},atrim=end_sample=${count},volume=${10 ** (processing.gainDb / 20)}[${label}]`); labels.push(`[${label}]`);
      }
      filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[voice]`);
      args.push('-filter_complex', filters.join(';'), '-map', '[voice]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', output);
      await runMedia(ffmpeg, args, { signal }); voiceFiles.push(output); cursorUs += shot.durationUs;
      options.onProgress?.(.05 + .35 * (index + 1) / project.shots.length);
    }
    const list = join(temporary, 'voices.txt'); await writeFile(list, voiceFiles.map(file => `file '${basename(file)}'`).join('\n'));
    const voicePath = join(temporary, 'voice.wav');
    await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:a', 'pcm_f32le', voicePath], { signal });
    const args = ['-nostdin', '-v', 'error', '-y', '-i', voicePath], filters: string[] = [];
    for (const [index, { clip, asset }] of music.entries()) {
      const source = await stem(asset, false, 0), first = sampleAt(clip.sourceInUs);
      if (first >= source.samples) throw new Error(`背景音乐“${asset.name}”的素材入点超出音频时长。`);
      args.push('-i', source.path);
      const length = sampleAt(clip.durationUs), chain = [`atrim=start_sample=${first}`, 'asetpts=N/SR/TB'];
      if (clip.loop) chain.push(`aloop=loop=-1:size=${source.samples - first}:start=0`);
      chain.push(`atrim=end_sample=${length}`, `volume=${10 ** (clip.gainDb / 20)}`);
      if (clip.fadeInUs) chain.push(`afade=t=in:ss=0:ns=${Math.max(1, sampleAt(clip.fadeInUs))}`);
      if (clip.fadeOutUs) chain.push(`afade=t=out:ss=${sampleAt(clip.durationUs - clip.fadeOutUs)}:ns=${Math.max(1, sampleAt(clip.fadeOutUs))}`);
      chain.push(`adelay=${sampleAt(clip.startUs)}S:all=1`, 'asetpts=N/SR/TB', `apad=whole_len=${totalSamples}`, `atrim=end_sample=${totalSamples}`);
      filters.push(`[${index + 1}:a]${chain.join(',')}[music${index}]`);
    }
    let output = '0:a';
    if (music.length) {
      filters.push(`${music.map((_, index) => `[music${index}]`).join('')}amix=inputs=${music.length}:normalize=0:duration=longest[music]`);
      if (settings.ducking.enabled) {
        const duck = settings.ducking;
        filters.push('[0:a]asplit=2[side][voice]', `[music][side]sidechaincompress=threshold=${10 ** (duck.thresholdDb / 20)}:ratio=${duck.ratio}:attack=${duck.attackMs}:release=${duck.releaseMs}:makeup=1[ducked]`, '[voice][ducked]amix=inputs=2:normalize=0:duration=first[mixed]');
      } else filters.push('[0:a][music]amix=inputs=2:normalize=0:duration=first[mixed]');
      output = 'mixed';
    }
    const rawMix = join(temporary, 'raw.wav');
    if (filters.length) { filters.push(`[${output}]apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}[final]`); args.push('-filter_complex', filters.join(';'), '-map', '[final]'); }
    else args.push('-map', output, '-af', `apad=whole_len=${totalSamples},atrim=end_sample=${totalSamples}`);
    args.push( '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', rawMix);
    await runMedia(ffmpeg, args, { signal }); options.onProgress?.(.55);
    const measured = await measure(rawMix, ffmpeg, signal, settings.loudness), normalized: string[] = [];
    if (settings.loudness.enabled && ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'].every(field => Number.isFinite(Number(measured[field])))) {
      const target = settings.loudness;
      normalized.push(`loudnorm=I=${target.targetLufs}:TP=${target.truePeakDb}:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`);
    } else if (settings.loudness.enabled) warnings.push('音轨为静音或无法测得有限响度，已保留原采样。');
    if (!settings.loudness.enabled && Number(measured.input_tp) > 0) warnings.push('混音超过 0 dBFS，输出会削波；请降低电平或开启响度处理。');
    const mixed = join(temporary, 'mix.wav');
    normalized.push('aresample=48000', `apad=whole_len=${totalSamples}`, `atrim=end_sample=${totalSamples}`);
    await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', rawMix, '-af', normalized.join(','), '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', mixed], { signal });
    const finalStats = await measure(mixed, ffmpeg, signal), pcm = join(temporary, 'mix.f32');
    await runMedia(ffmpeg, ['-nostdin', '-v', 'error', '-y', '-i', mixed, '-f', 'f32le', '-c:a', 'pcm_f32le', pcm], { signal });
    const levels = await buildLevels(pcm, join(temporary, 'levels.bin'), signal);
    for (const asset of used) await verifyAudio(asset, signal);
    const finite = (value: string) => Number.isFinite(Number(value)) ? Number(value) : undefined;
    const result = preparedAudioMixSchema.parse({ version: 1, key, path, sha256: await fileHash(mixed, signal), durationUs, shotDurations: project.shots.map(shot => ({ shotId: shot.id, durationUs: shot.durationUs })), analysis: { integratedLufs: finite(finalStats.input_i), truePeakDb: finite(finalStats.input_tp), sampleRate: SAMPLE_RATE, channels: 2 }, warnings });
    signal?.throwIfAborted();
    await rename(mixed, path); await rename(join(temporary, 'levels.bin'), levelsPath(path));
    const manifest = join(temporary, 'manifest.json'); await writeFile(manifest, JSON.stringify({ result, levels } satisfies MixManifest)); await rename(manifest, manifestPath(path));
    options.onProgress?.(1); return result;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

interface SharedMixJob { controller: AbortController; promise: Promise<PreparedAudioMix>; consumers: number; progress: Set<(value: number) => void> }
const running = new Map<string, SharedMixJob>();
export async function prepareAudioMix(options: PrepareAudioMixOptions): Promise<PreparedAudioMix> {
  options.signal?.throwIfAborted();
  const key = audioMixProjectionKey(options.project, options.assets), identity = join(options.outputDirectory, key);
  let job = running.get(identity);
  if (!job || job.controller.signal.aborted) {
    const controller = new AbortController(), progress = new Set<(value: number) => void>();
    const promise = prepare({ ...options, signal: controller.signal, onProgress: value => { for (const callback of progress) callback(value); } }, key);
    job = { controller, promise, consumers: 0, progress }; running.set(identity, job);
    const current = job;
    void promise.finally(() => { if (running.get(identity) === current) running.delete(identity); }).catch(() => undefined);
  }
  const current = job; current.consumers++; if (options.onProgress) current.progress.add(options.onProgress);
  return new Promise((resolve, reject) => {
    let settled = false;
    function cleanup() {
      if (settled) return false; settled = true; options.signal?.removeEventListener('abort', abort);
      if (options.onProgress) current.progress.delete(options.onProgress);
      current.consumers--; if (!current.consumers) current.controller.abort(new DOMException('声音准备已取消。', 'AbortError'));
      return true;
    }
    function abort() { if (cleanup()) reject(options.signal?.reason); }
    options.signal?.addEventListener('abort', abort, { once: true });
    current.promise.then(result => { if (cleanup()) resolve(result); }, error => { if (cleanup()) reject(error); });
    if (options.signal?.aborted) abort();
  });
}

/** Read at most one minute of actual stereo samples; no full-project peak arrays cross RPC. */
export async function readAudioLevelWindow(options: { mix: PreparedAudioMix; startUs: number; durationUs: number }): Promise<AudioLevelWindow> {
  if (!Number.isInteger(options.startUs) || options.startUs < 0 || !Number.isInteger(options.durationUs) || options.durationUs <= 0 || options.durationUs > 60_000_000) throw new RangeError('电平窗口须为正数，且不超过 60 秒。');
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath(options.mix.path), 'utf8')));
  if (manifest.result.key !== options.mix.key || manifest.result.sha256 !== options.mix.sha256) throw new Error('电平与当前混音不一致，请重新准备声音。');
  const first = Math.floor(options.startUs / 10_000), last = Math.min(manifest.levels.count, first + Math.ceil(options.durationUs / 10_000));
  const handle = await open(levelsPath(options.mix.path), 'r'), samples: AudioLevelWindow['samples'] = [];
  try {
    if ((await handle.stat()).size !== manifest.levels.count * LEVEL_BYTES) throw new Error('混音电平缓存损坏，请重新准备声音。');
    for (let chunk = Math.floor(first / CHUNK_WINDOWS); chunk < Math.ceil(last / CHUNK_WINDOWS); chunk++) {
      const begin = chunk * CHUNK_WINDOWS, count = Math.min(CHUNK_WINDOWS, manifest.levels.count - begin), bytes = Buffer.alloc(count * LEVEL_BYTES);
      const result = await handle.read(bytes, 0, bytes.length, begin * LEVEL_BYTES);
      if (result.bytesRead !== bytes.length || digest(bytes) !== manifest.levels.chunks[chunk]) throw new Error('混音电平缓存损坏，请重新准备声音。');
      for (let index = Math.max(first, begin); index < Math.min(last, begin + count); index++) {
        const offset = (index - begin) * LEVEL_BYTES;
        samples.push({ peakLeft: bytes.readFloatLE(offset), peakRight: bytes.readFloatLE(offset + 4), rmsLeft: bytes.readFloatLE(offset + 8), rmsRight: bytes.readFloatLE(offset + 12) });
      }
    }
  } finally { await handle.close(); }
  return audioLevelWindowSchema.parse({ key: options.mix.key, startUs: first * 10_000, periodUs: 10_000, samples });
}

export async function detectAudioSilence(options: { asset: AssetRecord; thresholdDb: number; minimumDurationUs: number; paddingUs: number; ffmpegPath?: string; signal?: AbortSignal }): Promise<SilenceDetection> {
  const { asset, signal } = options;
  silenceDetectionSchema.parse({ assetId: asset.id, sourceSha256: asset.sha256, thresholdDb: options.thresholdDb, minimumDurationUs: options.minimumDurationUs, paddingUs: options.paddingUs, ranges: [] });
  if (asset.kind !== 'audio' || !asset.active) throw new Error('请选择有效的原始音频进行停顿检测。');
  await verifyAudio(asset, signal);
  const directory = await mkdtemp(join(tmpdir(), 'vq-silence-')), pcm = join(directory, 'audio.f32');
  try {
    await runMedia(options.ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', asset.path, '-map', '0:a:0', '-vn', '-ar', '48000', '-ac', '2', '-f', 'f32le', '-c:a', 'pcm_f32le', pcm], { signal });
    const threshold = 10 ** (options.thresholdDb / 20), minimum = Math.ceil(options.minimumDurationUs * SAMPLE_RATE / 1_000_000), padding = sampleAt(options.paddingUs);
    const ranges: SilenceDetection['ranges'] = []; let cursor = 0, silentStart: number | undefined, remainder = Buffer.alloc(0);
    function close() {
      if (silentStart !== undefined && cursor - silentStart >= minimum && cursor - silentStart > padding * 2) ranges.push({ startUs: Math.round((silentStart + padding) * 1_000_000 / SAMPLE_RATE), endUs: Math.round((cursor - padding) * 1_000_000 / SAMPLE_RATE) });
      if (ranges.length > 10_000) throw new Error('检测到的停顿过多，请先缩小音频范围。');
      silentStart = undefined;
    }
    for await (const chunk of createReadStream(pcm, { signal })) {
      const bytes = remainder.length ? Buffer.concat([remainder, chunk]) : chunk, end = bytes.length - bytes.length % 8;
      for (let offset = 0; offset < end; offset += 8) {
        const amplitude = Math.max(Math.abs(bytes.readFloatLE(offset)), Math.abs(bytes.readFloatLE(offset + 4)));
        if (!Number.isFinite(amplitude)) throw new Error('音频包含无效采样。');
        if (amplitude <= threshold) silentStart ??= cursor; else close(); cursor++;
      }
      remainder = Buffer.from(bytes.subarray(end));
    }
    if (remainder.length || cursor === 0) throw new Error('音频未包含有效采样。');
    close(); await verifyAudio(asset, signal);
    return silenceDetectionSchema.parse({ assetId: asset.id, sourceSha256: asset.sha256, thresholdDb: options.thresholdDb, minimumDurationUs: options.minimumDurationUs, paddingUs: options.paddingUs, ranges });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
