import { useEffect, useRef, useState } from 'react';

const targets = new Map<Element, (visible: boolean) => void>();
let observer: IntersectionObserver | undefined;

function observe(element: Element, onChange: (visible: boolean) => void) {
  if (!observer) {
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        // Tiny clipped timeline slivers do not contain a useful picture.
        targets.get(entry.target)?.(entry.isIntersecting && entry.intersectionRatio >= .25 && entry.intersectionRect.width >= 16 && entry.intersectionRect.height >= 16);
      }
    }, { threshold: [0, .25, 1] });
  }
  const current = observer;
  targets.set(element, onChange); current.observe(element);
  return () => {
    current.unobserve(element); targets.delete(element);
    if (!targets.size) { current.disconnect(); observer = undefined; }
  };
}

export function useThumbnailVisibility(thumbnail: boolean) {
  const container = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = container.current; if (!thumbnail || !element) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    return observe(element, setVisible);
  }, [thumbnail]);
  return { container, visible: !thumbnail || visible };
}
