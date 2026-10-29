import { expect, it } from 'vitest';
import { normalizeSelection, selectAllShots, selectShot } from '../apps/desktop/src/lib/shot-selection';

const order = ['A', 'B', 'C', 'D', 'E', 'F'];
it('normalizes duplicates and removed IDs into current order while retaining valid primary and anchor', () => {
  const before = { ids: ['D', 'B', 'D', 'removed'], primary: 'D', anchor: 'A' };
  expect(normalizeSelection(before, order)).toEqual({ ids: ['B', 'D'], primary: 'D', anchor: 'A' }); expect(before.ids).toEqual(['D', 'B', 'D', 'removed']);
  expect(normalizeSelection(before, ['D', 'C', 'B', 'A'])).toEqual({ ids: ['D', 'B'], primary: 'D', anchor: 'A' });
});

it('keeps intentional empty selection empty and uses fallback only when a previously nonempty group disappears', () => {
  expect(normalizeSelection({ ids: [] }, order, 'B')).toEqual({ ids: [] });
  expect(normalizeSelection({ ids: ['removed'], primary: 'removed', anchor: 'removed' }, order, 'B')).toEqual({ ids: ['B'], primary: 'B', anchor: 'B' });
  expect(normalizeSelection({ ids: ['B', 'removed'], primary: 'removed' }, order, 'C')).toEqual({ ids: ['B'], primary: 'B', anchor: 'B' });
  expect(normalizeSelection({ ids: ['removed'] }, order)).toEqual({ ids: [] }); expect(normalizeSelection({ ids: ['B'] }, [])).toEqual({ ids: [] });
});

it('toggles membership and makes a nearby remaining member primary without retaining a removed primary', () => {
  const first = selectShot({ ids: [] }, order, 'B'), added = selectShot(first, order, 'D', { toggle: true });
  expect(added).toEqual({ ids: ['B', 'D'], primary: 'D', anchor: 'D' });
  const removed = selectShot(added, order, 'D', { toggle: true }); expect(removed).toEqual({ ids: ['B'], primary: 'B', anchor: 'D' });
  expect(selectShot(removed, order, 'B', { toggle: true })).toEqual({ ids: [], anchor: 'B' });
  expect(selectShot({ ids: ['A', 'C', 'E'], primary: 'A', anchor: 'C' }, order, 'C', { toggle: true }).primary).toBe('A');
});

it('extends inclusive forward and reverse ranges from the stable anchor in the current order', () => {
  const reverse = selectShot({ ids: ['D'], primary: 'D', anchor: 'D' }, order, 'B', { range: true });
  expect(reverse).toEqual({ ids: ['B', 'C', 'D'], primary: 'B', anchor: 'D' });
  expect(selectShot(reverse, order, 'F', { range: true })).toEqual({ ids: ['D', 'E', 'F'], primary: 'F', anchor: 'D' });
  expect(selectShot({ ids: [] }, order, 'C', { range: true })).toEqual({ ids: ['C'], primary: 'C', anchor: 'C' });
  expect(selectShot({ ids: ['D'], primary: 'D', anchor: 'D' }, ['D', 'B', 'A', 'C'], 'A', { range: true }).ids).toEqual(['D', 'B', 'A']);
});

it('unions toggle-range with the existing group without replacing its original anchor', () => {
  expect(selectShot({ ids: ['A', 'F'], primary: 'F', anchor: 'B' }, order, 'D', { toggle: true, range: true })).toEqual({ ids: ['A', 'B', 'C', 'D', 'F'], primary: 'D', anchor: 'B' });
});

it('keeps an already-selected group for primary switching and dragging only when requested', () => {
  const before = { ids: ['B', 'D'], primary: 'D', anchor: 'B' };
  expect(selectShot(before, order, 'B', { keepGroup: true })).toEqual({ ids: ['B', 'D'], primary: 'B', anchor: 'B' });
  expect(selectShot(before, order, 'D', { keepGroup: true })).toEqual(before);
  expect(selectShot(before, order, 'B')).toEqual({ ids: ['B'], primary: 'B', anchor: 'B' });
  expect(selectShot(before, order, 'C', { keepGroup: true })).toEqual({ ids: ['C'], primary: 'C', anchor: 'C' });
  expect(selectShot(before, order, 'stale-click')).toEqual(before);
});

it('selects all without losing valid focus and clears focus when the list is empty', () => {
  expect(selectAllShots({ ids: ['D'], primary: 'D', anchor: 'B' }, order)).toEqual({ ids: order, primary: 'D', anchor: 'B' });
  expect(selectAllShots({ ids: [] }, order)).toEqual({ ids: order, primary: 'A', anchor: 'A' });
  expect(selectAllShots({ ids: ['A'], primary: 'A', anchor: 'A' }, [])).toEqual({ ids: [] });
});
