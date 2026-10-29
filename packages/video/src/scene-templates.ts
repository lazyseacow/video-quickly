import type { SceneTemplate } from '@video-quickly/contracts';

const palettes = {
  sage: { background: '#f4f5ef', ink: '#233d34', muted: '#667b70', accent: '#347461', soft: '#e1ece5', secondary: '#85a48f', border: '#d5e0d8' },
  blue: { background: '#f1f5f9', ink: '#243e58', muted: '#647d94', accent: '#3571ab', soft: '#dfebf6', secondary: '#78a5ca', border: '#d4e0eb' },
  amber: { background: '#faf5ea', ink: '#59432a', muted: '#8a765d', accent: '#a46d24', soft: '#f2e5cc', secondary: '#c59a59', border: '#e6dac4' },
};
type Colors = typeof palettes.sage;
interface TextLayout { lines: string[]; size: number; lineHeight: number }
const textLayouts = new WeakMap<SceneTemplate, Map<string, TextLayout>>();
const clamp = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
export const SCENE_TEMPLATE_FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Heiti TC", sans-serif';
const font = (size: number, weight = 400) => `${weight} ${size}px ${SCENE_TEMPLATE_FONT_FAMILY}`;

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = []; let line = '';
  for (const character of text) {
    if (character === '\n') { lines.push(line); line = ''; continue; }
    if (line && ctx.measureText(line + character).width > width) { lines.push(line); line = character; }
    else line += character;
  }
  if (line) lines.push(line);
  return lines;
}

function fitted(ctx: CanvasRenderingContext2D, template: SceneTemplate, text: string, width: number, height: number, maximum: number, weight: number): TextLayout {
  let cache = textLayouts.get(template);
  if (!cache) { cache = new Map(); textLayouts.set(template, cache); }
  const key = JSON.stringify([text, width, height, maximum, weight]);
  const previous = cache.get(key); if (previous) return previous;
  let low = Math.min(1, maximum), high = Math.max(low, maximum);
  for (let attempt = 0; attempt < 9; attempt++) {
    const size = (low + high) / 2; ctx.font = font(size, weight);
    if (wrap(ctx, text, width).length * size * 1.3 <= height) low = size; else high = size;
  }
  ctx.font = font(low, weight);
  const result = { lines: wrap(ctx, text, width), size: low, lineHeight: low * 1.3 };
  cache.set(key, result); return result;
}

function text(ctx: CanvasRenderingContext2D, template: SceneTemplate, value: string, x: number, y: number, width: number, height: number, size: number, color: string, weight = 400) {
  const layout = fitted(ctx, template, value, Math.max(1, width), Math.max(1, height), Math.max(1, size), weight);
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
  ctx.font = font(layout.size, weight); ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  layout.lines.forEach((line, index) => ctx.fillText(line, x, y + index * layout.lineHeight));
  ctx.restore();
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, colors: Colors) {
  ctx.fillStyle = '#ffffff'; ctx.strokeStyle = colors.border; ctx.lineWidth = Math.max(1, radius * .07);
  ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill(); ctx.stroke();
}

function process(ctx: CanvasRenderingContext2D, template: Extract<SceneTemplate, { kind: 'process' }>, x: number, y: number, width: number, height: number, progress: number, colors: Colors) {
  const count = Math.max(1, template.steps.length), row = height / count, gap = row * .12;
  const radius = Math.min(row * .19, width * .027), axis = x + radius;
  ctx.lineCap = 'round'; ctx.lineWidth = Math.max(2, radius * .17); ctx.strokeStyle = colors.soft;
  ctx.beginPath(); ctx.moveTo(axis, y + row / 2); ctx.lineTo(axis, y + height - row / 2); ctx.stroke();
  ctx.strokeStyle = colors.accent; ctx.beginPath(); ctx.moveTo(axis, y + row / 2); ctx.lineTo(axis, y + row / 2 + Math.max(0, height - row) * progress); ctx.stroke();
  template.steps.forEach((step, index) => {
    const shown = clamp(progress * (count + .5) - index * .92);
    const top = y + index * row, cardX = x + radius * 3.1, cardWidth = width - radius * 3.1;
    ctx.save(); ctx.globalAlpha = .15 + shown * .85;
    panel(ctx, cardX, top + gap / 2, cardWidth, row - gap, Math.min(16, row * .1), colors);
    ctx.fillStyle = shown > .45 ? colors.accent : colors.secondary; ctx.beginPath(); ctx.arc(axis, top + row / 2, radius, 0, Math.PI * 2); ctx.fill();
    ctx.font = font(radius, 600); ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(index + 1).padStart(2, '0'), axis, top + row / 2);
    const pad = Math.min(row * .1, cardWidth * .035), titleHeight = step.detail.trim() ? (row - gap - pad * 2) * .56 : row - gap - pad * 2;
    text(ctx, template, step.title, cardX + pad, top + gap / 2 + pad, cardWidth - pad * 2, titleHeight, Math.min(row * .29, width * .035), colors.ink, 600);
    if (step.detail.trim()) text(ctx, template, step.detail, cardX + pad, top + gap / 2 + pad + titleHeight, cardWidth - pad * 2, row - gap - pad * 2 - titleHeight, Math.min(row * .2, width * .024), colors.muted);
    ctx.restore();
  });
}

