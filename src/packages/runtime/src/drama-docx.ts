import { readFile, stat } from 'node:fs/promises';
import { unzipSync } from 'fflate';

const documentLimit = 2_000_000;

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('DOCX 包含无效的文字编码。');
      return String.fromCodePoint(code);
    }
    const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    return entities[name.toLowerCase()] ?? entity;
  });
}

/** Reads the main story only; embedded media, fields and external relationships are never opened. */
export async function readDramaDocx(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > 10_000_000) throw new Error('请选择不超过 10 MB 的非空 DOCX 文件。');
  let document: Uint8Array | undefined;
  try {
    let documents = 0;
    const archive = unzipSync(new Uint8Array(await readFile(path)), { filter(file) {
      if (file.name !== 'word/document.xml') return false;
      if (++documents > 1 || file.originalSize > documentLimit) throw new Error('DOCX 正文结构无效或解压后超过 2 MB。');
      return true;
    } });
    document = archive['word/document.xml'];
  } catch (error) {
    throw new Error('无法读取 DOCX，请确认文件完整且正文解压后不超过 2 MB。', { cause: error });
  }
  if (!document?.length || document.length > documentLimit) throw new Error('DOCX 没有可读取的剧本正文。');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(document);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCX 正文包含不支持的 XML 声明。');
  const namespace = /xmlns:([\w]+)=["']http:\/\/(?:schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|purl\.oclc\.org\/ooxml\/wordprocessingml\/main)["']/.exec(xml)?.[1];
  if (!namespace || !new RegExp(`<${namespace}:document\\b`).test(xml)) throw new Error('DOCX 缺少有效的 Word 正文。');
  // Deleted revisions and field instructions are not part of the visible script.
  const visible = xml.replace(new RegExp(`<${namespace}:del\\b[^>]*>[\\s\\S]*?<\\/${namespace}:del>`, 'g'), '');
  const tokens = new RegExp(`<${namespace}:t(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${namespace}:t>|<${namespace}:(?:br|cr)\\b[^>]*\\/>|<${namespace}:tab\\b[^>]*\\/>|<\\/${namespace}:(?:p|tr)>|<\\/${namespace}:tc>`, 'g');
  const parts: string[] = [];
  for (const token of visible.matchAll(tokens)) {
    if (token[1] !== undefined) parts.push(decodeXmlText(token[1]));
    else parts.push(token[0].includes(':tab') || token[0].endsWith(':tc>') ? '\t' : '\n');
  }
  const text = parts.join('').replace(/\r\n?/g, '\n').replace(/\t*\n/g, '\n').trim();
  if (!text) throw new Error('DOCX 中没有可读取的文字。图片扫描剧本请先转换为文字。');
  return text;
}
