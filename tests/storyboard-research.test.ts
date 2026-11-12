import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { modelSchema, projectSchema, runInspectionSchema, runSchema, runStepPayloadSchema, workflowNodeSchema } from '@video-quickly/contracts';
import { createRuntime, type RuntimeOptions } from '../src/packages/runtime/src';
import * as publicHttp from '../src/packages/runtime/src/public-tool-download';
import { readStoryboardWebResearch } from '../src/packages/runtime/src/storyboard-research';

const directories: string[] = [], runtimes: ReturnType<typeof createRuntime>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const names = ['acme/beam.js', ...Array.from({ length: 9 }, (_, index) => `open-labs/tool-${index + 1}`)];
function trendingPage(repositories: string[], withoutDescription?: string) {
  const cards = repositories.map(name => `<article class="Box-row">
    <h2 class="h3 lh-condensed"><a href="/${name}">${name.replace('/', ' / ')}</a></h2>
    ${name === withoutDescription ? '' : `<p class="color-fg-muted">${name === names[0] ? 'Beam plots charts &amp; maps.' : 'A developer tool.'}</p>`}
  </article>`);
  return new Response(`<main><a href="/nav/link">Unrelated link</a>${cards.join('\n')}</main>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function fixture(brief: string, storyboard: () => string, webResearch?: RuntimeOptions['webResearch'], nodeId?: string) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'vq-storyboard-research-')); directories.push(dataDirectory);
  const provider = vi.fn<NonNullable<RuntimeOptions['provider']>>(async ({ prompt }) => prompt.includes('自动视频制作步骤：简报') ? '本次简报要求用简短旁白逐项介绍。' : storyboard());
  const media = vi.fn<NonNullable<RuntimeOptions['executeActivity']>>(async () => ({ assets: [] }));
  const runtime = createRuntime({ dataDirectory, seed: false, provider, executeActivity: media, webResearch }); runtimes.push(runtime);
  const project = projectSchema.parse(await runtime.dispatch('project.create', { title: '视频项目', brief }));
  const model = modelSchema.parse(await runtime.dispatch('model.save', { model: { name: '文本夹具', provider: 'ollama', baseUrl: 'http://127.0.0.1:1', model: 'fixture', connectionType: 'text', capabilities: ['text'] } }));
  const nodes = [
    workflowNodeSchema.parse({ id: 'brief', kind: 'brief', label: '简报', modelId: model.id }),
    workflowNodeSchema.parse({ id: 'script', kind: 'script', label: '旁白与分镜', modelId: model.id }),
    workflowNodeSchema.parse({ id: 'assets', kind: 'assets', label: '后续素材' }),
  ];
  await runtime.dispatch('project.update', { projectId: project.id, patch: { workflow: {
    id: 'research-fixture', name: '视频制作', version: 1, nodes,
    production: { mode: 'native-video', referenceMode: 'none', soundPrompt: '', subtitleMode: 'off' },
    edges: [{ id: 'brief-script', source: 'brief', target: 'script' }, { id: 'script-assets', source: 'script', target: 'assets' }],
  } } });
  const run = runSchema.parse(await runtime.dispatch('run.start', { projectId: project.id, nodeId }));
  await runtime.waitForIdle();
  const inspect = async () => runInspectionSchema.parse(await runtime.dispatch('run.inspect', { runId: run.id }));
  const retry = async () => { await runtime.dispatch('run.step.retry', { runId: run.id, nodeId: 'script' }); await runtime.waitForIdle(); };
  return { runtime, run, provider, media, inspect, retry };
}

function storyboard(narration: string) {
  return JSON.stringify({ shots: [{ title: '开源项目榜单', narration, visualPrompt: '每个项目的独立标题卡片', durationUs: 6_000_000 }], entities: [] });
}

it('grounds the actual GitHub trend10 brief in ranked repositories and blocks placeholder narration until corrected', async () => {
  const readmeUrl = `https://api.github.com/repos/${names[6]}/readme`;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.href === readmeUrl) return new Response('# Tool\n\nA compiler for shader effects.', { headers: { 'content-type': 'application/vnd.github.raw+json' } });
    expect(url.origin + url.pathname).toBe('https://github.com/trending');
    return trendingPage(url.searchParams.get('since') === 'weekly' ? [...names, 'open-labs/outside-top-ten'] : names.slice(0, 9), names[6]);
  });
  let narration = `${names.slice(1).join('，')}。第一个项目是 acme/beam.js-next。`;
  const f = await fixture('说明最近的github trend10项目', () => storyboard(narration));
  const prompt = f.provider.mock.calls[1][0].prompt;
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://github.com/trending', 'https://github.com/trending?since=weekly', readmeUrl]);
  expect(prompt).toContain('https://github.com/trending?since=weekly');
  expect(prompt).toContain('Beam plots charts & maps.');
  expect(prompt).toContain('A compiler for shader effects.');
  expect(prompt).toContain('本次简报要求用简短旁白逐项介绍');
  const positions = names.map(name => prompt.indexOf(name));
  expect(positions[0]).toBeGreaterThanOrEqual(0);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(prompt).not.toContain('open-labs/outside-top-ten');
  expect((await f.inspect()).steps.find(step => step.id === 'script')).toMatchObject({ status: 'needs_attention', error: expect.stringContaining('acme/beam.js'), retry: { allowed: true } });
  expect(f.media).not.toHaveBeenCalled();

  narration = `${names.join('，')}。`;
  await f.retry();
  expect((await f.inspect()).steps.find(step => step.id === 'script')?.status).toBe('succeeded');
  expect(f.provider.mock.calls[2][0].prompt).toContain('上次分镜返回的字段校验错误');
  expect(fetch).toHaveBeenCalledTimes(3);
  await f.runtime.dispatch('run.resume', { runId: f.run.id }); await f.runtime.waitForIdle();
  expect(f.media.mock.calls[0][0].project.shots[0].narration).toBe(narration);
});

