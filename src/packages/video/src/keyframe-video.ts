import { spawn } from 'node:child_process';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { firstFrameAtUs, type AssetRecord, type ProjectDocument, type Shot } from '@video-quickly/contracts';
import { resolveShotSpans } from './clip-edits.js';
import { probeMedia } from './media-process.js';
import type { RenderClipSchedule } from './render-schedule.js';

/** Decode the same global frame samples as the ordinary video path, retaining at most one raw frame. */
export async function* keyframeVideoFrames(shot: Shot, project: ProjectDocument, asset: AssetRecord, schedule: RenderClipSchedule, ffmpeg: string, ffprobe: string, signal?: AbortSignal): AsyncGenerator<CanvasImageSource> {
  const { width, height, frameRate } = project.profile, rate = `${frameRate.numerator}/${frameRate.denominator}`;
  const metadata = await probeMedia(asset.path, ffprobe, signal), [numerator, denominator] = (metadata.frameRate ?? rate).split('/').map(Number);
  const sourceFps = numerator > 0 && denominator > 0 ? numerator / denominator : frameRate.numerator / frameRate.denominator;
  const lastSourceSeconds = Math.max(0, (metadata.videoDuration ?? metadata.duration) - 1 / sourceFps);
  const image = createCanvas(width, height), context = image.getContext('2d'), bytes = width * height * 4, pixels = new Uint8ClampedArray(bytes);
  try { for (const span of resolveShotSpans(shot, project)) {
    const first = firstFrameAtUs(schedule.startUs + span.outputStartUs, frameRate), end = firstFrameAtUs(schedule.startUs + span.outputEndUs, frameRate), count = end - first;
    if (!count) continue;
    const phaseUs = Math.round(first * 1_000_000 * frameRate.denominator / frameRate.numerator) - schedule.startUs - span.outputStartUs;
    const target = Math.min((span.videoInUs + phaseUs) / 1_000_000, lastSourceSeconds), seek = Math.max(0, target - 1);
    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x1d2724:s=${width}x${height}:r=${rate}`, '-ss', String(seek), '-i', asset.path];
    const fit = project.profile.fitMode === 'cover' ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}` : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x1d2724`;
    const filters = [`[0:v]setsar=1,settb=1/${frameRate.numerator},setpts=N*${frameRate.denominator}[clock]`];
    if (project.profile.fitMode === 'blur') filters.push(`[1:v]setpts=PTS+(${seek}-${target})/TB,split=2[bg][fg]`, `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=20[background]`, `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[foreground]`, '[background][foreground]overlay=(W-w)/2:(H-h)/2,setsar=1[fit]');
    else filters.push(`[1:v]setpts=PTS+(${seek}-${target})/TB,${fit},setsar=1[fit]`);
    filters.push('[clock][fit]overlay=0:0:eof_action=repeat:shortest=0:repeatlast=1[video]');
    args.push('-filter_complex', filters.join(';'), '-map', '[video]', '-frames:v', String(count), '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1');
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal });
    let errors = '', completed = false;
    child.stderr.on('data', data => { errors = (errors + String(data)).slice(-16_000); });
    const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => { completed = true; code === 0 ? resolve() : reject(new Error(`关键帧视频解码失败：${errors.slice(-2000)}`)); }); });
    closed.catch(() => undefined);
    let used = 0, frames = 0;
    try {
      for await (const data of child.stdout) {
        const chunk: Buffer = data;
        let offset = 0;
        while (offset < chunk.length) {
          signal?.throwIfAborted();
          const length = Math.min(bytes - used, chunk.length - offset);
          pixels.set(chunk.subarray(offset, offset + length), used); used += length; offset += length;
          if (used === bytes) {
            if (++frames > count) throw new Error('关键帧解码返回了超出计划的帧。');
            context.putImageData(new ImageData(pixels, width, height), 0, 0); used = 0;
            yield image as unknown as CanvasImageSource;
          }
        }
      }
      await closed;
      if (used || frames !== count) throw new Error('关键帧视频解码未返回完整的计划帧。');
    } finally {
      if (!completed) child.kill();
      await closed.catch(() => undefined);
    }
  } } finally { image.width = image.height = 1; }
}
