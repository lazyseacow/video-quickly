import { useEffect, useState } from 'react';

/** Brief frame waits stay silent; a visible indication remains readable instead of flashing. */
export function useBufferingIndicator(waiting: boolean, identity: string) {
  const [shown, setShown] = useState<{ identity: string; since: number }>();
  useEffect(() => {
    if (shown && shown.identity !== identity) { setShown(undefined); return; }
    const visible = shown;
    if (waiting && visible || !waiting && !visible) return;
    const delay = waiting ? 150 : Math.max(0, 200 - (performance.now() - visible!.since));
    const timer = setTimeout(() => setShown(waiting ? { identity, since: performance.now() } : undefined), delay);
    return () => clearTimeout(timer);
  }, [waiting, identity, shown]);
  return shown?.identity === identity;
}
