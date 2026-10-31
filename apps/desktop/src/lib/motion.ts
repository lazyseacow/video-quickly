import { useRef, type RefObject } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);
export { gsap, useGSAP };
// CSS owns the timing scale; GSAP reads it when an interaction starts so theme
// overrides and browser transitions retain the same timing contract.
function duration(name: string) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = /^(\d*\.?\d+)(ms|s)$/.exec(value);
  return parsed ? Number(parsed[1]) / (parsed[2] === 'ms' ? 1000 : 1) : 0;
}
export const motion = {
  get enter() { return duration('--motion-enter'); },
  get exit() { return duration('--motion-exit'); },
  get switch() { return duration('--motion-switch'); },
  get ease() { return getComputedStyle(document.documentElement).getPropertyValue('--motion-ease-gsap').trim() || 'none'; },
} as const;

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
