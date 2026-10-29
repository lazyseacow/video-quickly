import { useLayoutEffect, useRef, type HTMLAttributes } from 'react';
import { gsap, motion, useGSAP } from '../lib/motion';

export default function TabSurface({ value, variant = 'pill', className = '', children, ...props }: HTMLAttributes<HTMLDivElement> & { value: string; variant?: 'pill' | 'underline' }) {
  const root = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const synchronize = useRef<(() => void) | undefined>(undefined);
  useGSAP(() => {
    const element = root.current; const ink = indicator.current;
    if (!element || !ink) return;
    const media = gsap.matchMedia();
    media.add({ reduced: '(prefers-reduced-motion: reduce)', animated: '(prefers-reduced-motion: no-preference)' }, context => {
      const reduced = context.conditions?.reduced;
      gsap.set(ink, { width: 0, opacity: 0, x: 0 });
      const setWidth = gsap.quickSetter(ink, 'width', 'px');
      const setOpacity = gsap.quickSetter(ink, 'opacity');
      const setX = gsap.quickSetter(ink, 'x', 'px');
      const xTo = gsap.quickTo(ink, 'x', { duration: motion.switch, ease: motion.ease });
      let position: number | undefined;
      const align = (animate = true) => {
        const selected = element.querySelector<HTMLButtonElement>('button.active, button[aria-selected="true"]');
        if (!selected || !element.clientWidth) return;
        const parent = element.getBoundingClientRect(); const button = selected.getBoundingClientRect();
        const padding = variant === 'underline' ? 10 : 0;
        const next = button.left - parent.left - element.clientLeft + padding;
        // Resize writes final geometry; movement reuses one tween without accumulating setters.
        setWidth(Math.max(0, button.width - padding * 2)); setOpacity(1);
        if (position === undefined || !animate || reduced) { xTo.tween.pause(); setX(next); }
        else if (Math.abs(next - position) > .5) xTo(next);
        position = next;
      };
      // Delayed callbacks belong to this media context so preference changes clean them up.
      const safeAlign = context.add('align', align);
      const observer = new ResizeObserver(() => safeAlign(false));
      observer.observe(element);
      synchronize.current = () => safeAlign(true);
      safeAlign(false);
      return () => { observer.disconnect(); synchronize.current = undefined; };
    }, element);
    return () => media.revert();
  }, { scope: root, dependencies: [variant], revertOnUpdate: true });
  useLayoutEffect(() => { synchronize.current?.(); }, [value]);
  return <div {...props} ref={root} className={`tabs motion-tabs ${className}`} data-variant={variant}><span ref={indicator} className="motion-tabs__indicator" aria-hidden="true" />{children}</div>;
}
