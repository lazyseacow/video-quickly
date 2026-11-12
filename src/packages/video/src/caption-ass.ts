import { firstFrameAtUs, timeAtFrame, type FrameRate } from '@video-quickly/contracts';
import { captionBox, type CaptionLayout } from './caption-layout.js';

export interface AssCaptionCue { startUs: number; endUs: number; lines: string[]; layout: CaptionLayout; fontName: string }

/** Keep literal text out of override blocks; a word joiner prevents literal \N/\h from becoming ASS escapes. */
export function escapeAssText(text: string): string {
  return Array.from(text.replace(/\r\n?/g, '\n')).map(character => character === '\\' ? '\\\u2060' : character === '{' ? '\\{' : character === '}' ? '\\}' : character === '\n' ? '\\N' : character === '\t' ? ' ' : character === '\0' ? '' : character).join('');
}

function color(value: string, opacity = 1): string {
  return `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, '0')}${value.slice(5, 7)}${value.slice(3, 5)}${value.slice(1, 3)}`.toUpperCase();
}
const number = (value: number) => String(Math.round(value * 1000) / 1000);
function timestamp(milliseconds: number): string {
  const centiseconds = Math.round(milliseconds / 10);
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function visibility(cue: AssCaptionCue, rate: FrameRate) {
  const first = firstFrameAtUs(cue.startUs, rate), end = firstFrameAtUs(cue.endUs, rate);
  if (first >= end) return undefined;
  // ASS event headers have centisecond precision. Controlled millisecond fades retain the first visible project frame.
  const firstMs = Math.floor(timeAtFrame(first, rate) / 1000), endMs = Math.floor(timeAtFrame(end, rate) / 1000);
  const outerStart = Math.floor(firstMs / 10) * 10, outerEnd = Math.ceil(endMs / 10) * 10;
  const startOffset = firstMs - outerStart, endOffset = endMs - outerStart;
  return { start: timestamp(outerStart), end: timestamp(outerEnd), fade: `\\fade(255,0,255,${startOffset},${startOffset},${endOffset},${endOffset})` };
}

function roundedRectangle(width: number, height: number, requestedRadius: number): string {
  const r = Math.min(requestedRadius, width / 2, height / 2), k = r * .55228475;
  const n = number;
  return `m ${n(r)} 0 l ${n(width-r)} 0 b ${n(width-r+k)} 0 ${n(width)} ${n(r-k)} ${n(width)} ${n(r)} l ${n(width)} ${n(height-r)} b ${n(width)} ${n(height-r+k)} ${n(width-r+k)} ${n(height)} ${n(width-r)} ${n(height)} l ${n(r)} ${n(height)} b ${n(r-k)} ${n(height)} 0 ${n(height-r+k)} 0 ${n(height-r)} l 0 ${n(r)} b 0 ${n(r-k)} ${n(r-k)} 0 ${n(r)} 0`;
}

/** One controlled background and text event per reading page, with host-selected fonts and no user-supplied tags. */
export function createCaptionAss(cues: readonly AssCaptionCue[], width: number, height: number, rate: FrameRate): string {
  const styles: string[] = [], names = new Map<string, string>(), events: string[] = [];
  for (const cue of cues) {
    const timing = visibility(cue, rate); if (!timing || !cue.lines.length) continue;
    const { layout } = cue, box = captionBox(layout, cue.lines.length);
    const key = JSON.stringify([cue.fontName, layout.fontSize, layout.fontWeight, layout.textColor]);
    let name = names.get(key);
    if (!name) {
      name = `Caption${names.size}`; names.set(key, name);
      styles.push(`Style: ${name},${cue.fontName.replace(/[,\r\n]/g, '')},${number(layout.fontSize)},${color(layout.textColor)},&H00000000,&HFF000000,&HFF000000,${layout.fontWeight >= 600 ? -1 : 0},0,0,0,100,100,0,0,1,0,0,5,0,0,0,1`);
    }
    if (layout.backgroundOpacity > 0) {
      const tags = `${timing.fade}\\an7\\pos(${number(box.x)},${number(box.y)})\\p1\\bord0\\shad0\\1c${color(layout.backgroundColor)}\\1a&H${Math.round((1-layout.backgroundOpacity)*255).toString(16).padStart(2,'0')}&`;
      events.push(`Dialogue: 0,${timing.start},${timing.end},${name},,0,0,0,,{${tags}}${roundedRectangle(box.width, box.height, Math.max(3, layout.fontSize * .3))}`);
    }
    cue.lines.forEach((line, index) => {
      const y = layout.legacy ? box.y + layout.fontSize * .8 + index * layout.lineHeight : box.y + layout.paddingY + (index + .5) * layout.lineHeight;
      const tags = `${timing.fade}\\an5\\pos(${number(width/2)},${number(y)})\\q2\\clip(${number(box.x)},${number(box.y)},${number(box.x+box.width)},${number(box.y+box.height)})`;
      events.push(`Dialogue: 1,${timing.start},${timing.end},${name},,0,0,0,,{${tags}}${escapeAssText(line)}`);
    });
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n${styles.join('\n')}\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}
