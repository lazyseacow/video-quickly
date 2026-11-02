import { useState } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole } from '@floating-ui/react';
import type { LucideIcon } from 'lucide-react';

export default function SidebarNavigationButton({ label, icon: Icon, guide, current, onClick }: {
  label: string; icon: LucideIcon; guide: string; current: boolean; onClick: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({ open, onOpenChange: setOpen, placement: 'right', strategy: 'fixed', middleware: [offset(8), flip(), shift({ padding: 8 })], whileElementsMounted: autoUpdate });
  const hover = useHover(context, { delay: { open: 150, close: 100 } });
  const focus = useFocus(context, { visibleOnly: false });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role]);
  return <>
    <button ref={refs.setReference} type="button" data-guide={guide} className={`nav-item ${current ? 'active' : ''}`} aria-label={label} aria-current={current ? 'page' : undefined} {...getReferenceProps({ onClick: () => { setOpen(false); onClick(); } })}><Icon size={18} aria-hidden="true" /></button>
    {open && <FloatingPortal><div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps({ className: 'sidebar-tooltip' })}>{label}</div></FloatingPortal>}
  </>;
}
