import { useMemo } from 'react';
import { formatFrameRate, type VideoProfile } from '@video-quickly/contracts';
import { resultBlocks, resultSections, type ResultSection } from '../lib/result-document';

function InlineResult({ text }: { text: string }) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => part.startsWith('**') && part.endsWith('**')
    ? <strong key={index}>{part.slice(2, -2)}</strong>
    : part.startsWith('`') && part.endsWith('`') ? <code key={index}>{part.slice(1, -1)}</code> : part);
}

export function VideoProfileResult({ profile }: { profile: VideoProfile }) {
  return <dl className="result-document__specs" aria-label="成片规格">
    <div><dt>分辨率</dt><dd>{profile.width} × {profile.height}</dd></div>
    <div><dt>帧率</dt><dd>{formatFrameRate(profile.frameRate)} fps</dd></div>
    <div><dt>画面适配</dt><dd>{{ contain: '完整显示', cover: '裁切填满', blur: '模糊背景' }[profile.fitMode]}</dd></div>
  </dl>;
}

function DocumentBody({ text }: { text: string }) {
  return resultBlocks(text).map((block, index) => {
    if (block.kind === 'profile') return <VideoProfileResult key={index} profile={block.profile} />;
    if (block.kind === 'code') return <pre key={index}>{block.text}</pre>;
    if (block.kind === 'list') {
      const items = block.items.map((item, index) => <li key={index} value={item.ordinal}><InlineResult text={item.text} /></li>);
      return block.ordered ? <ol key={index} className="result-document__sequence">{items}</ol> : <ul key={index}>{items}</ul>;
    }
    return <p key={index}><InlineResult text={block.text} /></p>;
  });
}

const overviewHeadings = new Set(['目标观众', '目标受众', '受众', '预计时长', '预期时长', '预期成片时长', '目标时长']);
const detailHeadings = new Set(['表达要求', '制作要求', '注意事项']);

export default function ResultDocument({ text, title, label, fields }: { text: string; title?: string; label: string; fields?: ResultSection[] }) {
  const sections = useMemo(() => fields ?? resultSections(text), [fields, text]);
  const topic = sections.find(section => section.heading === '主题' && section.text);
  const overview = sections.filter(section => overviewHeadings.has(section.heading) && section.text && !section.text.includes('\n'));
  return <article className="step-result__document result-document" aria-label={label}>
    {(topic || title) && <header className="result-document__heading">{topic && <span>主题</span>}<h3><InlineResult text={topic?.text ?? title!} /></h3></header>}
    {overview.length > 0 && <dl className="result-document__overview" aria-label="结果概览">{overview.map((section, index) => <div key={index}><dt>{section.heading}</dt><dd><InlineResult text={section.text} /></dd></div>)}</dl>}
    {sections.filter(section => section !== topic && !overview.includes(section)).map((section, index) => {
      const content = <DocumentBody text={section.text} />;
      if (detailHeadings.has(section.heading) && section.text.length > 240) return <details key={index} className="result-document__details"><summary>{section.heading}</summary><div>{content}</div></details>;
      return <section key={index} className={['核心信息', '核心观点', '核心表达'].includes(section.heading) ? 'result-document__highlight' : 'result-document__section'} aria-label={section.heading || undefined}>
        {section.heading && <h4>{section.heading}</h4>}{content}
      </section>;
    })}
    <details className="result-document__original"><summary>查看完整原文</summary><pre>{text}</pre></details>
  </article>;
}
