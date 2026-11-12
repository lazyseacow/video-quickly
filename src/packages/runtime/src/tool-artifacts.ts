import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { downloadPublicToolMedia } from './public-tool-download.js';

const maximumBytes = 100_000_000;
const extensions = new Map([
  ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/jpg', '.jpg'], ['image/webp', '.webp'],
  ['video/mp4', '.mp4'], ['video/webm', '.webm'], ['video/quicktime', '.mov'],
  ['audio/mpeg', '.mp3'], ['audio/mp3', '.mp3'], ['audio/wav', '.wav'], ['audio/x-wav', '.wav'], ['audio/mp4', '.m4a'], ['audio/ogg', '.ogg'],
]);
const demuxers = new Map([
  ['.png', 'png_pipe,apng'], ['.jpg', 'jpeg_pipe'], ['.webp', 'webp_pipe,webp_anim'],
  ['.mp4', 'mov'], ['.mov', 'mov'], ['.webm', 'matroska,webm'],
  ['.mp3', 'mp3'], ['.wav', 'wav'], ['.m4a', 'mov'], ['.ogg', 'ogg'],
]);
const rasterExtensions = new Set(['.png', '.jpg', '.webp']);
const videoExtensions = new Set(['.mp4', '.webm', '.mov']);
const mediaProbe = z.object({
  streams: z.array(z.object({ codec_type: z.string(), width: z.number().optional(), height: z.number().optional(), sample_rate: z.string().optional(), disposition: z.object({ attached_pic: z.number() }).optional() })),
});
const invalidMedia = () => new Error('工具素材内容与声明的图片、音频或视频格式不符。');
const typeOf = (value: string | undefined) => value?.split(';')[0].trim().toLowerCase();
const genericMediaTypes = new Set(['application/octet-stream', 'binary/octet-stream']);

export async function agentToolOutputDirectory(dataDirectory: string, runId: string) {
  const root = join(await realpath(dataDirectory), 'tool-artifacts');
  await mkdir(root, { recursive: true });
  if (await realpath(root) !== root) throw new Error('工具产物目录不能使用符号链接。');
  const path = join(root, runId);
  await mkdir(path, { recursive: true });
  if (await realpath(path) !== path) throw new Error('本次工具产物目录不能使用符号链接。');
  return path;
}

async function openLocalArtifact(input: string, root: string) {
  const path = resolve(root, input), part = relative(root, path);
  const denied = () => new Error('本地工具素材须为本次运行产物目录内的普通文件。');
  if (!part || isAbsolute(part) || part === '..' || part.startsWith('..' + sep)) throw denied();
  const directories = [dirname(dirname(root)), dirname(root)];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    directories.push(parent);
    if (!relative(root, parent)) break;
    if (dirname(parent) === parent) throw denied();
  }
  const ancestry = () => Promise.all(directories.map(async directory => {
    const info = await lstat(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw denied();
    return [info.dev, info.ino, info.ctimeNs, info.mtimeNs] as const;
  }));
  // A directory can be swapped away and restored between two realpath
  // calls. Check the directory entries themselves around the opened handle.
  const before = await ancestry();
  if (relative(path, await realpath(path))) throw denied();
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1) throw denied();
  if (info.size <= 0 || info.size > maximumBytes) throw new Error('本地工具素材须为不超过 100 MB 的非空文件。');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== info.dev || opened.ino !== info.ino || relative(path, await realpath(path))) throw denied();
    const after = await ancestry();
    if (before.some((entry, index) => entry.some((value, field) => value !== after[index][field]))) throw denied();
    return file;
  } catch (error) { await file.close(); throw error; }
}

function artifactExtension(input: { path?: string; mimeType?: string }, contentType?: string) {
  const declared = typeOf(contentType), requested = typeOf(input.mimeType);
  const fromHeader = declared ? extensions.get(declared) : undefined;
  const fromInput = requested ? extensions.get(requested) : undefined;
  const pathExtension = input.path && extname(input.path).toLowerCase();
  const fromPath = pathExtension === '.jpeg' ? '.jpg' : pathExtension;
  if (requested && !fromInput || declared && !genericMediaTypes.has(declared) && !fromHeader
    || fromHeader && fromInput && fromHeader !== fromInput || fromPath && fromInput && fromPath !== fromInput) throw invalidMedia();
  const extension = fromPath || fromHeader || fromInput;
  if (!extension || ![...extensions.values()].includes(extension)) throw new Error('工具素材需要受支持的图片、音频或视频 MIME 类型。');
  return extension;
}

