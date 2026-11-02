import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { researchResultSchema, researchSearchResultSchema, researchSourceSchema, type Claim, type ProjectDocument, type ResearchResult, type ResearchSource } from '@video-quickly/contracts';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const researchReadInputSchema = z.object({ text: z.string().optional(), path: z.string().min(1).optional(), url: z.string().url().optional(), title: z.string().min(1).max(500).optional() })
  .refine(value => [value.text, value.path, value.url].filter(item => item !== undefined).length === 1, '请只选择粘贴正文、文件或网址中的一种。');
export const researchSearchInputSchema = z.object({ query: z.string().trim().min(1).max(500), language: z.enum(['zh', 'en']).default('zh'), limit: z.number().int().min(1).max(10).default(5) });

function checkedUrl(raw: string) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('资料地址须为不含账号密码的 HTTP 或 HTTPS 地址。');
  return url;
}
async function readResponse(response: Response) {
  if (!response.ok) { await response.body?.cancel(); throw new Error(`资料服务返回 HTTP ${response.status}，请检查地址或稍后重试。`); }
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); throw new Error('网络资料超过 2 MB，请保存摘录后导入。'); }
  if (!response.body) throw new Error('资料服务未返回正文。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('网络资料超过 2 MB，请保存摘录后导入。'); } chunks.push(chunk.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
async function fetchDocument(raw: string) {
  let url = checkedUrl(raw); const signal = AbortSignal.timeout(20_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(url, { redirect: 'manual', signal, headers: { 'User-Agent': 'VideoQuickly/0.1 (https://github.com/lazyseacow/video-quickly)', Accept: 'text/html,text/plain,application/json,application/pdf;q=0.9' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location || redirects === 5) throw new Error('资料网址重定向过多或缺少目标地址。');
      url = checkedUrl(new URL(location, url).toString()); continue;
    }
    return { bytes: await readResponse(response), type: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '', url: url.toString() };
  }
  throw new Error('资料网址重定向过多。');
}
function decodeEntities(text: string) {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, key: string) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()] ?? whole;
    const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : whole;
  });
}
function htmlText(html: string) {
  const body = html.match(/<(?:article|main)\b[^>]*>([\s\S]*?)<\/(?:article|main)>/i)?.[1] ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return decodeEntities(body.replace(/<!--[^]*?-->/g, '').replace(/<(script|style|noscript|head|iframe)\b[^>]*>[^]*?<\/\1\s*>/gi, '').replace(/<\/?(?:p|div|h[1-6]|li|br|tr|section|article|main)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
function plainText(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }
  catch { throw new Error('资料不是有效的 UTF-8 文本，请另存为 UTF-8 后导入。'); }
}
async function pdfText(bytes: Uint8Array) {
  const child = fork(fileURLToPath(new URL('./pdf-process.mjs', import.meta.url)), [], { execPath: process.execPath, execArgv: [], serialization: 'advanced', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Third-party diagnostics must not enter the JSON-RPC stdout protocol.
  child.stdout!.pipe(process.stderr, { end: false });
  child.stderr!.pipe(process.stderr, { end: false });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let content: string | undefined, failure: Error | undefined, terminating = false;
      const fail = (error: Error) => { failure ??= error; if (!terminating) { terminating = true; child.kill('SIGKILL'); } };
      timeout = setTimeout(() => fail(new Error('PDF 解析超过 20 秒，请拆分需要的页段后重试。')), 20_000);
      child.once('message', (message: unknown) => {
        if (message && typeof message === 'object' && 'content' in message && typeof message.content === 'string') content = message.content;
        else failure = new Error(message && typeof message === 'object' && 'error' in message && typeof message.error === 'string' ? message.error : 'PDF 解析未返回有效正文。');
      });
      child.on('error', fail);
      child.once('close', (code, signal) => {
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`PDF 解析子进程异常结束（${code ?? signal}），请重试或拆分资料。`));
        else if (content === undefined) reject(new Error('PDF 解析未返回有效正文。'));
        else resolve(content);
      });
      child.send(Uint8Array.from(bytes), error => { if (error) fail(error); });
    });
  } finally {
    clearTimeout(timeout);
    child.stdout!.unpipe(process.stderr);
    child.stderr!.unpipe(process.stderr);
  }
}
function capturedSource(content: string, metadata: Omit<ResearchSource, 'id' | 'content' | 'sha256' | 'capturedAt'>) {
  if (!content.trim()) throw new Error('资料没有可读取的正文，请粘贴原文或换用可访问的页面。');
  if (content.length > 100_000) throw new Error('资料正文超过 100,000 字符，请选择需要的摘录或拆分资料。');
  return researchSourceSchema.parse({ ...metadata, id: randomUUID(), content, sha256: createHash('sha256').update(content).digest('hex'), capturedAt: new Date().toISOString() });
}

