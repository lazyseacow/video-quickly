export type GuideAction =
  | 'project-created' | 'models-opened' | 'model-saved' | 'projects-opened' | 'workbench-opened'
  | 'view-changed' | 'shot-selected' | 'preview-played' | 'timeline-seeked'
  | 'outline-opened' | 'inspector-opened' | 'project-saved' | 'workflow-selected'
  | 'check-completed' | 'production-started' | 'export-completed' | 'help-used';

export interface GuideCompletion { action: GuideAction; sequence: number; }

let sequence = 0;
const listeners = new Set<(completion: GuideCompletion) => void>();

export function guideActionSequence() { return sequence; }

// Capture the attempt before awaiting work so a late response cannot complete
// a step that the user has since skipped or reopened.
export function beginGuideAction(action: GuideAction) {
  const attempt = ++sequence;
  let completed = false;
  return () => {
    if (completed) return;
    completed = true;
    for (const listener of [...listeners]) listener({ action, sequence: attempt });
  };
}

export function subscribeGuideActions(listener: (completion: GuideCompletion) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
