import { useId, useRef, useState } from 'react';
import { Captions, ChevronDown, Ellipsis, Music2, SlidersHorizontal, type LucideIcon } from 'lucide-react';
import { Button, IconButton } from './Primitives';

type ProjectAction = {
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  shortcut?: string;
  onSelect: () => void | Promise<void>;
};

export function ProjectActionPopover({ label, groupLabel, iconOnly, disabled, actions, triggerIcon: TriggerIcon = Ellipsis }: {
  label: string;
  groupLabel: string;
  iconOnly?: boolean;
  disabled: boolean;
  actions: readonly ProjectAction[];
  triggerIcon?: LucideIcon;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  function dismiss() {
    panel.current?.hidePopover();
    trigger.current?.focus({ preventScroll: true });
  }
  return <div className="project-more" onBlur={event => {
    if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && panel.current?.matches(':popover-open')) panel.current.hidePopover();
  }} onKeyDown={event => {
    if (event.key !== 'Escape' || !panel.current?.matches(':popover-open')) return;
    event.preventDefault();
    event.stopPropagation();
    dismiss();
  }}>
    {iconOnly
      ? <IconButton ref={trigger} label={label} disabled={disabled} popoverTarget={id} aria-expanded={expanded} aria-controls={id}><TriggerIcon size={16} aria-hidden="true" /></IconButton>
      : <Button ref={trigger} static variant="ghost" disabled={disabled} popoverTarget={id} aria-expanded={expanded} aria-controls={id}>
        <TriggerIcon className="project-more__trigger-icon" size={15} aria-hidden="true" />{label}<ChevronDown size={13} aria-hidden="true" />
      </Button>}
    <div ref={panel} id={id} popover="auto" tabIndex={-1} role="group" aria-label={groupLabel} className="project-more__panel"
      onToggle={event => setExpanded(event.currentTarget.matches(':popover-open'))}>
      {actions.map(({ label: actionLabel, icon: Icon, disabled: actionDisabled, shortcut, onSelect }) =>
        <Button key={actionLabel} static variant="ghost" disabled={actionDisabled} aria-keyshortcuts={shortcut}
          onClick={() => { dismiss(); void onSelect(); }}><Icon size={16} aria-hidden="true" />{actionLabel}</Button>
      )}
    </div>
  </div>;
}

export default function ProjectPostProductionActions({ disabled, onMusic, onCaptions }: {
  disabled: boolean;
  onMusic: () => void;
  onCaptions: () => void;
}) {
  return <ProjectActionPopover label="后期工具" groupLabel="后期工具" triggerIcon={SlidersHorizontal} disabled={disabled} actions={[
    { label: '背景音乐', icon: Music2, onSelect: onMusic },
    { label: '项目字幕样式', icon: Captions, onSelect: onCaptions },
  ]} />;
}