export async function readResearchSource(raw: unknown): Promise<ResearchSource> {
  const input = researchReadInputSchema.parse(raw);
  if (input.text !== undefined) return capturedSource(input.text.replace(/\r\n?/g, '\n'), { kind: 'text', title: input.title ?? '粘贴的资料' });
  if (input.path) {
    const info = await stat(input.path); if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('资料文件须不超过 10 MB。');
    const extension = extname(input.path).toLowerCase();
    if (!['.txt', '.md', '.pdf'].includes(extension)) throw new Error('资料文件支持 UTF-8 TXT、Markdown 和有文字层的 PDF。');
    const bytes = await readFile(input.path);
    const content = extension === '.pdf' ? await pdfText(bytes) : plainText(bytes);
    return capturedSource(content, { kind: 'file', title: input.title ?? basename(input.path), fileName: basename(input.path) });
  }
  const url = checkedUrl(input.url!);
  // Fetch a concrete Wikipedia page body; search snippets never become evidence.
  if (/^(zh|en)\.wikipedia\.org$/.test(url.hostname) && !url.searchParams.has('oldid') && (url.pathname.startsWith('/wiki/') || url.searchParams.has('curid'))) {
    const api = new URL('/w/api.php', url);
    api.search = new URLSearchParams({ action: 'query', prop: 'extracts|info|revisions', explaintext: '1', inprop: 'url', rvprop: 'ids', redirects: '1', format: 'json', formatversion: '2', ...(url.searchParams.has('curid') ? { pageids: url.searchParams.get('curid')! } : { titles: decodeURIComponent(url.pathname.slice(6)).replaceAll('_', ' ') }) }).toString();
    const fetched = await fetchDocument(api.toString());
    const data = z.object({ query: z.object({ pages: z.array(z.object({ title: z.string(), extract: z.string().optional(), fullurl: z.string().url().optional(), revisions: z.array(z.object({ revid: z.number().int().positive() })).optional() })) }) }).parse(JSON.parse(fetched.bytes.toString('utf8')));
    const page = data.query.pages[0]; if (!page?.extract) throw new Error('维基百科页面没有可读取的正文。');
    const final = new URL(page.fullurl ?? url.toString()); if (page.revisions?.[0]) final.searchParams.set('oldid', String(page.revisions[0].revid));
    return capturedSource(page.extract, { kind: 'url', title: input.title ?? page.title, url: final.toString() });
  }
  const fetched = await fetchDocument(url.toString());
  let content: string, title = input.title;
  if (fetched.type === 'application/pdf') content = await pdfText(fetched.bytes);
  else if (fetched.type === 'text/html' || fetched.type === 'application/xhtml+xml') {
    const html = plainText(fetched.bytes); title ??= htmlText(html.match(/<title\b[^>]*>([^]*?)<\/title>/i)?.[1] ?? '').slice(0, 500) || undefined; content = htmlText(html);
  } else if (['text/plain', 'text/markdown'].includes(fetched.type)) content = plainText(fetched.bytes);
  else throw new Error('该网址没有返回可读取的文本、HTML 或 PDF，请粘贴实际原文。');
  return capturedSource(content, { kind: 'url', title: title ?? new URL(fetched.url).hostname, url: fetched.url });
}

