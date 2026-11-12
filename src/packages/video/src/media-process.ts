import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

export interface MediaProcessOptions { cwd?: string; signal?: AbortSignal }

export async function hashMediaFile(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  signal?.throwIfAborted(); return hash.digest('hex');
}

export async function runMediaCapture(executable: string, args: string[], options: MediaProcessOptions = {}): Promise<{ stdout: string; stderr: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal });
    let stdout = '', stderr = '', failure: Error | undefined;
    child.stdout.on('data', data => { stdout += String(data); if (stdout.length > 8_000_000) { failure = new Error('媒体处理返回的数据过大。'); child.kill(); } });
    child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-32_000); });
    child.once('error', error => { failure = error; });
    child.once('close', code => {
      if (options.signal?.aborted) { reject(options.signal.reason); return; }
      if (failure) { reject(failure); return; }
      if (code !== 0) { reject(new Error(`媒体处理失败：${stderr.slice(-2400) || `退出码 ${String(code)}`}`)); return; }
      resolve({ stdout, stderr });
    });
  });
}

export async function runMedia(executable: string, args: string[], options: MediaProcessOptions = {}): Promise<string> {
  return (await runMediaCapture(executable, args, options)).stdout;
}

export async function probeMedia(path: string, ffprobePath = 'ffprobe', signal?: AbortSignal): Promise<{ width?: number; height?: number; duration: number; videoDuration?: number; audioDuration?: number; frameRate?: string; audio: boolean }> {
  const value: unknown = JSON.parse(await runMedia(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], { signal }));
  if (typeof value !== 'object' || value === null) throw new Error('媒体探测返回无效内容');
  const parsed = value as { streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; duration?: string }>; format?: { duration?: string } };
  const video = parsed.streams?.find(stream => stream.codec_type === 'video'), audio = parsed.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(parsed.format?.duration ?? video?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('媒体时长无效');
  const streamDuration = (stream: typeof video) => { const result = Number(stream?.duration); return Number.isFinite(result) && result > 0 ? result : undefined; };
  return { width: video?.width, height: video?.height, duration, videoDuration: streamDuration(video), audioDuration: streamDuration(audio), frameRate: video?.avg_frame_rate, audio: Boolean(audio) };
}
