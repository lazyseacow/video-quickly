import { z } from 'zod';
import { projectDetailSchema, runSummarySchema, shotCandidateSchema, type RunSummary, type ShotCandidateKind } from '@video-quickly/contracts';
import { rpc } from './client';

export const candidateKindLabels: Record<ShotCandidateKind, string> = { script: '文案与分镜', image: '画面图片', audio: '旁白音频', video: '镜头视频' };
export const candidatePageSchema = z.object({ items: z.array(shotCandidateSchema), total: z.number().int().nonnegative(), activeRun: runSummarySchema.nullish() });
export const candidateRunActive = (run: Pick<RunSummary, 'status'> | undefined) => !!run && ['queued', 'running', 'waiting_external', 'retry_scheduled'].includes(run.status);

export async function readShotCandidates(projectId: string, shotId: string, offset = 0) {
  return candidatePageSchema.parse(await rpc('shot.candidates', { projectId, shotId, offset, limit: 8 }));
}
export async function readShotCandidate(projectId: string, shotId: string, candidateId: string) {
  const candidate = shotCandidateSchema.parse(await rpc('shot.candidate.get', { projectId, candidateId }));
  if (candidate.projectId !== projectId || candidate.shotId !== shotId) throw new Error('候选与当前镜头不匹配。');
  return candidate;
}
export async function readCandidateAssets(projectId: string) {
  return projectDetailSchema.parse(await rpc('project.get', { projectId })).assets ?? [];
}
function delay(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('已停止读取生成进度。', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 600);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Stopping this observer never cancels the persisted generation task. */
export async function watchCandidateRun(runId: string, onUpdate: (run: RunSummary) => void, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted();
    const run = runSummarySchema.parse(await rpc('run.get', { runId }));
    signal.throwIfAborted();
    onUpdate(run);
    if (!candidateRunActive(run)) return run;
    await delay(signal);
  }
}
