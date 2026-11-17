import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, expect, it } from 'vitest';
import { readDramaDocx } from '../src/drama-docx';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(xml?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'vq-docx-')); directories.push(directory);
  const path = join(directory, 'script.docx');
  await writeFile(path, zipSync(xml ? { 'word/document.xml': strToU8(xml), 'word/media/ignored.txt': strToU8('not script') } : {}));
  return path;
}
const body = (content: string, prefix = 'w') => `<${prefix}:document xmlns:${prefix}="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><${prefix}:body>${content}</${prefix}:body></${prefix}:document>`;

it('reads actual DOCX paragraphs, split text runs, tables, breaks and XML entities as visible script', async () => {
  const path = await fixture(body('<w:p><w:r><w:t>第&#x4e00;场</w:t></w:r><w:r><w:t> 雨夜</w:t><w:br/><w:t>林夏：&lt;等我&gt;&amp;别走。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>人物</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>台词</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'));
  expect(await readDramaDocx(path)).toBe('第一场 雨夜\n林夏：<等我>&别走。\n人物\n\t台词');
});

it('accepts namespace aliases and excludes deleted revisions and field instructions', async () => {
  const path = await fixture(body('<x:p><x:del><x:r><x:delText>已删剧本</x:delText><x:t>也不导入</x:t></x:r></x:del><x:r><x:instrText>external instruction</x:instrText><x:t>保留对白</x:t></x:r></x:p>', 'x'));
  expect(await readDramaDocx(path)).toBe('保留对白');
});

it('rejects corrupt, empty, oversized and non-text documents without opening external relationships', async () => {
  await expect(readDramaDocx(await fixture())).rejects.toThrow('没有可读取');
  await expect(readDramaDocx(await fixture(body('<w:p/>')))).rejects.toThrow('没有可读取的文字');
  await expect(readDramaDocx(await fixture('<!DOCTYPE x [<!ENTITY test SYSTEM "file:///private">]>' + body('<w:p><w:r><w:t>&test;</w:t></w:r></w:p>')))).rejects.toThrow('XML 声明');
  await expect(readDramaDocx(await fixture(body(`<w:p><w:r><w:t>${'字'.repeat(700_000)}</w:t></w:r></w:p>`)))).rejects.toThrow('无法读取 DOCX');
  const corrupt = await fixture(); await writeFile(corrupt, 'not a zip');
  await expect(readDramaDocx(corrupt)).rejects.toThrow('无法读取 DOCX');
});
