import { captionTrackSchema, runSummarySchema, type CaptionTrack } from '@video-quickly/contracts';
import { rpc } from './client';

function waitForResult(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException('已停止字幕识别。', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 400);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function transcribeCaptions(input: { projectId: string; shotId: string; modelId: string; revision: number }, signal: AbortSignal): Promise<CaptionTrack> {
  signal.throwIfAborted();
  const started = await rpc<{ id: string }>('caption.transcribe', input);
  try {
    for (;;) {
      signal.throwIfAborted();
      const run = runSummarySchema.parse(await rpc('run.get', { runId: started.id }));
      if (run.status === 'succeeded') {
        const result = await rpc<unknown>('node.result', { runId: run.id, nodeId: 'caption' });
        if (!result || typeof result !== 'object' || !('captionTrack' in result) || !('shotId' in result) || result.shotId !== input.shotId) throw new Error('识别产物与当前镜头不匹配。');
        return captionTrackSchema.parse(result.captionTrack);
      }
      if (['failed', 'canceled', 'needs_attention', 'waiting_review'].includes(run.status)) throw new Error(run.error ?? '字幕识别未完成，请在制作记录中核对。');
      await waitForResult(signal);
    }
  } finally {
    if (signal.aborted) {
      try { await rpc('run.cancel', { runId: started.id }); }
      catch (error) { throw new Error('已停止等待字幕识别，取消请求未确认，请在制作记录中核对任务。', { cause: error }); }
    }
  }
}
