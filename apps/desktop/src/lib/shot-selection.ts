export interface ShotSelection { ids: string[]; primary?: string; anchor?: string }
export interface SelectionModifiers { toggle?: boolean; range?: boolean; keepGroup?: boolean }

/** Selection is local UI state, canonically ordered by the current shot list. */
export function normalizeSelection(selection: ShotSelection, orderedIds: readonly string[], fallback?: string): ShotSelection {
  const order = [...new Set(orderedIds)], selected = new Set(selection.ids);
  const ids = order.filter(id => selected.has(id));
  if (!ids.length && selection.ids.length && fallback !== undefined && order.includes(fallback)) ids.push(fallback);
  const primary = selection.primary !== undefined && ids.includes(selection.primary) ? selection.primary : fallback !== undefined && ids.includes(fallback) ? fallback : ids[0];
  const anchor = selection.anchor !== undefined && order.includes(selection.anchor) ? selection.anchor : primary;
  return { ids, ...(primary === undefined ? {} : { primary }), ...(anchor === undefined ? {} : { anchor }) };
}

export function selectShot(selection: ShotSelection, orderedIds: readonly string[], id: string, modifiers: SelectionModifiers = {}): ShotSelection {
  const order = [...new Set(orderedIds)], current = normalizeSelection(selection, order);
  if (!order.includes(id)) return current;
  if (modifiers.range) {
    const anchor = current.anchor ?? current.primary ?? id, start = order.indexOf(anchor), end = order.indexOf(id);
    const range = order.slice(Math.min(start, end), Math.max(start, end) + 1);
    return normalizeSelection({ ids: modifiers.toggle ? [...current.ids, ...range] : range, primary: id, anchor }, order);
  }
  if (modifiers.toggle) {
    if (!current.ids.includes(id)) return normalizeSelection({ ids: [...current.ids, id], primary: id, anchor: id }, order);
    const ids = current.ids.filter(value => value !== id), index = order.indexOf(id);
    const nearest = ids.reduce<string | undefined>((best, value) => best === undefined || Math.abs(order.indexOf(value) - index) < Math.abs(order.indexOf(best) - index) ? value : best, undefined);
    return normalizeSelection({ ids, primary: current.primary === id ? nearest : current.primary, anchor: id }, order);
  }
  if (modifiers.keepGroup && current.ids.includes(id)) return { ...current, primary: id };
  return { ids: [id], primary: id, anchor: id };
}

export function selectAllShots(selection: ShotSelection, orderedIds: readonly string[]): ShotSelection {
  const order = [...new Set(orderedIds)], current = normalizeSelection(selection, order);
  return normalizeSelection({ ids: order, primary: current.primary ?? order[0], anchor: current.anchor ?? current.primary ?? order[0] }, order);
}
