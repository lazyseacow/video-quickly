import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ffmpeg = () => process.env.VIDEO_QUICKLY_FFMPEG ?? 'ffmpeg';
export type PixelPoint = { x: number; y: number };
export type Rgb = [number, number, number];

export async function writeTransitionImage(path: string, color: string, width = 320, height = 180) {
  await execute(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${color}:s=${width}x${height}:r=30:d=0.04`, '-frames:v', '1', '-update', '1', path]);
}

/** Frame 29 is the last authored frame; later source frames must never leak into its transition hold. */
export async function writeTransitionVideo(path: string, animated = false) {
  const changes = animated ? ['10d020', '1010f0', 'f08010', 'd010d0', '10c0c0'].map((color, index) => `drawbox=x=0:y=0:w=iw:h=ih:color=0x${color}:t=fill:enable='eq(mod(floor(n/3),5),${index})'`) : [];
  const filter = [...changes, "drawbox=x=0:y=0:w=iw:h=ih:color=0xf01010:t=fill:enable='eq(n,29)'", "drawbox=x=0:y=0:w=iw:h=ih:color=0x1010f0:t=fill:enable='gte(n,30)'"];
  await execute(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x10d020:s=320x180:r=30:d=1.6', '-vf', filter.join(','), '-frames:v', '48', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path]);
}

/** Independent long-GOP sources with changing colours, a moving pattern and different real audio. */
export async function writeColdTransitionVideo(path: string, index: number) {
  const palette = index ? ['10c0b0', '1020e0', '10b030'] : ['e02010', 'e08010', 'd0c010'];
  const changes = palette.map((color, phase) => `drawbox=x=0:y=0:w=iw:h=ih:color=0x${color}:t=fill:enable='eq(mod(floor(n/3),3),${phase})'`).join(',');
  await execute(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=s=320x180:r=30:d=2.5', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:r=30:d=2.5', '-f', 'lavfi', '-i', `sine=frequency=${index ? 660 : 330}:sample_rate=48000:duration=2.5`, '-filter_complex', `[0:v]${changes}[base];[base][1:v]overlay=x='mod(t*80,256)':y=58[v]`, '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', path], { windowsHide: true });
}

export async function decodeTransitionFrames(path: string, frameNumbers: readonly number[], width: number, height: number) {
  const numbers = [...new Set(frameNumbers)].sort((a, b) => a - b);
  const stride = width * height * 3;
  const result = await execute(ffmpeg(), ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select='${numbers.map(frame => `eq(n,${frame})`).join('+')}'`, '-frames:v', String(numbers.length), '-fps_mode', 'passthrough', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer', maxBuffer: stride * numbers.length + 1024 * 1024 });
  const bytes = Buffer.from(result.stdout);
  if (bytes.length !== numbers.length * stride) throw new Error(`Expected ${numbers.length} decoded frames, received ${bytes.length / stride}.`);
  return new Map(numbers.map((frame, index) => [frame, bytes.subarray(index * stride, (index + 1) * stride)]));
}

export function transitionPixels(bytes: Uint8Array, width: number, points: readonly PixelPoint[]): Rgb[] {
  return points.map(({ x, y }) => { const offset = (y * width + x) * 3; return [bytes[offset], bytes[offset + 1], bytes[offset + 2]]; });
}

export function transitionPoints(width: number, height: number): PixelPoint[] {
  return [.2, .5].flatMap(y => [.12, .36, .64, .88].map(x => ({ x: Math.floor(width * x), y: Math.floor(height * y) })));
}

export function coloredCaptionPixels(bytes: ArrayLike<number>, width: number, height: number, channels: 3 | 4) {
  let red = 0, green = 0;
  for (let y = Math.floor(height * .55); y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * channels, r = bytes[offset], g = bytes[offset + 1], b = bytes[offset + 2];
    if (r > 60 && r > g * 1.8 && r > b * 1.8) red++;
    if (g > 220 && r < 60 && b < 60) green++;
  }
  return { red, green };
}
