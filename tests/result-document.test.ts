import { describe, expect, it } from 'vitest';
import { resultBlocks, resultSections } from '../src/renderer/lib/result-document';

describe('result document presentation', () => {
  it('keeps unfamiliar prose, URLs and repeated fields without inventing a summary', () => {
    const sections = resultSections('第一段普通结果\r\nhttps://example.com/reference\r\n自定义说明：保留\r\n主题：第一主题\r\n主题：补充主题');
    expect(sections).toEqual([{ heading: '', text: '第一段普通结果\nhttps://example.com/reference\n自定义说明：保留' }, { heading: '主题', text: '第一主题' }, { heading: '主题', text: '补充主题' }]);
  });

  it('recognizes explicit field and markdown headings while leaving fenced content together', () => {
    expect(resultSections('**主题**：用 AI 处理日常工作\n**目标观众：**职场新人\n## 叙事顺序\n1. 开场\n2. 方法\n\n```text\n主题：这行是原始代码\n```')).toEqual([
      { heading: '主题', text: '用 AI 处理日常工作' }, { heading: '目标观众', text: '职场新人' }, { heading: '叙事顺序', text: '1. 开场\n2. 方法\n\n```text\n主题：这行是原始代码\n```' },
    ]);
  });

  it('keeps list numbering, multiline items, paragraphs and code in reading order', () => {
    expect(resultBlocks('开头\n\n3. 第三步\n   补充说明\n5. 第五步\n\n- 画面\n- 声音\n\n```html\n<script>danger()</script>\n```\n结尾')).toEqual([
      { kind: 'paragraph', text: '开头' }, { kind: 'list', ordered: true, items: [{ text: '第三步\n补充说明', ordinal: 3 }, { text: '第五步', ordinal: 5 }] },
      { kind: 'list', ordered: false, items: [{ text: '画面' }, { text: '声音' }] }, { kind: 'code', text: '<script>danger()</script>' }, { kind: 'paragraph', text: '结尾' },
    ]);
  });

  it('reads a real multiline profile with fractional frame rate without losing surrounding requirements', () => {
    const profile = { width: 1920, height: 1080, frameRate: { numerator: 30000, denominator: 1001 }, fitMode: 'contain', previewScale: .5 };
    expect(resultBlocks(`漫画风格；成片规格为${JSON.stringify(profile, null, 2)}；保留工作场景。`)).toEqual([
      { kind: 'paragraph', text: '漫画风格；' }, { kind: 'profile', profile }, { kind: 'paragraph', text: '保留工作场景。' },
    ]);
  });

  it('preserves invalid, incomplete and unrelated JSON as text rather than displaying fabricated profile values', () => {
    for (const text of ['参数 {"width":1920,', '参数 {"width":-1,"height":1080,"frameRate":{"numerator":0,"denominator":1}}', '参数 {"description":"braces } and \\"quote\\""}', '参数 {"width":1920,"height":1080,"frameRate":{"numerator":30,"denominator":1},"custom":"保留"}']) {
      expect(resultBlocks(text)).toEqual([{ kind: 'paragraph', text }]);
    }
  });
});
