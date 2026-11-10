import { execFileSync } from 'node:child_process';

let cached: Buffer | undefined;
export function fixtureNativeVideo(frame?: Buffer): Buffer {
  if (!frame && cached) return cached;
  const input = frame ? ['-f', 'image2pipe', '-framerate', '30', '-i', 'pipe:0'] : ['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1'];
  const still = frame ? ['-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tpad=stop_mode=clone:stop_duration=1'] : [];
  const video = execFileSync(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', ...input,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    ...still, '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
  ], { input: frame, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  if (!frame) cached = video;
  return video;
}
