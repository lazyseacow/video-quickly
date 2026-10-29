import { useRef, type RefObject } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);
export { gsap, useGSAP };
export const motion = { enter: .24, exit: .14, switch: .18, ease: 'power3.out' } as const;

export function useContentMotion(scope: RefObject<HTMLElement | null>, key: string, selector?: string) {
  const previous = useRef<string | undefined>(undefined);
  useGSAP(() => {
    const target = selector ? scope.current?.querySelector<HTMLElement>(selector) : scope.current;
    if (!target) return;
    if (previous.current === key) return;
    const initial = previous.current === undefined;
    previous.current = key;
    if (initial) return;
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(target, { y: 6, autoAlpha: .78 }, { y: 0, autoAlpha: 1, duration: motion.enter, ease: motion.ease, clearProps: 'transform,opacity,visibility' });
    });
    return () => media.revert();
  }, { scope, dependencies: [key], revertOnUpdate: true });
}
