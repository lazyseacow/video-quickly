import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { projectSchema, DEFAULT_VIDEO_PROFILE, createHistoryWorkflow } from '@video-quickly/contracts';
import { parseResearchResult, readResearchSource, searchWikipedia, selectResearchPassages } from './research.js';
import { chineseResearchPdf, researchPdf } from '../../../tests/research-fixtures.js';

const directories: string[] = [], servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }))); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const path = await mkdtemp(join(tmpdir(), 'video-quickly-research-')); directories.push(path); return path; }
function project() { return projectSchema.parse({ id: 'project', title: '核验资料', brief: 'paper', profile: DEFAULT_VIDEO_PROFILE, createdAt: '', updatedAt: '', revision: 1, workflow: createHistoryWorkflow(), shots: [{ id: 'shot', title: '引用镜头', narration: '待写旁白', visualPrompt: '', durationUs: 1_000_000 }] }); }

it('reads real text and two-page PDFs with exact captured hashes and refuses scanned, oversized and ambiguous inputs', async () => {
  const path = await directory(), text = join(path, 'source.md'), pdf = join(path, 'source.pdf');
  await writeFile(text, '\uFEFF真实原文\r\n第二行🙂'); await writeFile(pdf, researchPdf());
  const source = await readResearchSource({ path: text }); expect(source.content).toBe('真实原文\n第二行🙂'); expect(source.sha256).toBe(createHash('sha256').update(source.content).digest('hex')); expect(source.fileName).toBe('source.md');
  const document = await readResearchSource({ path: pdf }); expect(document.content).toContain('【第 1 页】\nFirst page evidence about paper.'); expect(document.content).toContain('【第 2 页】\nSecond page evidence about printing.');
  await writeFile(pdf, researchPdf([''])); await expect(readResearchSource({ path: pdf })).rejects.toThrow('未提取到文字层');
  await writeFile(pdf, researchPdf(Array.from({ length: 81 }, () => 'one page'))); await expect(readResearchSource({ path: pdf })).rejects.toThrow('80 页');
  await expect(readResearchSource({ text: 'x'.repeat(100_001) })).rejects.toThrow('100,000'); await expect(readResearchSource({ text: 'source', path: text })).rejects.toThrow('一种');
  await writeFile(text, Buffer.from([0xff, 0xfe, 0x80])); await expect(readResearchSource({ path: text })).rejects.toThrow('UTF-8');
}, 20_000);

it('extracts native Chinese CID text and a surrogate pair from a real PDF before validating exact quote offsets and hash', async () => {
  const path = join(await directory(), '中文原生证据.pdf'), bytes = chineseResearchPdf(); await writeFile(path, bytes);
  // The source bytes contain encoded CIDs, not the expected Chinese UTF-8 text.
  expect(bytes.includes(Buffer.from('纸张由植物纤维构成。'))).toBe(false);
  const source = await readResearchSource({ path });
  expect(source.content).toContain('【第 1 页】\n中文资料🙂：纸张由植物纤维构成。'); expect(source.content).toContain('【第 2 页】\n第二页证据：核对原文，不冒充已核验。');
  expect(source.sha256).toBe(createHash('sha256').update(source.content).digest('hex'));
  const value = { ...project(), researchSources: [source] }, quote = '🙂：纸张由植物纤维构成。', startOffset = source.content.indexOf(quote);
  const result = parseResearchResult(JSON.stringify({ claims: [{ text: '中文资料中的待核验主张', evidence: [{ sourceId: source.id, quote }] }] }), value, selectResearchPassages(value), 'chinese-pdf-run', 'research');
  expect(result.claims).toHaveLength(1); expect(result.claims[0].status).toBe('pending'); expect(result.claims[0].evidence?.[0]).toMatchObject({ quote, startOffset, endOffset: startOffset + quote.length, sourceSha256: source.sha256 });
  expect(quote.length).toBe(Array.from(quote).length + 1);
}, 20_000);

