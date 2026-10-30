import { useLayoutEffect, useRef, useState } from 'react';
import { Check, CircleAlert, X } from 'lucide-react';
import { gsap, motion, useGSAP } from '../lib/motion';
import { IconButton } from './Primitives';

export interface ToastMessage { id: number; text: string; error?: boolean }
interface ToastFrame { y: number; opacity: number; entryY: number; entryOpacity: number }

export default function ToastNotice({ toast, onDismiss }: { toast?: ToastMessage; onDismiss: () => void }) {
  const [state, setState] = useState(() => ({ entries: toast ? [toast] : [], visible: Boolean(toast) }));
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<ToastFrame | undefined>(undefined);
  const latest = useRef(toast); latest.current = toast;
  const current = state.entries.at(-1);

  // Capture the visible frame before changing the rows, including interrupted transitions.
  useLayoutEffect(() => {
    const element = root.current;
    const entry = element?.querySelector<HTMLElement>('.toast__entry:not(.toast__entry--leaving)');
    if (element && entry) {
      frame.current = { y: Number(gsap.getProperty(element, 'y')), opacity: Number(gsap.getProperty(element, 'opacity')), entryY: Number(gsap.getProperty(entry, 'yPercent')), entryOpacity: Number(gsap.getProperty(entry, 'opacity')) };
    } else frame.current = undefined;
    setState(previous => {
      if (!toast) return previous.visible ? { ...previous, visible: false } : previous;
      if (previous.entries.at(-1)?.id === toast.id && previous.visible) return previous;
      return { entries: [...previous.entries.slice(-1), toast], visible: true };
    });
  }, [toast]);

  useGSAP(() => {
    const element = root.current;
    if (!element || !current) return;
    const media = gsap.matchMedia();
    media.add({ reduced: '(prefers-reduced-motion: reduce)', animated: '(prefers-reduced-motion: no-preference)' }, context => {
      const reduced = context.conditions?.reduced;
      const before = frame.current;
      const active = element.querySelector<HTMLElement>('.toast__entry:not(.toast__entry--leaving)');
      const leaving = element.querySelector<HTMLElement>('.toast__entry--leaving');
      if (!active) return;
      if (!state.visible) {
        gsap.fromTo(element, { autoAlpha: before?.opacity ?? 1, y: before?.y ?? 0 }, { autoAlpha: 0, y: -6, duration: reduced ? 0 : motion.exit, ease: motion.ease, onComplete: () => { if (!latest.current) setState({ entries: [], visible: false }); } });
        return;
      }
      if (!leaving) {
        gsap.fromTo(element, { autoAlpha: 0, y: -8 }, { autoAlpha: 1, y: 0, duration: reduced ? 0 : motion.enter, ease: motion.ease });
        return;
      }
      gsap.timeline({ defaults: { duration: reduced ? 0 : motion.switch, ease: motion.ease }, onComplete: () => {
        if (latest.current?.id === current.id) setState(previous => previous.entries.at(-1)?.id === current.id ? { ...previous, entries: [current] } : previous);
      } })
        .fromTo(element, { autoAlpha: before?.opacity ?? 1, y: before?.y ?? 0 }, { autoAlpha: 1, y: 0 }, 0)
        .fromTo(leaving, { yPercent: before?.entryY ?? 0, autoAlpha: before?.entryOpacity ?? 1 }, { yPercent: -100, autoAlpha: 0 }, 0)
        .fromTo(active, { yPercent: 100, autoAlpha: 0 }, { yPercent: 0, autoAlpha: 1 }, 0);
    }, element);
    return () => media.revert();
  }, { scope: root, dependencies: [current?.id, state.visible], revertOnUpdate: true });

  if (!current) return null;
  return <div className="toast-anchor"><div ref={root} className={`toast ${current.error ? 'toast--error' : ''}`} role={current.error ? 'alert' : 'status'} inert={!toast || undefined}>
    <div className="toast__viewport">{state.entries.map(message => {
      const leaving = message.id !== current.id;
      return <div key={message.id} data-toast-id={message.id} className={`toast__entry ${leaving ? 'toast__entry--leaving' : ''} ${message.error ? 'toast__entry--error' : ''}`} aria-hidden={leaving || undefined} inert={leaving || undefined}><span className="toast__icon" aria-hidden="true">{message.error ? <CircleAlert size={16} /> : <Check size={16} />}</span><span className="toast__message">{message.text}</span></div>;
    })}</div>
    <IconButton label="关闭提示" onClick={onDismiss}><X size={16} /></IconButton>
  </div></div>;
}
