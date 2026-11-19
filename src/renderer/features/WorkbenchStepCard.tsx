import { useId, type ReactNode } from 'react';
import HelpTip from '../components/HelpTip';
import { ProgressIcon } from '../components/StepProgress';

export default function WorkbenchStepCard({ index, label, description, children, actionLabel, current = false, status, onClick }: {
  index: ReactNode; label: string; description?: string; children?: ReactNode;
  actionLabel?: string; current?: boolean; status?: string; onClick: () => void;
}) {
  const statusId = useId();
  return <li className="workbench-guide__card" data-current={current || undefined} data-state={status}>
    <button type="button" className="workbench-guide__step" aria-label={actionLabel} aria-describedby={actionLabel && children != null ? statusId : undefined} aria-current={current ? 'step' : undefined} data-state={status} onClick={onClick}>
      <span className="workbench-guide__index" aria-hidden="true">{status === 'running' ? <ProgressIcon status="running" size={13} /> : index}</span><span className="workbench-guide__step-copy"><strong>{label}</strong>{children != null && <span id={statusId}>{children}</span>}</span>
    </button>
    {description && <HelpTip label={`${label}说明`} description={description} className="workbench-guide__help" />}
  </li>;
}