it('performs actual HTTP search and separately captures the real page body with bounded reads and safe redirects', async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url?.startsWith('/w/api.php')) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ query: { search: [{ title: '造纸', pageid: 42, snippet: '<span class="searchmatch">造纸</span>的搜索摘要' }] } })); }
    else if (request.url === '/redirect') { response.writeHead(302, { location: '/document' }); response.end(); }
    else if (request.url === '/document') { response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<html><title>真实页面 &amp; 原文</title><body><nav>菜单</nav><main><p>页面真实证据🙂。</p><script>不可作为正文</script><p>第二段。</p></main></body></html>'); }
    else if (request.url === '/huge') { response.setHeader('content-type', 'text/plain'); response.write('x'.repeat(2 * 1024 * 1024)); response.end('over limit'); }
    else if (request.url === '/badredirect') { response.writeHead(302, { location: 'file:///etc/passwd' }); response.end(); }
    else { response.setHeader('content-type', 'application/octet-stream'); response.end('binary'); }
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试服务地址无效'); const origin = `http://127.0.0.1:${address.port}`;
  const hits = await searchWikipedia({ query: '造纸', language: 'zh', limit: 1 }, origin); expect(hits).toEqual([{ title: '造纸', pageId: 42, snippet: '造纸的搜索摘要', url: 'https://zh.wikipedia.org/?curid=42' }]); expect(requests[0]).toContain('list=search'); expect(decodeURIComponent(requests[0])).toContain('造纸');
  const source = await readResearchSource({ url: `${origin}/redirect` }); expect(source.url).toBe(`${origin}/document`); expect(source.title).toBe('真实页面 & 原文'); expect(source.content).toContain('页面真实证据🙂。'); expect(source.content).not.toContain('不可作为正文'); expect(source.content).not.toContain('搜索摘要');
  await expect(readResearchSource({ url: `${origin}/huge` })).rejects.toThrow('2 MB'); await expect(readResearchSource({ url: `${origin}/badredirect` })).rejects.toThrow('HTTP'); await expect(readResearchSource({ url: `${origin}/binary` })).rejects.toThrow('可读取');
});

it('accepts only uniquely matching quotes in the actual sent ranges and never imports model verification or unknown references', async () => {
  const source = await readResearchSource({ text: '🙂真实资料指出，纸张由植物纤维构成。\n第二段原文。', title: '实际资料' }), value = { ...project(), researchSources: [source] }, context = selectResearchPassages(value);
  const quote = '纸张由植物纤维构成。';
  const result = parseResearchResult(JSON.stringify({ claims: [{ text: '纸张由植物纤维构成', status: 'verified', evidence: [{ sourceId: source.id, quote }], shotIds: ['shot', 'missing'] }, { text: '凭空引用', evidence: [{ sourceId: source.id, quote: '从未出现过的原文' }] }, { text: '假来源', evidence: [{ sourceId: 'invented', quote }] }] }), value, context, 'run', 'research');
  expect(result.projectId).toBe(value.id); expect(result.claims).toHaveLength(1); expect(result.claims[0].status).toBe('pending'); expect(result.claims[0].evidence?.[0]).toMatchObject({ startOffset: source.content.indexOf(quote), endOffset: source.content.indexOf(quote) + quote.length, quote, sourceSha256: source.sha256 }); expect(result.warnings).toHaveLength(2); expect(result.shotSuggestions).toEqual([{ shotId: 'shot', claimIds: [result.claims[0].id] }]);
  const invalid = parseResearchResult('仅有普通模型文字', value, context, 'run', 'research'); expect(invalid.claims).toEqual([]); expect(invalid.warnings[0]).toContain('结构化');
  const limited = { ...context, usedRanges: [{ sourceId: source.id, startOffset: 0, endOffset: 2 }] };
  expect(parseResearchResult(JSON.stringify({ claims: [{ text: '未送模资料', evidence: [{ sourceId: source.id, quote }] }] }), value, limited, 'run', 'research').claims).toEqual([]);
  const repeated = await readResearchSource({ text: '相同摘录。相同摘录。' }), repeatedProject = { ...project(), researchSources: [repeated] };
  expect(parseResearchResult(JSON.stringify({ claims: [{ text: '模糊摘录', evidence: [{ sourceId: repeated.id, quote: '相同摘录。' }] }] }), repeatedProject, selectResearchPassages(repeatedProject), 'run', 'research').claims).toEqual([]);
});

it('selects real keyword passages with a bounded total and reports omitted text', async () => {
  const source = await readResearchSource({ text: `${'ordinary content. '.repeat(3_000)}\nunique printing evidence.\n${'tail. '.repeat(2_000)}` }), value = { ...project(), brief: 'unique printing evidence', researchSources: [source] }, context = selectResearchPassages(value);
  expect(context.passages.some(passage => passage.content.includes('unique printing evidence'))).toBe(true); expect(context.passages.reduce((sum, passage) => sum + passage.content.length, 0)).toBeLessThanOrEqual(48_000); expect(context.warnings[0]).toContain('未对全文');
  for (const passage of context.passages) expect(passage.content).toBe(source.content.slice(passage.startOffset, passage.endOffset));
});
