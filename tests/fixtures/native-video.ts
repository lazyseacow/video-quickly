import { execFileSync } from 'node:child_process';

let cached: Buffer | undefined;
export function fixtureNativeVideo(): Buffer {
  cached ??= execFileSync(process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-threads', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
  ], { windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  return cached;
}