async function validateArtifact(path: string, extension: string, ffmpegPath: string | undefined, signal: AbortSignal) {
  const demuxer = demuxers.get(extension);
  if (!demuxer) throw invalidMedia();
  try {
    const { runMedia } = await import('@video-quickly/video/node');
    const ffmpeg = ffmpegPath ?? process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
    const ffprobe = process.env.VIDEO_QUICKLY_FFPROBE ?? join(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const raster = rasterExtensions.has(extension);
    const limits = ['-max_alloc', '134217728', '-threads', '1', ...(raster ? ['-max_pixels', '32000000'] : []),
      '-protocol_whitelist', 'file', '-format_whitelist', demuxer];
    const result = await runMedia(ffprobe, ['-v', 'error', ...limits, '-show_entries',
      'stream=codec_type,width,height,sample_rate:stream_disposition=attached_pic', '-of', 'json', path], { signal });
    const { streams } = mediaProbe.parse(JSON.parse(result));
    const video = streams.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic && (stream.width ?? 0) > 0 && (stream.height ?? 0) > 0);
    const audio = streams.some(stream => stream.codec_type === 'audio' && Number(stream.sample_rate) > 0);
    const expectedVideo = raster || videoExtensions.has(extension);
    if (expectedVideo ? !video : !audio || video) throw invalidMedia();
    if (raster && (video?.width ?? 0) * (video?.height ?? 0) > 32_000_000) throw invalidMedia();
    const stream = expectedVideo ? ['-map', '0:V:0', '-an', '-frames:v', '1'] : ['-map', '0:a:0', '-vn', '-frames:a', '1'];
    await runMedia(ffmpeg, ['-v', 'error', '-xerror', '-abort_on', 'empty_output', ...limits, '-i', path,
      ...stream, '-f', 'null', '-'], { signal });
  } catch {
    signal.throwIfAborted();
    throw invalidMedia();
  }
}

/** Stage and verify tool bytes before the normal asset importer can register them. */
export async function materializeToolArtifact(
  input: { path?: string; url?: string; data?: string; mimeType?: string },
  directory: string,
  signal: AbortSignal,
  options: { localOutputDirectory?: string; ffmpegPath?: string } = {},
): Promise<string> {
  if ([input.path, input.url, input.data].filter(source => source !== undefined).length !== 1) throw new Error('工具素材需要在 path、url 和 data 中选择一种来源。');
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  boundedSignal.throwIfAborted();
  const response = input.url === undefined ? undefined : await downloadPublicToolMedia(input.url, boundedSignal);
  let local: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (Number(response?.headers['content-length']) > maximumBytes) throw new Error('工具素材超过 100 MB。');
    const extension = artifactExtension(input, response?.headers['content-type']);
    let source: AsyncIterable<Buffer> | Buffer | undefined;
    if (input.data !== undefined) {
      const encoded = input.data;
      if (!encoded.length || encoded.length > Math.ceil(maximumBytes / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('工具素材 data 需要不超过 100 MB 的有效 base64 内容。');
      source = Buffer.from(encoded, 'base64');
      if (!source.length || source.length > maximumBytes || source.toString('base64') !== encoded) throw new Error('工具素材 data 不是有效的标准 base64 内容。');
    } else if (input.path !== undefined && options.localOutputDirectory) {
      local = await openLocalArtifact(input.path, options.localOutputDirectory);
    } else if (response) source = response;
    else throw new Error('本地工具素材须来自本次运行产物目录。');
    const path = join(directory, randomUUID() + extension), partial = path + '.part';
    await mkdir(directory, { recursive: true });
    boundedSignal.throwIfAborted();
    if (response?.errored) throw response.errored;
    try {
      const file = await open(partial, 'wx');
      try {
        let received = 0;
        const chunks = Buffer.isBuffer(source) ? [source] : source ?? local!.createReadStream({ signal: boundedSignal });
        for await (const chunk of chunks) {
          boundedSignal.throwIfAborted();
          received += chunk.byteLength;
          if (received > maximumBytes) throw new Error('工具素材超过 100 MB。');
          await file.writeFile(chunk);
        }
        if (!received) throw new Error('工具素材文件为空。');
      } finally { await file.close(); }
      await validateArtifact(partial, extension, options.ffmpegPath, boundedSignal);
      boundedSignal.throwIfAborted();
      await rename(partial, path);
      return path;
    } catch (error) { await rm(partial, { force: true }); throw error; }
  } finally {
    response?.destroy();
    await local?.close();
  }
}
