import type { Anchor, TextPositionSelector, TextQuoteSelector } from "@sharehtml/shared";

const CONTEXT_CHARS = 32;

export interface TextRangeMatch {
  start: number;
  end: number;
}

export function getTextQuoteSelector(anchor: Anchor | null | undefined): TextQuoteSelector | null {
  if (!anchor) return null;
  const selector = anchor.selectors.find((item): item is TextQuoteSelector => {
    return item.type === "TextQuoteSelector";
  });
  return selector ?? null;
}

export function getTextPositionSelector(
  anchor: Anchor | null | undefined,
): TextPositionSelector | null {
  if (!anchor) return null;
  const selector = anchor.selectors.find((item): item is TextPositionSelector => {
    return item.type === "TextPositionSelector";
  });
  return selector ?? null;
}

export function buildTextQuoteSelector(
  text: string,
  start: number,
  end: number,
): TextQuoteSelector {
  return {
    type: "TextQuoteSelector",
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - CONTEXT_CHARS), start),
    suffix: text.slice(end, end + CONTEXT_CHARS),
  };
}

export function buildTextPositionSelector(start: number, end: number): TextPositionSelector {
  return {
    type: "TextPositionSelector",
    start,
    end,
  };
}

export function rebuildAnchor(anchor: Anchor, text: string, start: number, end: number): Anchor {
  const preservedSelectors = anchor.selectors.filter((selector) => {
    return selector.type !== "TextQuoteSelector" && selector.type !== "TextPositionSelector";
  });

  return {
    selectors: [
      buildTextPositionSelector(start, end),
      buildTextQuoteSelector(text, start, end),
      ...preservedSelectors,
    ],
  };
}

export function findAnchorRangeInText(
  text: string,
  anchor: Anchor | null | undefined,
): TextRangeMatch | null {
  const quote = getTextQuoteSelector(anchor);
  if (!quote) return null;

  const position = getTextPositionSelector(anchor);
  if (position && isValidPositionMatch(text, position, quote)) {
    return { start: position.start, end: position.end };
  }

  return findStrictQuoteMatch(text, quote);
}

export function findStrictQuoteMatch(
  text: string,
  quote: TextQuoteSelector,
): TextRangeMatch | null {
  const perfectMatches: TextRangeMatch[] = [];
  const oneSidedMatches: TextRangeMatch[] = [];
  const allMatches: TextRangeMatch[] = [];
  let searchFrom = 0;

  while (true) {
    const index = text.indexOf(quote.exact, searchFrom);
    if (index === -1) break;

    const candidate = { start: index, end: index + quote.exact.length };
    const prefixMatched = Boolean(quote.prefix) &&
      text.slice(Math.max(0, index - quote.prefix.length), index) === quote.prefix;
    const suffixMatched = Boolean(quote.suffix) &&
      text.slice(index + quote.exact.length, index + quote.exact.length + quote.suffix.length) ===
        quote.suffix;

    allMatches.push(candidate);
    if (prefixMatched && suffixMatched) {
      perfectMatches.push(candidate);
    } else if (prefixMatched || suffixMatched) {
      oneSidedMatches.push(candidate);
    }

    searchFrom = index + 1;
  }

  if (perfectMatches.length === 1) {
    return perfectMatches[0];
  }

  if (perfectMatches.length > 1) {
    return null;
  }

  if (oneSidedMatches.length === 1) {
    return oneSidedMatches[0];
  }

  if (oneSidedMatches.length > 1) {
    return null;
  }

  if (allMatches.length === 1 && quote.exact.length >= 24) {
    return allMatches[0];
  }

  return null;
}

function isValidPositionMatch(
  text: string,
  position: TextPositionSelector,
  quote: TextQuoteSelector,
): boolean {
  if (position.start < 0 || position.end < position.start) {
    return false;
  }

  return text.slice(position.start, position.end) === quote.exact;
}