it('keeps nine daily repositories, supplements from the weekly ranking, and continues production', async () => {
  const weeklyUrl = 'https://github.com/trending?since=weekly';
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => String(input) === weeklyUrl
    ? trendingPage([names[0].toUpperCase(), names[9], 'open-labs/outside-top-ten'])
    : trendingPage(names.slice(0, 9)));
  const narration = names.join('，');
  const f = await fixture('介绍 GitHub Trending 前十个项目。制作前读取每日榜单。', () => storyboard(narration));
  expect(await f.inspect()).toMatchObject({ run: { status: 'succeeded' } });
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(['https://github.com/trending', weeklyUrl]);
  const prompt = f.provider.mock.calls[1][0].prompt;
  expect(prompt).toContain('日榜 9 项');
  expect(prompt).toContain('周榜补充 1 项');
  const evidence = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"sourceUrl"')) ?? 'null');
  expect(evidence.repositories.map((repo: { name: string }) => repo.name)).toEqual(names);
  expect(evidence.repositories[9]).toMatchObject({ rank: 2, source: { period: '周榜', sourceUrl: weeklyUrl } });
  expect(f.media.mock.calls[0][0].project.shots[0].narration).toBe(narration);
});

it('continues with the available verified repositories after a supplemental ranking fails', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const period = new URL(String(input)).searchParams.get('since');
    if (period === 'weekly') return new Response(null, { status: 503 });
    return trendingPage(period === 'monthly' ? [names[8]] : names.slice(0, 8));
  });
  const narration = names.slice(0, 9).join('，');
  const f = await fixture('介绍 GitHub Trending 日榜前 10 个项目。', () => storyboard(narration));
  expect(await f.inspect()).toMatchObject({ run: { status: 'succeeded' } });
  expect(fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('since'))).toEqual([null, 'weekly', 'monthly']);
  const prompt = f.provider.mock.calls[1][0].prompt;
  expect(prompt).toContain('按已核实的 9 项制作');
  expect(prompt).toContain('月榜补充 1 项');
  expect(f.media.mock.calls[0][0].project.shots[0].narration).toBe(narration);
});

it('resumes a production when a previously unavailable ranking returns without regenerating the brief', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('temporary connection reset'));
  const narration = names.join('，');
  const f = await fixture('介绍 GitHub Trending 日榜前 10 个项目。', () => storyboard(narration));
  expect(f.provider).toHaveBeenCalledTimes(1);
  expect(f.media).not.toHaveBeenCalled();
  expect((await f.inspect()).steps.find(step => step.id === 'script')).toMatchObject({ status: 'needs_attention', retry: { allowed: true } });

  fetch.mockImplementation(async input => trendingPage(new URL(String(input)).searchParams.get('since') === 'weekly' ? [names[9]] : names.slice(0, 9)));
  await f.runtime.dispatch('run.resume', { runId: f.run.id }); await f.runtime.waitForIdle();
  expect(await f.inspect()).toMatchObject({ run: { status: 'succeeded' } });
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect(f.media.mock.calls[0][0].project.shots[0].narration).toBe(narration);
});

const sourceUrl = 'https://science.example/tides';
const originalText = '潮汐主要由月球和太阳的引力引起。当地的海岸形状和海底地形会影响潮差和时间。月球、太阳和地球大致排成直线时，两者对潮汐的影响叠加，常出现较大的潮差。';
function publicPage(url: string, title = '海洋观测站的潮汐说明', body = originalText) {
  const document = `<title>${title}</title><main><p>${body}</p></main>`;
  const response = Object.assign(Readable.from([Buffer.from(document)]), { headers: { 'content-type': 'text/html; charset=UTF-8' } }) as IncomingMessage;
  return { response, url };
}

