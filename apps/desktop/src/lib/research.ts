import { researchResultSchema, runSummarySchema, type ResearchResult } from '@video-quickly/contracts';
import { rpc } from './client';

function wait(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('已停止等待资料整理。', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 500);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function analyzeResearch(input: { projectId: string; revision: number; modelId: string; sourceIds: string[]; instruction?: string }, signal: AbortSignal): Promise<ResearchResult> {
  signal.throwIfAborted();
  const started = await rpc<{ id: string }>('research.analyze', input);
  try {
    for (;;) {
      signal.throwIfAborted();
      const run = runSummarySchema.parse(await rpc('run.get', { runId: started.id }));
      if (run.status === 'succeeded') {
        const result = researchResultSchema.parse(await rpc('node.result', { runId: started.id, nodeId: 'research' }));
        if (result.projectId !== input.projectId || result.runId !== started.id) throw new Error('资料候选不属于当前项目或运行。');
        return result;
      }
      if (['failed', 'canceled', 'needs_attention', 'waiting_review'].includes(run.status)) throw new Error(run.error ?? '资料整理尚未完成，请在制作记录中核对。');
      await wait(signal);
    }
  } finally {
    if (signal.aborted) {
      try { await rpc('run.cancel', { runId: started.id }); }
      catch (error) { throw new Error('已停止等待资料整理，取消请求尚未确认，请在制作记录中核对。', { cause: error }); }
    }
  }
}
