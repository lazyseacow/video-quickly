import { useState } from 'react';
import { autoUpdate, flip, FloatingPortal, offset, safePolygon, shift, useClick, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole } from '@floating-ui/react';
import { Info } from 'lucide-react';
import { IconButton } from './Primitives';
import './help-tip.css';

export default function HelpTip({ label, description, className = '' }: { label: string; description: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open, onOpenChange: setOpen, placement: 'bottom-end', strategy: 'fixed',
    middleware: [offset(6), flip(), shift({ padding: 8 })], whileElementsMounted: autoUpdate,
  });
  const hover = useHover(context, { move: false, delay: { open: 150, close: 100 }, handleClose: safePolygon() });
  const focus = useFocus(context, { visibleOnly: false });
  const click = useClick(context, { toggle: false });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, click, dismiss, role]);
  return <>
    <IconButton ref={refs.setReference} label={label} title="" className={className} {...getReferenceProps()}><Info size={16} aria-hidden="true" /></IconButton>
    {open && <FloatingPortal><div ref={refs.setFloating} style={floatingStyles} className="help-tip" data-help-tooltip {...getFloatingProps()}>{description}</div></FloatingPortal>}
  </>;
}