it('automatically reads non-GitHub sources before a standalone storyboard and retains them for a model retry', async () => {
  const search = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.hostname).toBe('html.duckduckgo.com');
    expect(url.searchParams.get('q')).toBe('潮汐为什么会变化');
    return new Response(`<a href="//duckduckgo.com/l/?uddg=${encodeURIComponent(sourceUrl)}&amp;rut=fixture" class="result__a">潮汐</a><div>搜索摘要不作为原文</div>`);
  });
  const open = vi.spyOn(publicHttp, 'openPublicHttp').mockImplementation(async url => publicPage(url));
  let output = '{"shots":[]}';
  const f = await fixture('## 主题\n潮汐为什么会变化\n## 画面风格\n蓝绿色水彩', () => output, readStoryboardWebResearch, 'script');
  expect(search).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0][0]).toBe(sourceUrl);
  const prompt = f.provider.mock.calls[0][0].prompt;
  for (const value of [sourceUrl, originalText, '海洋观测站的潮汐说明', 'capturedAt']) expect(prompt).toContain(value);
  expect(prompt).not.toContain('搜索摘要不作为原文');
  expect((await f.inspect()).steps.find(step => step.id === 'script')).toMatchObject({ retry: { allowed: true }, outputAvailable: false });

  output = storyboard('潮汐主要由月球和太阳的引力引起。');
  await f.retry();
  const inspect = await f.inspect();
  expect(inspect.run.status).toBe('succeeded');
  expect(f.provider.mock.calls[1][0].prompt).toContain(originalText);
  expect(search).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledTimes(1);
  const input = runStepPayloadSchema.parse(await f.runtime.dispatch('run.step.payload', { runId: f.run.id, nodeId: 'script', kind: 'input' }));
  expect(input.value).toMatchObject({ resolvedPrompt: expect.stringContaining(sourceUrl) });
  expect(f.media).not.toHaveBeenCalled();
});

it('stops a project that needs current public information before dispatching its storyboard, and retries unavailable evidence', async () => {
  const noticeUrl = 'https://city.example/transit/notice';
  const notice = '市区公交第八路将在本周五晚间临时绕行滨河大道，站点调整仅适用于施工时段。市政服务大厅入口附近会增设临时站点，乘客可按站牌提示候车。';
  const search = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => new URL(String(input)).hostname === 'html.duckduckgo.com'
    ? new Response(null, { status: 503 }) : new Response(`<rss><channel><item><link>${noticeUrl}</link></item></channel></rss>`));
  const open = vi.spyOn(publicHttp, 'openPublicHttp').mockRejectedValueOnce(new Error('HTTP 503')).mockImplementation(async url => publicPage(url, '市区公交临时调整公告', notice));
  const f = await fixture('联网搜索本周发布的市区公交调整公告', () => storyboard('请根据实际公告安排出行。'), readStoryboardWebResearch);
  expect(f.provider).toHaveBeenCalledTimes(1); // Upstream brief only.
  expect(f.media).not.toHaveBeenCalled();
  expect((await f.inspect()).steps.find(step => step.id === 'script')).toMatchObject({ status: 'needs_attention', error: expect.stringContaining('未读到分镜所需的网页正文'), retry: { allowed: true } });

  await f.retry();
  expect(f.provider.mock.calls[1][0].prompt).toContain(noticeUrl);
  expect(f.provider.mock.calls[1][0].prompt).toContain(notice);
  expect(search.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(['html.duckduckgo.com', 'www.bing.com', 'html.duckduckgo.com', 'www.bing.com']);
  expect(open).toHaveBeenCalledTimes(2);
  expect((await f.inspect()).steps.find(step => step.id === 'script')?.status).toBe('succeeded');
});

it('continues a fictional project when optional web research is unavailable', async () => {
  const search = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  const f = await fixture('拍摄发生在今天的一段虚构短剧', () => storyboard('晚风吹动窗帘，门铃突然响起。'), readStoryboardWebResearch, 'script');
  expect(search).toHaveBeenCalledTimes(2);
  expect(f.provider.mock.calls[0][0].prompt).toContain('本次没有取得可用的网页正文');
  expect((await f.inspect()).run.status).toBe('succeeded');
});

it('can ground the storyboard in a supplied public link while the search index is unavailable', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
  const open = vi.spyOn(publicHttp, 'openPublicHttp').mockImplementation(async url => publicPage(url));
  const f = await fixture(`请读取这篇网页并介绍潮汐。${sourceUrl}`, () => storyboard('海水会随月球和太阳的引力发生周期性的涨落。'), readStoryboardWebResearch, 'script');
  expect(open).toHaveBeenCalledTimes(1);
  expect(open.mock.calls[0][0]).toBe(sourceUrl);
  expect(f.provider.mock.calls[0][0].prompt).toContain(originalText);
  expect((await f.inspect()).run.status).toBe('succeeded');
});
