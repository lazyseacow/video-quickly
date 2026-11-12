import { useCallback, useLayoutEffect, useRef } from 'react';

/** Stable event identity, forwarding to the latest committed parent callback. */
export function useCommittedCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; }, [callback]);
  return useCallback((...args: Args) => latest.current(...args), [latest]);
}
