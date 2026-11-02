import { workflowSchema } from '@video-quickly/contracts';

// The shipped pre-upgrade graph, retained only to verify old documents and snapshots.
export function legacyHistoryWorkflow() {
  const kinds = ['brief', 'research', 'style', 'script', 'assets', 'voice', 'animation', 'review', 'export'];
  return workflowSchema.parse({ id: 'history-handdrawn', version: 4, name: '历史手绘科普',
    nodes: kinds.map((kind, index) => ({ id: kind, kind, label: kind, prompt: `${kind}原有提示词`, modelId: kind === 'style' ? 'saved-style-model' : undefined, config: { retained: kind }, position: { x: index * 270, y: 100 }, requiresReview: ['style', 'script', 'review'].includes(kind) })),
    edges: kinds.slice(1).map((kind, index) => ({ id: `${kinds[index]}-${kind}`, source: kinds[index], target: kind })),
  });
}
