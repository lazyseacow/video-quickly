import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createHistoryWorkflow, DEFAULT_VIDEO_PROFILE, projectSchema, type AssetRecord, type ProjectDocument } from '@video-quickly/contracts';

export function seedHistoryProject(directory: string): { project: ProjectDocument; assets: AssetRecord[] } {
  const createdAt = new Date().toISOString();
  const projectId = 'example-history';
  const descriptions = [
    ['一纸登科，改变了什么？', '一张写满文字的纸，能改变一个人的命运吗？这一次，我们从唐代的考试说起。', '纸卷与远处城门，晨光照在案头。'],
    ['走进考场之前', '参加考试的人来自不同背景。谁能够读书、准备和赴考，仍然受到家庭与社会条件的影响。', '书案、书卷与一位读书人的剪影。'],
    ['考试之外的世界', '考试只是进入仕途的一环。理解制度，还需要把选拔过程与当时的社会放在一起观察。', '宫廷建筑与逐层展开的选拔路径。'],
    ['把问题留给证据', '制度怎样变化，又影响了谁？让我们带着这些问题，继续寻找可以核对的历史证据。', '人物、书卷与年代标注汇成一张知识卡。'],
  ];
  const assetDirectory = join(directory, 'projects', projectId, 'assets');
  mkdirSync(assetDirectory, { recursive: true });
  const assets: AssetRecord[] = descriptions.map((description, index) => {
    const svg = illustration(index);
    const path = join(assetDirectory, `scene-${index + 1}.svg`);
    writeFileSync(path, svg, 'utf8');
    return { id: `example-art-${index + 1}`, projectId, shotId: `shot-${index + 1}`, name: `${description[0]}.svg`, kind: 'image', path, mimeType: 'image/svg+xml', size: Buffer.byteLength(svg), sha256: createHash('sha256').update(svg).digest('hex'), version: 1, createdAt, provenance: '项目内原创示意插画；用于界面与动画示例，不作为史实证据。', retained: true, active: true };
  });
  const project = projectSchema.parse({
    id: projectId, title: '一纸登科，改变了什么？', brief: '面向普通观众，解释唐代科举与社会流动的关系。先整理可靠来源，区分事实与示意复原，再制作手绘科普短片。本项目是可编辑示例，旁白和事实主张仍待核验。', templateId: 'history-handdrawn', revision: 1, profile: DEFAULT_VIDEO_PROFILE,
    shots: descriptions.map(([title, narration, visualPrompt], index) => ({ id: `shot-${index + 1}`, title, narration, visualPrompt, durationUs: [7_000_000, 8_000_000, 8_000_000, 7_000_000][index], assetId: assets[index].id, claimIds: index === 1 ? ['claim-access'] : index === 2 ? ['claim-process'] : [], locked: false, animation: { panX: index % 2 === 0 ? 0.035 : -0.035, panY: 0, zoom: 1.06, transition: 'fade' } })),
    workflow: createHistoryWorkflow(), claims: [
      { id: 'claim-access', text: '唐代读书与赴考机会受到家庭及社会条件影响。', source: '', locator: '', status: 'pending' },
      { id: 'claim-process', text: '唐代考试与授官之间的具体关系需要查证。', source: '', locator: '', status: 'pending' },
    ], style: '深墨线条、淡赭与青绿、米色纸纹。固定人物和场景锚点；建筑与服饰均为待核对的示意复原。字幕在后期独立排版。', createdAt, updatedAt: createdAt, archived: false,
  });
  return { project, assets };
}

function illustration(index: number) {
  const skies = ['#d7e1dc', '#e5ddc9', '#dadfce', '#ded6c6'];
  const ornaments = index === 1 ? '<path d="M650 455v-190q35-50 70 0v190" fill="#4e6257"/><circle cx="685" cy="235" r="30" fill="#c9a376"/><path d="m647 274-45 130 55 22m55-150 48 128-49 18" fill="#597564"/>' : '<path d="M170 428h580V284H170z" fill="#d4b27c"/><path d="m110 290 110-70h480l110 70Z" fill="#4b6457"/><path d="m190 215 100-61h320l100 61Z" fill="#496253"/><path d="M305 430V310h125v120M485 430V310h125v120" fill="#594b3c"/><path d="M164 293h598M211 221h500" fill="none" stroke="#354b40" stroke-width="7"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675"><defs><pattern id="paper" width="48" height="48" patternUnits="userSpaceOnUse"><path d="m3 8 12 1m14 21 13-1M8 44l9-1" stroke="#897c5b" stroke-opacity=".07"/></pattern><linearGradient id="sky" x2="0" y2="1"><stop stop-color="${skies[index]}"/><stop offset="1" stop-color="#f0e8d8"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h1200v675H0z"/><circle cx="930" cy="130" r="65" fill="#e7c38b" opacity=".75"/><path d="M0 355q150-130 310-40t320-40 300 15 270-10v395H0" fill="#7b9883" opacity=".32"/><path d="M0 432q200-120 390-35t390-10 420 15v273H0" fill="#71826d" opacity=".28"/><g transform="translate(105 50)" stroke="#524f3f" stroke-linecap="round" stroke-linejoin="round" stroke-width="3">${ornaments}<path d="M100 453q330-35 700 3" fill="none" opacity=".5"/><path d="M194 505q270-35 520 0l40 89H170z" fill="#896c4e"/><path d="m302 475 280 13-15 96-285-15z" fill="#f3e6c9"/><path d="m320 500 206 11m-210 10 163 10m-166 9 193 9" stroke="#665844" opacity=".5"/><path d="m617 487 54-111 10 4-47 115" fill="#3c4c43"/></g><path fill="url(#paper)" d="M0 0h1200v675H0z"/><path d="M35 35h1130v605H35z" fill="none" stroke="#ffffff" stroke-opacity=".3" stroke-width="2"/></svg>`;
}
