export type StudioCreationFlow = 'novel' | 'upload' | 'write' | 'planning';

const requestPrefix = /^(?:(?:我)?(?:想(?:要)?|要|需要|希望)\s*)?(?:(?:请|麻烦)(?:你)?\s*)?(?:(?:帮|给|为)我\s*)?/u;
const commandBoundary = /[\s：:，,。.!！?？；;]/u;
const commandSeparator = /^[：:，,。.!！?？；;]/u;
const styleExtraction = /^(?:只|仅)?提取(?:(?:参考图|图片)的?)?(?:视觉)?风格/u;
const referencePlanning = /^(?:根据|按照|参考)(?:这[张幅组]|提供的|上传的)?(?:参考图|图片|图|风格卡)\s*(?:创作|生成|制作|设计|做|出)(?:一?[份个段组])?分镜(?:脚本|方案)?/u;
const commands: readonly (readonly [StudioCreationFlow, RegExp])[] = [
  ['novel', /^(?:改编(?:一[段章篇本部])?小说(?:原文)?(?:成短剧|为短剧)?|把(?:这[段章篇本部]|以下|下面的?)?小说(?:原文)?改编(?:成|为)短剧)/u],
  ['upload', /^(?:(?:上传|导入)(?:一[份部篇])?(?:已有|写好的)?剧本|已有剧本)/u],
  ['write', /^(?:制作剧本|(?:写作?|创作|生成)(?:一?[个篇部])?(?:短剧剧本|短剧|剧本))/u],
  ['planning', referencePlanning],
  ['planning', /^(?:创作|生成|制作|设计|做|出)(?:一?[份个段组])?分镜(?:脚本|方案)?/u],
  ['planning', styleExtraction],
];

function leadingCommand(text: string) {
  const request = text.replace(requestPrefix, '');
  for (const [flow, pattern] of commands) {
    const match = pattern.exec(request);
    if (!match) continue;
    const rest = request.slice(match[0].length);
    if (rest && !commandBoundary.test(rest[0])) continue;
    return { flow, pattern, content: rest.trimStart().replace(commandSeparator, '').trim() };
  }
  return undefined;
}

export function resolveStudioIntent(text: string): { flow: StudioCreationFlow; content: string } | undefined {
  const original = text.trim();
  const command = leadingCommand(original);
  if (!command) return undefined;

  // An alternative immediately after the command needs clarification. Words further into the material need no interpretation.
  const nextCommand = command.content.replace(/^(?:还是|或者|抑或|同时|并且|顺便|接着|然后|要不|再)\s*(?:先\s*)?/u, '');
  const competing = leadingCommand(nextCommand);
  if (competing && competing.flow !== command.flow) return undefined;
  if (/^(?:算了|我(?:还|又)没想好|先不做)(?:[\s，,。！!？?]|$)/u.test(command.content)) return undefined;

  const keepOriginal = command.flow === 'planning' && (command.content || command.pattern === styleExtraction || command.pattern === referencePlanning);
  return { flow: command.flow, content: keepOriginal ? original : command.content };
}
