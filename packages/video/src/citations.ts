import type { Claim, ClaimEvidence, ProjectDocument, ResearchSource } from '@video-quickly/contracts';
import { SCENE_TEMPLATE_FONT_FAMILY } from './scene-templates.js';

export interface CitationEvidence extends ClaimEvidence {
  source?: Omit<ResearchSource, 'content'>;
  valid: boolean;
  issue?: string;
}
export interface CitationReference {
  number: number; claimId: string; text: string; source: string; locator: string; status: Claim['status'];
  reviewedAt?: string; reviewNote?: string; origin?: Claim['origin'];
  evidenceState: 'valid' | 'missing' | 'invalid'; evidence: CitationEvidence[]; issues: string[];
}
export interface CitationManifest {
  version: 1; display: 'hidden' | 'numbers'; references: CitationReference[];
  shots: Array<{ shotId: string; startUs: number; endUs: number; claimIds: string[]; numbers: number[]; issues: string[] }>;
  warnings: string[];
}
export interface CitationOverlay {
  numbers: number[]; label: string; status: 'verified' | 'pending' | 'disputed' | 'missing'; notes: string[];
}
type CitationProject = Pick<ProjectDocument, 'claims' | 'researchSources' | 'referenceDisplay' | 'shots'>;

function evidenceRecord(evidence: ClaimEvidence, sources: Map<string, ResearchSource>, duplicates: Set<string>): CitationEvidence {
  const source = sources.get(evidence.sourceId);
  let issue: string | undefined;
  if (!source) issue = '证据来源缺失';
  else if (duplicates.has(source.id)) issue = '证据来源编号重复';
  else if (source.sha256 !== evidence.sourceSha256) issue = '证据来源校验值不一致';
  else if (evidence.startOffset < 0 || evidence.endOffset > source.content.length || evidence.endOffset <= evidence.startOffset) issue = '证据摘录超出保存资料范围';
  else if (source.content.slice(evidence.startOffset, evidence.endOffset) !== evidence.quote) issue = '证据摘录与保存资料不一致';
  const metadata = source ? { id: source.id, title: source.title, kind: source.kind, sha256: source.sha256, capturedAt: source.capturedAt, url: source.url, fileName: source.fileName } : undefined;
  return { ...evidence, source: metadata, valid: !issue, ...(issue ? { issue } : {}) };
}

/** Directory entries only describe claims actually bound to a shot; captured full text stays private to the project. */
export function createCitationManifest(project: CitationProject): CitationManifest {
  const used = new Set(project.shots.flatMap(shot => shot.claimIds));
  const sources = new Map<string, ResearchSource>(), duplicateSources = new Set<string>();
  for (const source of project.researchSources ?? []) { if (sources.has(source.id)) duplicateSources.add(source.id); else sources.set(source.id, source); }
  const claims = new Map<string, Claim>(), duplicateClaims = new Set<string>();
  for (const claim of project.claims) { if (claims.has(claim.id)) duplicateClaims.add(claim.id); else claims.set(claim.id, claim); }
  const references: CitationReference[] = [], included = new Set<string>();
  project.claims.forEach((claim, index) => {
    if (!used.has(claim.id) || included.has(claim.id)) return;
    included.add(claim.id);
    const evidence = (claim.evidence ?? []).map(value => evidenceRecord(value, sources, duplicateSources));
    const issues = [...new Set(evidence.flatMap(value => value.issue ? [value.issue] : []))];
    if (!evidence.length) issues.push('无证据摘录');
    if (duplicateClaims.has(claim.id)) issues.push('事实主张编号重复');
    const evidenceState = duplicateClaims.has(claim.id) || evidence.some(value => !value.valid) ? 'invalid' : evidence.length ? 'valid' : 'missing';
    references.push({ number: index + 1, claimId: claim.id, text: claim.text, source: claim.source, locator: claim.locator, status: claim.status, reviewedAt: claim.reviewedAt, reviewNote: claim.reviewNote, origin: claim.origin ? { ...claim.origin } : undefined, evidenceState, evidence, issues });
  });
  let missingNumber = project.claims.length;
  for (const id of used) if (!claims.has(id)) references.push({ number: ++missingNumber, claimId: id, text: '', source: '', locator: '', status: 'pending', evidenceState: 'invalid', evidence: [], issues: ['引用的事实主张缺失'] });
  const byId = new Map(references.map(reference => [reference.claimId, reference]));
  let cursor = 0;
  const shots = project.shots.map(shot => {
    const startUs = cursor; cursor += shot.durationUs;
    const issues = new Set(shot.claimIds.flatMap(id => byId.get(id)?.issues ?? ['引用的事实主张缺失']));
    if (new Set(shot.claimIds).size !== shot.claimIds.length) issues.add('镜头引用重复');
    return { shotId: shot.id, startUs, endUs: cursor, claimIds: [...shot.claimIds], numbers: [...new Set(shot.claimIds.flatMap(id => byId.get(id)?.number ?? []))], issues: [...issues] };
  });
  const warnings = references.flatMap(reference => [
    ...reference.issues.map(issue => `资料 [${reference.number}]：${issue}。`),
    ...(reference.status === 'pending' ? [`资料 [${reference.number}]：事实主张待核验。`] : reference.status === 'disputed' ? [`资料 [${reference.number}]：事实主张存在争议。`] : []),
  ]);
  for (const shot of shots) if (shot.issues.includes('镜头引用重复')) warnings.push(`镜头「${shot.shotId}」包含重复引用。`);
  return { version: 1, display: project.referenceDisplay ?? 'hidden', references, shots, warnings };
}

