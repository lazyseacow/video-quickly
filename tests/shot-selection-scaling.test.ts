import { expect, it, vi } from 'vitest';
import { selectShot, type ShotSelection } from '../src/renderer/lib/shot-selection';

it.each([
  { order: ['A', 'B', 'C', 'D', 'E'], selected: ['E', 'C', 'A'], removed: 'C', expected: ['A', 'E'], primary: 'A' },
  { order: ['E', 'D', 'C', 'B', 'A'], selected: ['A', 'C', 'E'], removed: 'C', expected: ['E', 'A'], primary: 'E' },
  { order: ['A', 'B', 'C', 'D', 'E'], selected: ['D', 'C', 'A'], removed: 'C', expected: ['A', 'D'], primary: 'D' },
])('chooses the closest remaining primary in canonical order after removing $removed from $order', ({ order, selected, removed, expected, primary }) => {
  const before: ShotSelection = { ids: selected, primary: removed, anchor: 'A' };
  const original = structuredClone(before), originalOrder = [...order];
  expect(selectShot(before, order, removed, { toggle: true })).toEqual({ ids: expected, primary, anchor: removed });
  expect(before).toEqual(original); expect(order).toEqual(originalOrder);
});

it('retains a different primary and canonical selection while moving the anchor to the removed member', () => {
  const before = { ids: ['E', 'C', 'A', 'A', 'stale'], primary: 'E', anchor: 'A' };
  expect(selectShot(before, ['A', 'B', 'C', 'D', 'E'], 'C', { toggle: true })).toEqual({ ids: ['A', 'E'], primary: 'E', anchor: 'C' });
  expect(before.ids).toEqual(['E', 'C', 'A', 'A', 'stale']);
});

it('clears the final selected primary and retains a valid range anchor', () => {
  expect(selectShot({ ids: ['C'], primary: 'C', anchor: 'A' }, ['A', 'B', 'C'], 'C', { toggle: true })).toEqual({ ids: [], anchor: 'C' });
  expect(selectShot({ ids: [] }, [], 'C', { toggle: true })).toEqual({ ids: [] });
});

for (const primaryRemoved of [true, false]) it(`bounds repeated full-array searches when toggling a 5000-shot full selection (primary removed: ${primaryRemoved})`, () => {
  const order = Array.from({ length: 5000 }, (_, index) => `shot-${index}`);
  const removed = order[2500], primary = primaryRemoved ? removed : order[0];
  const before = { ids: order, primary, anchor: order.at(-1) };
  const original = structuredClone(before), originalOrder = [...order];
  // Observe real searches through the original implementation, rather than
  // asserting a machine-dependent time limit. A search per remaining member
  // makes this user action quadratic even when its retained primary is known.
  const searches = vi.spyOn(Array.prototype, 'indexOf');
  let after: ShotSelection, count: number;
  try {
    after = selectShot(before, order, removed, { toggle: true });
    count = searches.mock.calls.length;
  } finally { searches.mockRestore(); }
  expect(after).toEqual({ ids: order.filter(id => id !== removed), primary: primaryRemoved ? order[2499] : primary, anchor: removed });
  expect(before).toEqual(original); expect(order).toEqual(originalOrder);
  expect(count).toBeLessThanOrEqual(4);
});
