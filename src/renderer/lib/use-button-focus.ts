import { useEffect } from 'react';

const focusKeys = new Set(['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

export function useButtonFocus() {
  useEffect(() => {
    let origin: 'pointer' | 'keyboard' | undefined;
    function update(target: EventTarget | null) {
      const button = target instanceof Element ? target.closest('button') : null;
      if (button && origin) button.toggleAttribute('data-pointer-focus', origin === 'pointer');
    }
    function pointerDown(event: PointerEvent) { origin = 'pointer'; update(event.target); }
    function keyDown(event: KeyboardEvent) {
      // Preserve each opener's focus origin while a dialog or popover is dismissed.
      origin = focusKeys.has(event.key) ? 'keyboard' : undefined;
      update(event.target);
    }
    function click(event: MouseEvent) {
      if (!(event.target instanceof Element) || !event.target.closest('button')) return;
      origin = event.detail > 0 ? 'pointer' : 'keyboard';
      update(event.target);
    }
    function focus(event: FocusEvent) { update(event.target); }
    // Capture before React handlers so focus moved by an action keeps its origin.
    // Native listeners also cover portals and the guide's generated controls.
    document.addEventListener('pointerdown', pointerDown, true);
    document.addEventListener('keydown', keyDown, true);
    document.addEventListener('click', click, true);
    document.addEventListener('focusin', focus, true);
    return () => {
      document.removeEventListener('pointerdown', pointerDown, true);
      document.removeEventListener('keydown', keyDown, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('focusin', focus, true);
      document.querySelectorAll('button[data-pointer-focus]').forEach(button => button.removeAttribute('data-pointer-focus'));
    };
  }, []);
}