export async function searchWikipedia(raw: unknown, origin?: string) {
  const input = researchSearchInputSchema.parse(raw), endpoint = new URL('/w/api.php', origin ?? `https://${input.language}.wikipedia.org`);
  endpoint.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: input.query, srlimit: String(input.limit), srprop: 'snippet', srnamespace: '0', utf8: '1', format: 'json', formatversion: '2' }).toString();
  const response = await fetchDocument(endpoint.toString());
  const data = z.object({ query: z.object({ search: z.array(z.object({ title: z.string(), pageid: z.number().int().positive(), snippet: z.string() })) }) }).parse(JSON.parse(response.bytes.toString('utf8')));
  return data.query.search.slice(0, input.limit).map(item => researchSearchResultSchema.parse({ title: item.title, pageId: item.pageid, snippet: htmlText(item.snippet), url: `https://${input.language}.wikipedia.org/?curid=${item.pageid}` }));
}

export interface ResearchPassages { sources: ResearchSource[]; usedRanges: ResearchResult['usedRanges']; passages: Array<{ sourceId: string; startOffset: number; endOffset: number; content: string }>; warnings: string[] }
export function selectResearchPassages(project: ProjectDocument, sourceIds?: string[], instruction = ''): ResearchPassages {
  const all = project.researchSources ?? [], sources = sourceIds ? sourceIds.map(id => { const source = all.find(source => source.id === id); if (!source) throw new Error('所选资料已移除，请重新选择。'); return source; }) : all;
  if (!sources.length) throw new Error('请先导入实际资料，再整理证据候选。');
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error('所选资料不能重复。');
  const query = `${project.brief} ${instruction}`.toLowerCase(), words = [...new Set([...(query.match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(word => !/[\u3400-\u9fff]/u.test(word)), ...(query.match(/[\u3400-\u9fff]/gu) ?? []).slice(0, 500).flatMap((letter, index, list) => index ? [`${list[index - 1]}${letter}`] : [])])].slice(0, 500);
  const chunks = sources.flatMap(source => Array.from({ length: Math.ceil(source.content.length / 1_800) }, (_, index) => { const startOffset = index * 1_800, endOffset = Math.min(source.content.length, startOffset + 1_800), content = source.content.slice(startOffset, endOffset), normalized = content.toLowerCase(); return { sourceId: source.id, startOffset, endOffset, content, score: words.reduce((score, word) => score + (normalized.includes(word) ? 1 : 0), 0) }; }));
  const chosen = new Set<string>(), passages: ResearchPassages['passages'] = []; let budget = 48_000;
  function add(chunk: typeof chunks[number]) { const key = `${chunk.sourceId}:${chunk.startOffset}`; if (chosen.has(key) || chunk.content.length > budget) return; chosen.add(key); budget -= chunk.content.length; const { score: _score, ...passage } = chunk; passages.push(passage); }
  for (const source of sources) { const best = chunks.filter(chunk => chunk.sourceId === source.id).sort((left, right) => right.score - left.score || left.startOffset - right.startOffset)[0]; if (best) add(best); }
  for (const chunk of chunks.sort((left, right) => right.score - left.score || left.startOffset - right.startOffset)) add(chunk);
  const warnings = passages.reduce((total, passage) => total + passage.content.length, 0) < sources.reduce((total, source) => total + source.content.length, 0) ? ['资料较长，本次只读取列出的关键词命中片段及开头片段；未对全文作出核验结论。'] : [];
  return { sources, passages, usedRanges: passages.map(({ sourceId, startOffset, endOffset }) => ({ sourceId, startOffset, endOffset })), warnings };
}

/** Validate every quote against the exact source ranges actually sent to the model. */
export function parseResearchResult(text: string, project: ProjectDocument, context: ResearchPassages, runId: string, nodeId: string): ResearchResult {
  const warnings = [...context.warnings], claims: Claim[] = [], shotSuggestions: ResearchResult['shotSuggestions'] = [];
  const proposalSchema = z.object({ text: z.string().trim().min(1).max(10_000), evidence: z.array(z.object({ sourceId: z.string(), quote: z.string().min(1).max(5_000), startOffset: z.number().int().nonnegative().optional(), endOffset: z.number().int().positive().optional() })).min(1).max(20), shotIds: z.array(z.string()).max(200).optional() });
  const parsed = z.object({ claims: z.array(z.unknown()).max(100) }).safeParse((() => { try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')); } catch { return undefined; } })());
  if (!parsed.success) warnings.push('模型未返回有效的结构化证据候选；原始结果仅供查看，没有写入事实主张。');
  for (const [index, raw] of (parsed.success ? parsed.data.claims : []).entries()) {
    const proposal = proposalSchema.safeParse(raw);
    if (!proposal.success) { warnings.push(`候选 ${index + 1} 格式无效，未作为事实主张。`); continue; }
    const evidence: NonNullable<Claim['evidence']> = []; let valid = true;
    for (const reference of proposal.data.evidence) {
      const source = context.sources.find(source => source.id === reference.sourceId);
      const matches = context.usedRanges.filter(range => range.sourceId === reference.sourceId).flatMap(range => {
        const offsets: number[] = []; if (!source) return offsets;
        if (reference.startOffset !== undefined) { if (reference.startOffset >= range.startOffset && reference.startOffset + reference.quote.length <= range.endOffset && source.content.slice(reference.startOffset, reference.startOffset + reference.quote.length) === reference.quote && (reference.endOffset === undefined || reference.endOffset === reference.startOffset + reference.quote.length)) offsets.push(reference.startOffset); return offsets; }
        let offset = range.startOffset;
        while ((offset = source.content.indexOf(reference.quote, offset)) !== -1 && offset + reference.quote.length <= range.endOffset) { offsets.push(offset); offset++; }
        return offsets;
      });
      const positions = [...new Set(matches)];
      if (!source || positions.length !== 1) { valid = false; break; }
      const startOffset = positions[0], line = source.content.slice(0, startOffset).split('\n').length;
      evidence.push({ sourceId: source.id, sourceSha256: source.sha256, startOffset, endOffset: startOffset + reference.quote.length, quote: reference.quote, locator: `第 ${line} 行 · 字符 ${startOffset}–${startOffset + reference.quote.length}` });
    }
    if (!valid) { warnings.push(`候选 ${index + 1} 的摘录未能唯一对应本次实际读取的原文，已排除。`); continue; }
    const id = `research-${createHash('sha256').update(`${runId}:${nodeId}:${index}`).digest('hex').slice(0, 32)}`;
    claims.push({ id, text: proposal.data.text, source: [...new Set(evidence.map(item => context.sources.find(source => source.id === item.sourceId)!.title))].join('；'), locator: evidence.map(item => item.locator).join('；'), status: 'pending', evidence, origin: { runId, nodeId, candidateId: id } });
    for (const shotId of proposal.data.shotIds ?? []) if (project.shots.some(shot => shot.id === shotId)) { let suggestion = shotSuggestions.find(suggestion => suggestion.shotId === shotId); if (!suggestion) { suggestion = { shotId, claimIds: [] }; shotSuggestions.push(suggestion); } if (!suggestion.claimIds.includes(id)) suggestion.claimIds.push(id); }
  }
  return researchResultSchema.parse({ version: 1, kind: 'research', projectId: project.id, runId, nodeId, sourceHashes: context.sources.map(source => ({ sourceId: source.id, sha256: source.sha256 })), usedRanges: context.usedRanges, warnings: warnings.slice(0, 100), claims, shotSuggestions, text: text.slice(0, 30_000) });
}
