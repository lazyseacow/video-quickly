import { captionStyleSchema, DEFAULT_CAPTION_STYLE, type CaptionStyle } from '@video-quickly/contracts';
import { citationFooterTop } from './citations.js';

export const CAPTION_FONT_CATALOG = {
  sans: { label: '无衬线', families: ['Microsoft YaHei', 'Hiragino Sans GB', 'PingFang SC', 'Noto Sans CJK SC', 'Arial', 'DejaVu Sans', 'sans-serif'] },
  serif: { label: '衬线', families: ['SimSun', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Times New Roman', 'DejaVu Serif', 'serif'] },
} as const;

export function captionFontFamily(id: CaptionStyle['fontId']): string {
  return CAPTION_FONT_CATALOG[id].families.map(family => family === 'serif' || family === 'sans-serif' ? family : `"${family}"`).join(', ');
}

/** ASS receives the same first available family that the host Canvas uses from the controlled list. */
export function selectCaptionFont(id: CaptionStyle['fontId'], available: (family: string) => boolean): string {
  return CAPTION_FONT_CATALOG[id].families.find(available) ?? (id === 'serif' ? 'serif' : 'sans-serif');
}

/** Unfinished editor input may preview safely; project writes still validate the strict contract. */
export function safeCaptionStyle(value?: CaptionStyle | null): CaptionStyle | undefined {
  if (value == null) return undefined;
  const parsed = captionStyleSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_CAPTION_STYLE };
}

export function captionGeometry(width: number, height: number, referenceFooter = false): { fontSize: number; lines: number; bottom: number } {
  return {
    fontSize: Math.max(referenceFooter ? 4 : 12, Math.min(width * .027, height * .047)),
    lines: height > width ? 3 : 2,
    bottom: referenceFooter ? Math.min(height * .9, citationFooterTop(width, height) - Math.max(2, height * .01)) : height * .9,
  };
}

export interface CaptionLayout {
  style?: CaptionStyle; legacy: boolean; fontSize: number; fontFamily: string; fontWeight: number; font: string;
  textColor: string; backgroundColor: string; backgroundOpacity: number; position: 'top' | 'bottom';
  maxLines: number; lineHeight: number; paddingY: number; textWidth: number; boxX: number; boxWidth: number;
  top: number; bottom: number; diagramTop: number; diagramBottom: number;
}

export function resolveCaptionLayout(width: number, height: number, value?: CaptionStyle | null, options: { referenceFooter?: boolean; template?: boolean } = {}): CaptionLayout {
  const style = safeCaptionStyle(value), geometry = captionGeometry(width, height, options.referenceFooter);
  const maxLines = style?.maxLines ?? geometry.lines, position = style?.position ?? 'bottom', top = height * .235, bottom = geometry.bottom, gap = height * .025;
  const available = position === 'top' ? bottom - top - gap * 2 - 1 : bottom - height * .255 - gap - 1;
  const fontSize = style ? Math.max(1, Math.min(Math.min(width, height) * style.fontSizeRatio, available / (maxLines * 1.55 + 1))) : geometry.fontSize;
  const fontWeight = style?.fontWeight ?? 500, fontFamily = captionFontFamily(style?.fontId ?? 'sans');
  const lineHeight = fontSize * 1.55, paddingY = fontSize * .5;
  const maximumBox = maxLines * lineHeight + paddingY * 2;
  return {
    style, legacy: !style, fontSize, fontFamily, fontWeight, font: `${fontWeight} ${fontSize}px ${fontFamily}`,
    textColor: style?.textColor ?? '#fbf4e1', backgroundColor: style?.backgroundColor ?? '#20382e', backgroundOpacity: style?.backgroundOpacity ?? 230 / 255,
    position, maxLines, lineHeight, paddingY, textWidth: width * .78, boxX: width * .07, boxWidth: width * .86,
    top, bottom, diagramTop: position === 'top' ? Math.max(height * .255, top + maximumBox + gap) : height * .255,
    diagramBottom: position === 'top' ? Math.min(height * .88, bottom - gap) : Math.min(height * .8, Math.max(height * .255 + 1, bottom - maximumBox - gap)),
  };
}

export function captionBox(layout: CaptionLayout, lineCount: number): { x: number; y: number; width: number; height: number } {
  const height = lineCount * layout.lineHeight + layout.paddingY * 2;
  return { x: layout.boxX, y: layout.position === 'top' ? layout.top : layout.bottom - height, width: layout.boxWidth, height };
}
