import { useId, useRef } from 'react';
import { Ellipsis, ShieldCheck } from 'lucide-react';
import { Button } from './Primitives';

export default function ProjectMoreActions({ disabled, onCheck }: { disabled: boolean; onCheck: () => void }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  function checkReadiness() {
    panel.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
    onCheck();
  }
  return <div className="project-more" data-guide="check" onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && panel.current?.matches(':popover-open')) panel.current.hidePopover();
  }}>
    <Button ref={trigger} static variant="ghost" disabled={disabled} popoverTarget={id} aria-controls={id}><Ellipsis size={16} aria-hidden="true" />更多</Button>
    <div ref={panel} id={id} popover="auto" tabIndex={-1} role="group" aria-label="更多操作" className="project-more__panel">
      <Button static variant="ghost" onClick={checkReadiness}><ShieldCheck size={16} aria-hidden="true" />制作前检查</Button>
    </div>
  </div>;
}
