import { videoProfileSchema, type VideoProfile } from '@video-quickly/contracts';

export interface ResultSection { heading: string; text: string }
export type ResultBlock =
  | { kind: 'paragraph' | 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: { text: string; ordinal?: number }[] }
  | { kind: 'profile'; profile: VideoProfile };

const fieldHeadings = new Set(['主题', '目标观众', '目标受众', '受众', '核心信息', '核心观点', '核心表达', '叙事顺序', '叙事结构', '内容结构', '预计时长', '预期时长', '目标时长', '表达要求', '制作要求', '成片规格', '视觉风格', '整体风格', '画风', '色彩', '色彩方案', '配色', '角色设定', '人物设定', '场景设定', '构图', '光线', '镜头语言', '声音设计', '注意事项']);

/** Recognize explicit result fields and headings; leave unfamiliar prose intact. */
export function resultSections(text: string): ResultSection[] {
  const sections: ResultSection[] = [];
  let current: ResultSection = { heading: '', text: '' };
  let fenced = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; current.text += `${current.text ? '\n' : ''}${line}`; continue; }
    if (fenced) { current.text += `\n${line}`; continue; }
    const heading = line.match(/^#{1,4}\s+(.+?)\s*#*$/);
    const field = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?([^:*：]{1,24}?)(?:\*\*)?\s*[:：](?:\*\*)?\s*(.*)$/);
    if (heading || field && fieldHeadings.has(field[1].trim())) {
      if (current.heading || current.text.trim()) sections.push({ ...current, text: current.text.trim() });
      current = { heading: heading?.[1] ?? field![1].trim(), text: field?.[2] ?? '' };
    } else current.text += `${current.text ? '\n' : ''}${line}`;
  }
  if (current.heading || current.text.trim()) sections.push({ ...current, text: current.text.trim() });
  return sections;
}

function profileBlocks(text: string): ResultBlock[] {
  const blocks: ResultBlock[] = [];
  let cursor = 0;
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false, end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end++; break; }
    }
    if (depth || quoted) break;
    let value: unknown;
    try { value = JSON.parse(text.slice(start, end)); }
    catch { start = end - 1; continue; }
    const parsed = videoProfileSchema.safeParse(value);
    if (parsed.success && value && typeof value === 'object' && Object.keys(value).every(key => ['width', 'height', 'frameRate', 'fitMode', 'previewScale'].includes(key))) {
      const before = text.slice(cursor, start).replace(/成片规格(?:为|是|[：:])?\s*$/, '').trim();
      if (before) blocks.push({ kind: 'paragraph', text: before });
      blocks.push({ kind: 'profile', profile: parsed.data });
      cursor = end;
    }
    start = end - 1;
  }
  const rest = text.slice(cursor).replace(cursor ? /^[；;，,]\s*/ : /^$/, '').trim();
  if (rest) blocks.push({ kind: 'paragraph', text: rest });
  return blocks;
}

export function resultBlocks(text: string): ResultBlock[] {
  const blocks: ResultBlock[] = [];
  let paragraph: string[] = [], list: Extract<ResultBlock, { kind: 'list' }> | undefined;
  let code: string[] | undefined;
  const flush = () => {
    if (paragraph.length) { blocks.push(...profileBlocks(paragraph.join('\n'))); paragraph = []; }
    if (list) { blocks.push(list); list = undefined; }
  };
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) { blocks.push({ kind: 'code', text: code.join('\n') }); code = undefined; }
      else { flush(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    const ordered = line.match(/^\s*(\d+)[.、)]\s+(.+)$/);
    const bullet = line.match(/^\s*[-*•]\s+(.+)$/);
    if (ordered || bullet) {
      if (paragraph.length || list && list.ordered !== Boolean(ordered)) flush();
      list ??= { kind: 'list', ordered: Boolean(ordered), items: [] };
      list.items.push({ text: ordered?.[2] ?? bullet![1], ...(ordered ? { ordinal: Number(ordered[1]) } : {}) });
    } else if (list && /^\s+\S/.test(line)) list.items[list.items.length - 1].text += `\n${line.trim()}`;
    else if (!line.trim()) flush();
    else { if (list) flush(); paragraph.push(line); }
  }
  flush();
  if (code) blocks.push({ kind: 'code', text: code.join('\n') });
  return blocks;
}
