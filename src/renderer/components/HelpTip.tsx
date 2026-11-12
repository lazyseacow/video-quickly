import { useCallback, useState } from 'react';
import { autoUpdate, flip, FloatingPortal, hide, offset, safePolygon, shift, size, useClick, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole } from '@floating-ui/react';
import { Info } from 'lucide-react';
import { IconButton } from './Primitives';
import './help-tip.css';

export default function HelpTip({ label, description, className = '', preview = false }: { label: string; description: string; className?: string; preview?: boolean }) {
  const [open, setOpen] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const { refs, floatingStyles, context, middlewareData } = useFloating({
    open, onOpenChange: setOpen, placement: preview ? 'bottom-start' : 'bottom-end', strategy: 'fixed',
    middleware: [offset(6), flip(), shift({ padding: 8 }), preview && size({ padding: 8, apply({ availableHeight, elements }) {
      elements.floating.style.maxHeight = `${Math.max(0, Math.min(360, availableHeight))}px`;
    } }), preview && hide()], whileElementsMounted: autoUpdate,
  });
  const reference = useCallback((element: HTMLElement | null) => {
    refs.setReference(element);
    setPortalRoot(element?.closest('dialog') ?? null);
  }, [refs.setReference]);
  const hover = useHover(context, { move: false, delay: { open: 150, close: 100 }, handleClose: safePolygon() });
  const focus = useFocus(context, { visibleOnly: preview });
  const click = useClick(context, { enabled: !preview, toggle: false });
  const dismiss = useDismiss(context, { escapeKey: !preview });
  const role = useRole(context, { role: 'tooltip' });
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, click, dismiss, role]);
  return <>
    {preview ? <small ref={reference} className={className} tabIndex={0} {...getReferenceProps()} onKeyDown={event => {
      if (event.key !== 'Escape' || !open || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }}>{description}</small> : <IconButton ref={reference} label={label} title="" className={className} {...getReferenceProps()}><Info size={16} aria-hidden="true" /></IconButton>}
    {open && <FloatingPortal root={portalRoot ?? undefined}><div ref={refs.setFloating} style={{ ...floatingStyles, visibility: middlewareData.hide?.referenceHidden ? 'hidden' : undefined }} className={`help-tip${preview ? ' help-tip--preview' : ''}`} data-help-tooltip {...getFloatingProps()}>{description}</div></FloatingPortal>}
  </>;
}
