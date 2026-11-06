import type { GenerationShotProgress, RunStepProgress, RunStepSummary } from '@video-quickly/contracts';

export const generationShotLabels: Record<GenerationShotProgress['status'], string> = {
  pending: '待生成', queued: '排队中', preparing: '准备生成', submitting: '等待模型返回', waiting: '等待生成结果', generating: '生成中',
  downloading: '正在下载', validating: '正在校验', completed: '已完成', interrupted: '未完成', canceled: '已停止',
};
export const runningStep = (status: string) => ['running', 'queued', 'waiting_external', 'retry_scheduled'].includes(status);
export function progressPhaseLabel(progress: RunStepProgress | undefined, kind: RunStepSummary['kind']): string {
  if (!progress) return '正在执行';
  const labels: Record<RunStepProgress['phase'], string> = {
    preparing: '正在准备', requesting: '等待模型返回', receiving: '正在接收结果',
    validating: kind === 'script' ? '正在校验分镜' : '正在校验结果', saving: '正在保存结果',
    generating: '正在生成', rendering: '正在合成成片', completed: '正在保存结果',
  };
  return labels[progress.phase];
}
export function stepProgressText(step: RunStepSummary): string {
  if (step.status === 'pending') return '等待执行';
  if (step.status === 'retry_scheduled') return '等待恢复';
  const text = progressPhaseLabel(step.progress, step.kind), progress = step.progress;
  if (progress?.total) return `${text} · ${progress.completed ?? 0}/${progress.total}`;
  if (progress?.phase === 'rendering' && progress.fraction !== undefined) return `${text} · ${Math.floor(progress.fraction * 100)}%`;
  return text;
}