function comparison(ctx: CanvasRenderingContext2D, template: Extract<SceneTemplate, { kind: 'comparison' }>, x: number, y: number, width: number, height: number, progress: number, colors: Colors) {
  const gap = width * .035, column = (width - gap) / 2, pad = column * .065;
  const count = Math.max(1, template.left.points.length, template.right.points.length);
  [template.left, template.right].forEach((side, sideIndex) => {
    const left = x + sideIndex * (column + gap);
    panel(ctx, left, y, column, height, Math.min(24, width * .018), colors);
    ctx.fillStyle = sideIndex ? colors.secondary : colors.accent; ctx.fillRect(left + pad, y + pad, column - pad * 2, Math.max(3, height * .009));
    const headingHeight = height * .16;
    text(ctx, template, side.title, left + pad, y + pad * 1.6, column - pad * 2, headingHeight - pad * .6, Math.min(column * .085, height * .09), colors.ink, 600);
    const available = height - headingHeight - pad * 2.5, row = available / Math.max(1, side.points.length);
    side.points.forEach((point, index) => {
      const shown = clamp(progress * (count + .4) - index * .94);
      ctx.save(); ctx.globalAlpha = shown;
      const top = y + headingHeight + pad * 1.5 + index * row;
      const dot = Math.min(column * .018, row * .07);
      ctx.fillStyle = sideIndex ? colors.secondary : colors.accent; ctx.beginPath(); ctx.arc(left + pad + dot, top + dot * 1.5, dot, 0, Math.PI * 2); ctx.fill();
      text(ctx, template, point, left + pad + dot * 3.8, top, column - pad * 2 - dot * 3.8, row * .86, Math.min(column * .065, row * .31), colors.ink);
      ctx.restore();
    });
  });
}

function number(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1e7) return value.toExponential(2);
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 3 }).format(value);
}

function bars(ctx: CanvasRenderingContext2D, template: Extract<SceneTemplate, { kind: 'bar-chart' }>, x: number, y: number, width: number, height: number, progress: number, colors: Colors) {
  const pad = width * .035;
  panel(ctx, x, y, width, height, Math.min(24, width * .018), colors);
  const header = height * .09;
  if (template.unit) text(ctx, template, `单位：${template.unit}`, x + pad, y + height * .035, width - pad * 2, header, Math.min(width * .022, header * .65), colors.muted);
  const row = (height - header - pad) / Math.max(1, template.bars.length), labelWidth = (width - pad * 2) * .29;
  const plotX = x + pad + labelWidth, plotWidth = width - pad * 2 - labelWidth, maximum = Math.max(1, ...template.bars.map(bar => Number.isFinite(bar.value) ? Math.max(0, bar.value) : 0));
  template.bars.forEach((bar, index) => {
    const top = y + header + index * row, barHeight = row * .38;
    text(ctx, template, bar.label, x + pad, top + row * .18, labelWidth * .87, row * .66, Math.min(row * .25, width * .025), colors.ink, 500);
    const value = Number.isFinite(bar.value) ? Math.max(0, bar.value) : 0;
    const fullWidth = plotWidth * .76, shown = clamp(progress * 1.2 - index / Math.max(1, template.bars.length) * .18);
    const eased = shown * shown * (3 - 2 * shown);
    ctx.fillStyle = colors.soft; ctx.beginPath(); ctx.roundRect(plotX, top + row * .25, fullWidth, barHeight, Math.min(barHeight / 2, 12)); ctx.fill();
    const fill = fullWidth * (value / maximum) * eased;
    if (fill > 0) { ctx.fillStyle = index % 2 ? colors.secondary : colors.accent; ctx.beginPath(); ctx.roundRect(plotX, top + row * .25, fill, barHeight, Math.min(barHeight / 2, fill / 2, 12)); ctx.fill(); }
    text(ctx, template, number(bar.value), plotX + fullWidth + plotWidth * .035, top + row * .18, plotWidth * .2, row * .66, Math.min(row * .25, width * .026), colors.ink, 600);
  });
}

/** Deterministic diagrams use the authored scene clock in both browser and node Canvas. */
export function drawSceneTemplate(canvas: HTMLCanvasElement, template: SceneTemplate, authoredProgress: number, captionArea?: { fontSize: number; lines: number; bottom: number; diagramTop?: number; diagramBottom?: number }): void {
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('当前环境无法创建模板画布');
  const width = canvas.width, height = canvas.height, side = Math.min(width, height), colors = palettes[template.palette] ?? palettes.sage;
  const progress = template.motion === 'none' ? 1 : clamp(authoredProgress);
  ctx.save(); ctx.clearRect(0, 0, width, height); ctx.fillStyle = colors.background; ctx.fillRect(0, 0, width, height);
  const x = width * .065, innerWidth = width - x * 2;
  const kind = template.kind === 'process' ? '流程与步骤' : template.kind === 'comparison' ? '并列比较' : '数据观察';
  text(ctx, template, kind, x, height * .055, innerWidth, height * .04, side * .021, colors.accent, 600);
  text(ctx, template, template.heading, x, height * .105, innerWidth, height * .115, side * .055, colors.ink, 600);
  const captionSize = captionArea?.fontSize ?? Math.max(12, Math.min(width * .027, height * .047)), captionLines = captionArea?.lines ?? (height > width ? 3 : 2);
  const bottom = captionArea?.diagramBottom ?? Math.min(height * .8, Math.max(height * .255 + 1, (captionArea?.bottom ?? height * .9) - captionSize * (captionLines * 1.55 + 1) - height * .025));
  const y = captionArea?.diagramTop ?? height * .255, available = Math.max(1, bottom - y);
  if (template.kind === 'process') process(ctx, template, x, y, innerWidth, available, progress, colors);
  else if (template.kind === 'comparison') comparison(ctx, template, x, y, innerWidth, available, progress, colors);
  else bars(ctx, template, x, y, innerWidth, available, progress, colors);
  ctx.restore();
}
