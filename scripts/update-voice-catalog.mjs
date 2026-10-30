import { writeFile } from 'node:fs/promises';

const sources = {
  openai: 'https://developers.openai.com/api/docs/guides/text-to-speech.md',
  qwen: 'https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list',
  volcengine: 'https://docs.volcengine.com/docs/doubao-voice/tone-list-3?lang=zh',
};
const clean = text => text.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\\-/g, '-').replace(/\*\*/g, '').trim();
function embedded(page, field) {
  const match = page.match(new RegExp(`"${field}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`));
  if (!match) throw new Error(`官方文档缺少 ${field}，请核对页面结构。`);
  return JSON.parse(match[1]);
}
const pages = await Promise.all(Object.values(sources).map(async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`官方文档请求失败：${response.status} ${url}`);
  return response.text();
}));
const section = pages[0].split('### Voice options')[1]?.split('### Streaming')[0];
if (!section) throw new Error('OpenAI 文档缺少音色章节。');
const openai = [...section.matchAll(/^- `([^`]+)`/gm)].map(match => ({ id: match[1], name: match[1] }));
const legacy = section.match(/`tts-1` and `tts-1-hd`[^\n]+/);
if (!legacy) throw new Error('OpenAI 文档缺少旧模型兼容范围。');
const openaiLegacy = [...legacy[0].matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(id => !id.startsWith('tts-'));
const qwenBody = embedded(pages[1], 'content').split('<h2 id="非实时')[1];
if (!qwenBody?.includes('qwen3-tts-flash')) throw new Error('Qwen 文档缺少非实时模型范围。');
const qwen = [...qwenBody.matchAll(/<tr>(.*?)<\/tr>/gs)].flatMap(match => {
  const text = clean(match[1]);
  const voice = text.match(/名称[：:]\s*(.*?)\s*voice\s*参数[：:]\s*(.*?)\s*描述[：:]/);
  return voice ? [{ id: voice[2], name: voice[1] }] : [];
});
const volcengine = { v1: [], v2: [] }; let version;
for (const line of embedded(pages[2], 'MDContent').split('\n')) {
  if (line.startsWith('## ')) version = line.includes('合成模型2.0') ? 'v2' : line.includes('合成模型1.0') ? 'v1' : undefined;
  if (!version || !line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map(clean);
  if (cells.length >= 3 && /^[A-Za-z][A-Za-z0-9_]+$/.test(cells[2]) && cells[2] !== 'voice_type') volcengine[version].push({ id: cells[2], name: cells[1] });
}
for (const version of ['v1', 'v2']) {
  const unique = new Map();
  for (const voice of volcengine[version]) {
    const previous = unique.get(voice.id);
    unique.set(voice.id, previous ? { id: voice.id, name: `${previous.name} / ${voice.name}` } : voice);
  }
  volcengine[version] = [...unique.values()];
}
for (const [name, voices] of Object.entries({ openai, qwen, ...volcengine })) {
  if (voices.length < (name === 'openai' ? 9 : 20) || voices.some(voice => !voice.id || !voice.name) || new Set(voices.map(voice => voice.id)).size !== voices.length) throw new Error(`${name} 音色目录数量或唯一性校验失败。`);
}
if (openaiLegacy.some(id => !openai.some(voice => voice.id === id))) throw new Error('OpenAI 兼容范围包含未知音色。');
const data = { sources, openai, openaiLegacy, qwen, volcengine };
await writeFile(new URL('../packages/contracts/src/voice-catalog.json', import.meta.url), `${JSON.stringify(data, null, 2)}\n`);
console.log(`已更新官方公共音色：OpenAI ${openai.length}，Qwen ${qwen.length}，豆包 1.0 ${volcengine.v1.length} / 2.0 ${volcengine.v2.length}。`);
