export interface TextDiffOp {
  type: "equal" | "insert" | "delete";
  text: string;
}

export interface TextRange {
  start: number;
  end: number;
}

export function diffText(oldText: string, newText: string): TextDiffOp[] {
  if (oldText === newText) {
    return oldText ? [{ type: "equal", text: oldText }] : [];
  }

  const prefixLength = getCommonPrefixLength(oldText, newText);
  const oldRemainder = oldText.slice(prefixLength);
  const newRemainder = newText.slice(prefixLength);
  const suffixLength = getCommonSuffixLength(oldRemainder, newRemainder);

  const prefix = oldText.slice(0, prefixLength);
  const suffix = suffixLength > 0 ? oldText.slice(oldText.length - suffixLength) : "";
  const oldMiddle = oldText.slice(prefixLength, oldText.length - suffixLength);
  const newMiddle = newText.slice(prefixLength, newText.length - suffixLength);

  const operations: TextDiffOp[] = [];
  if (prefix) {
    operations.push({ type: "equal", text: prefix });
  }

  if (oldMiddle || newMiddle) {
    operations.push(...diffMiddle(oldMiddle, newMiddle));
  }

  if (suffix) {
    operations.push({ type: "equal", text: suffix });
  }

  return mergeDiffOps(operations);
}

export function mapRangeThroughDiff(
  range: TextRange,
  operations: TextDiffOp[],
): TextRange | null {
  let oldOffset = 0;

  for (const operation of operations) {
    const length = operation.text.length;

    if (operation.type === "equal") {
      oldOffset += length;
      continue;
    }

    if (operation.type === "delete") {
      if (rangesOverlap(range.start, range.end, oldOffset, oldOffset + length)) {
        return null;
      }
      oldOffset += length;
      continue;
    }

    if (operation.type === "insert" && oldOffset > range.start && oldOffset < range.end) {
      return null;
    }
  }

  const mappedStart = mapPositionThroughDiff(range.start, operations, "start");
  const mappedEnd = mapPositionThroughDiff(range.end, operations, "end");
  if (mappedStart === null || mappedEnd === null || mappedEnd < mappedStart) {
    return null;
  }

  return { start: mappedStart, end: mappedEnd };
}

function mapPositionThroughDiff(
  position: number,
  operations: TextDiffOp[],
  bias: "start" | "end",
): number | null {
  let oldOffset = 0;
  let newOffset = 0;

  for (const operation of operations) {
    const length = operation.text.length;

    if (operation.type === "insert") {
      if (oldOffset < position || (oldOffset === position && bias === "start")) {
        newOffset += length;
      }
      continue;
    }

    if (operation.type === "delete") {
      if (position > oldOffset && position < oldOffset + length) {
        return null;
      }
      oldOffset += length;
      continue;
    }

    if (position < oldOffset + length) {
      return newOffset + (position - oldOffset);
    }

    oldOffset += length;
    newOffset += length;
  }

  if (position === oldOffset) {
    return newOffset;
  }

  return null;
}

function diffMiddle(oldText: string, newText: string): TextDiffOp[] {
  if (!oldText) {
    return newText ? [{ type: "insert", text: newText }] : [];
  }

  if (!newText) {
    return oldText ? [{ type: "delete", text: oldText }] : [];
  }

  return buildMyersDiff(oldText, newText);
}

function buildMyersDiff(oldText: string, newText: string): TextDiffOp[] {
  const oldLength = oldText.length;
  const newLength = newText.length;
  const max = oldLength + newLength;
  const trace: Array<Map<number, number>> = [];
  let frontier = new Map<number, number>();
  frontier.set(1, 0);

  for (let distance = 0; distance <= max; distance++) {
    trace.push(new Map(frontier));

    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const moveDown = diagonal === -distance ||
        (
          diagonal !== distance &&
          (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY) <
            (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY)
        );

      let oldIndex = moveDown
        ? (frontier.get(diagonal + 1) ?? 0)
        : (frontier.get(diagonal - 1) ?? 0) + 1;
      let newIndex = oldIndex - diagonal;

      while (
        oldIndex < oldLength &&
        newIndex < newLength &&
        oldText.charCodeAt(oldIndex) === newText.charCodeAt(newIndex)
      ) {
        oldIndex++;
        newIndex++;
      }

      frontier.set(diagonal, oldIndex);

      if (oldIndex >= oldLength && newIndex >= newLength) {
        return backtrackMyers(trace, oldText, newText);
      }
    }
  }

  return [
    { type: "delete", text: oldText },
    { type: "insert", text: newText },
  ];
}

function backtrackMyers(
  trace: Array<Map<number, number>>,
  oldText: string,
  newText: string,
): TextDiffOp[] {
  let oldIndex = oldText.length;
  let newIndex = newText.length;
  const operations: TextDiffOp[] = [];

  for (let distance = trace.length - 1; distance >= 0; distance--) {
    const frontier = trace[distance];
    const diagonal = oldIndex - newIndex;

    const moveDown = diagonal === -distance ||
      (
        diagonal !== distance &&
        (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY) <
          (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY)
      );
    const previousDiagonal = moveDown ? diagonal + 1 : diagonal - 1;
    const previousOldIndex = frontier.get(previousDiagonal) ?? 0;
    const previousNewIndex = previousOldIndex - previousDiagonal;

    while (oldIndex > previousOldIndex && newIndex > previousNewIndex) {
      operations.push({ type: "equal", text: oldText.charAt(oldIndex - 1) });
      oldIndex--;
      newIndex--;
    }

    if (distance === 0) {
      break;
    }

    if (oldIndex === previousOldIndex) {
      operations.push({ type: "insert", text: newText.charAt(newIndex - 1) });
      newIndex--;
    } else {
      operations.push({ type: "delete", text: oldText.charAt(oldIndex - 1) });
      oldIndex--;
    }
  }

  return mergeDiffOps(operations.reverse());
}

function mergeDiffOps(operations: TextDiffOp[]): TextDiffOp[] {
  const merged: TextDiffOp[] = [];
  for (const operation of operations) {
    if (!operation.text) continue;
    const last = merged[merged.length - 1];
    if (last && last.type === operation.type) {
      last.text += operation.text;
      continue;
    }
    merged.push({ ...operation });
  }
  return merged;
}

function getCommonPrefixLength(oldText: string, newText: string): number {
  const limit = Math.min(oldText.length, newText.length);
  let index = 0;
  while (index < limit && oldText.charCodeAt(index) === newText.charCodeAt(index)) {
    index++;
  }
  return index;
}

function getCommonSuffixLength(oldText: string, newText: string): number {
  const limit = Math.min(oldText.length, newText.length);
  let index = 0;
  while (
    index < limit &&
    oldText.charCodeAt(oldText.length - index - 1) === newText.charCodeAt(newText.length - index - 1)
  ) {
    index++;
  }
  return index;
}

function rangesOverlap(
  firstStart: number,
  firstEnd: number,
  secondStart: number,
  secondEnd: number,
): boolean {
  return firstStart < secondEnd && secondStart < firstEnd;
}
