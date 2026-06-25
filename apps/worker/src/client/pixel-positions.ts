// Pixel offsets (top, in document space) of each comment highlight, keyed by
// annotation id. The injected document runtime re-measures these on every DOM
// mutation, so the shell sees a fresh report for unrelated changes (e.g. an
// animated clock in the document). Comparing reports lets the shell skip a
// repaint when no anchor actually moved.
export function pixelPositionsEqual(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
