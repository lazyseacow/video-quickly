function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Compare JSON content, treating an undefined object property as absent. */
export function sameJsonContent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => sameJsonContent(value, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).filter(key => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter(key => right[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && sameJsonContent(left[key], right[key]));
}
