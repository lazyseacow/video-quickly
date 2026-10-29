import { useLayoutEffect, useRef, useState } from 'react';
import { Check, CircleAlert, X } from 'lucide-react';
import { gsap, motion, useGSAP } from '../lib/motion';
import { IconButton } from './Primitives';

export interface ToastMessage { text: string; error?: boolean }

export default function ToastNotice({ toast, onDismiss }: { toast?: ToastMessage; onDismiss: () => void }) {
  const [rendered, setRendered] = useState(toast);
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(toast); latest.current = toast;
  const visible = useRef(false);
  const animate = useRef<((show: boolean) => void) | undefined>(undefined);
  useGSAP(() => {
    const element = root.current;
    if (!element) return;
    const media = gsap.matchMedia();
    media.add({ reduced: '(prefers-reduced-motion: reduce)', animated: '(prefers-reduced-motion: no-preference)' }, context => {
      let tween: gsap.core.Tween | undefined;
      const update = (show: boolean) => {
        tween?.kill();
        if (show && !visible.current) gsap.set(element, { autoAlpha: 0, y: 10, scale: .98 });
        visible.current = show;
        tween = gsap.to(element, { autoAlpha: show ? 1 : 0, y: show ? 0 : 6, scale: show ? 1 : .99, duration: context.conditions?.reduced ? 0 : show ? motion.enter : motion.exit, ease: motion.ease, overwrite: 'auto', onComplete: () => { if (!latest.current) setRendered(undefined); } });
      };
      const updateSafe = context.add('update', update);
      animate.current = show => updateSafe(show);
      updateSafe(Boolean(latest.current));
      return () => { tween?.kill(); animate.current = undefined; };
    }, element);
    return () => { media.revert(); visible.current = false; };
  }, { scope: root, dependencies: [Boolean(rendered)], revertOnUpdate: true });
  useLayoutEffect(() => {
    if (toast && toast !== rendered) setRendered(toast);
    animate.current?.(Boolean(toast));
  }, [toast, rendered]);
  if (!rendered) return null;
  return <div className="toast-anchor"><div ref={root} className={`toast ${rendered.error ? 'toast--error' : ''}`} role={rendered.error ? 'alert' : 'status'} inert={!toast || undefined}><span className="toast__icon">{rendered.error ? <CircleAlert size={18} /> : <Check size={18} />}</span><span className="toast__message">{rendered.text}</span><IconButton label="关闭提示" onClick={onDismiss}><X size={16} /></IconButton></div></div>;
}