function numberLabel(numbers: number[]): string {
  const values = [...numbers].sort((a, b) => a - b), groups: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const first = values[index]; let last = first;
    while (values[index + 1] === last + 1) last = values[++index];
    groups.push(first === last ? `[${first}]` : last === first + 1 ? `[${first}] [${last}]` : `[${first}–${last}]`);
  }
  return groups.join(' ');
}

/** Visual numbering is opt-in; missing evidence never inherits a verified appearance from a legacy status. */
export function citationOverlayForShot(manifest: CitationManifest, shotId: string): CitationOverlay | undefined {
  const shot = manifest.shots.find(value => value.shotId === shotId);
  if (manifest.display !== 'numbers' || !shot?.numbers.length) return undefined;
  const numbers = new Set(shot.numbers), references = manifest.references.filter(value => numbers.has(value.number));
  const notes: string[] = [];
  if (references.some(value => value.status === 'pending')) notes.push('待核验');
  if (references.some(value => value.status === 'disputed')) notes.push('有争议');
  if (references.some(value => value.evidenceState !== 'valid') || shot.issues.length) notes.push('无证据或引用异常');
  const status = notes.includes('无证据或引用异常') ? 'missing' : notes.includes('有争议') ? 'disputed' : notes.includes('待核验') ? 'pending' : 'verified';
  return { numbers: shot.numbers, label: `资料 ${numberLabel(shot.numbers)}${notes.length ? ` · ${notes.join(' · ')}` : ''}`, status, notes };
}

/** Top edge shared with caption placement, including tiny output formats. */
export function citationFooterTop(width: number, height: number): number {
  return height * .985 - Math.max(8, Math.min(width * .017, height * .023, 22)) * 1.55;
}

/** Transparent footer painted identically over Canvas art and real-video export frames. */
export function drawCitationOverlay(canvas: HTMLCanvasElement, citation: CitationOverlay | undefined): void {
  if (!citation) return;
  const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('当前环境无法创建引用画布');
  const width = canvas.width, height = canvas.height;
  const size = Math.max(8, Math.min(width * .017, height * .023, 22)), padding = size * .5, boxHeight = size * 1.55;
  ctx.save(); ctx.font = `500 ${size}px ${SCENE_TEMPLATE_FONT_FAMILY}`;
  let label = citation.label;
  const maximum = width * .93 - padding * 2;
  if (ctx.measureText(label).width > maximum) label = `资料 ${citation.numbers.slice(0, 3).map(value => `[${value}]`).join(' ')}${citation.numbers.length > 3 ? ` 等${citation.numbers.length}项` : ''}${citation.notes.length ? ` · ${citation.notes.join('/')}` : ''}`;
  const measured = Math.min(maximum, ctx.measureText(label).width), x = width * .965 - measured - padding * 2, y = citationFooterTop(width, height);
  ctx.fillStyle = citation.status === 'disputed' ? '#603b35f2' : citation.status === 'pending' || citation.status === 'missing' ? '#5a421ff2' : '#20382ef0';
  ctx.beginPath(); ctx.roundRect(x, y, measured + padding * 2, boxHeight, Math.max(2, size * .3)); ctx.fill();
  ctx.fillStyle = '#fbf4e1'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x + padding, y + boxHeight / 2, measured);
  ctx.restore();
}
