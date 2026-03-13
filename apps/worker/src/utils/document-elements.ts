import type { Anchor, ElementSelector } from "@sharehtml/shared";
import { getElementSelector } from "./anchors.js";

const IGNORED_CONTENT_REGEX =
  /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

interface ElementFrame {
  selector: string;
  childIndex: number;
}

export interface DocumentAnnotatableElement {
  cssSelector: string;
  tagName: "img" | "canvas";
  ordinal: number;
  src?: string;
  alt?: string;
  width?: number;
  height?: number;
}

export async function collectAnnotatableElementsFromHtml(
  html: string,
): Promise<DocumentAnnotatableElement[]> {
  const elements: DocumentAnnotatableElement[] = [];
  const stack: ElementFrame[] = [{ selector: "body", childIndex: 0 }];
  const ordinals = new Map<"img" | "canvas", number>();
  const sanitizedHtml = html.replace(IGNORED_CONTENT_REGEX, "");

  const collector = {
    element(element: Element): void {
      const parent = stack[stack.length - 1];
      parent.childIndex += 1;

      const tagName = element.tagName.toLowerCase();
      const selector = `${parent.selector} > ${tagName}:nth-child(${parent.childIndex})`;

      if (tagName === "img" || tagName === "canvas") {
        const typedTag = tagName as "img" | "canvas";
        const ordinal = (ordinals.get(typedTag) ?? 0) + 1;
        ordinals.set(typedTag, ordinal);

        elements.push({
          cssSelector: selector,
          tagName: typedTag,
          ordinal,
          src: element.getAttribute("src") ?? undefined,
          alt: element.getAttribute("alt") ?? undefined,
          width: parseNumberAttribute(element.getAttribute("width")),
          height: parseNumberAttribute(element.getAttribute("height")),
        });
      }

      if (VOID_TAGS.has(tagName)) {
        return;
      }

      stack.push({ selector, childIndex: 0 });
      element.onEndTag(() => {
        stack.pop();
      });
    },
  };

  await new HTMLRewriter().on("*", collector).transform(new Response(sanitizedHtml)).text();
  return elements;
}

export function rebuildElementAnchor(anchor: Anchor, element: DocumentAnnotatableElement): Anchor {
  const preservedSelectors = anchor.selectors.filter((selector) => {
    return selector.type !== "ElementSelector";
  });

  return {
    selectors: [
      buildElementSelector(element),
      ...preservedSelectors,
    ],
  };
}

export function remapElementAnchor(
  anchor: Anchor,
  nextElements: DocumentAnnotatableElement[],
): Anchor | "resolve" | null {
  const elementSelector = getElementSelector(anchor);
  if (!elementSelector) return null;

  const directMatch = nextElements.find((candidate) => {
    return candidate.cssSelector === elementSelector.cssSelector &&
      matchesElementSignature(candidate, elementSelector);
  });
  if (directMatch) {
    return rebuildIfChanged(anchor, directMatch);
  }

  const strongMatches = findStrongElementMatches(nextElements, elementSelector);

  if (strongMatches.length === 1) {
    return rebuildIfChanged(anchor, strongMatches[0]);
  }

  return "resolve";
}

function buildElementSelector(element: DocumentAnnotatableElement): ElementSelector {
  return {
    type: "ElementSelector",
    cssSelector: element.cssSelector,
    tagName: element.tagName,
    ordinal: element.ordinal,
    src: element.src,
    alt: element.alt,
    width: element.width,
    height: element.height,
  };
}

function rebuildIfChanged(
  anchor: Anchor,
  element: DocumentAnnotatableElement,
): Anchor | null {
  const rebuiltAnchor = rebuildElementAnchor(anchor, element);
  if (JSON.stringify(rebuiltAnchor) === JSON.stringify(anchor)) {
    return null;
  }
  return rebuiltAnchor;
}

function findStrongElementMatches(
  elements: DocumentAnnotatableElement[],
  selector: ElementSelector,
): DocumentAnnotatableElement[] {
  const signatureMatches = elements.filter((candidate) => {
    return matchesElementSignature(candidate, selector);
  });

  if (signatureMatches.length <= 1) {
    return signatureMatches;
  }

  if (typeof selector.ordinal !== "number") {
    return [];
  }

  return signatureMatches.filter((candidate) => candidate.ordinal === selector.ordinal);
}

function matchesElementSignature(
  candidate: DocumentAnnotatableElement,
  selector: ElementSelector,
): boolean {
  if (candidate.tagName !== selector.tagName) {
    return false;
  }

  if (candidate.tagName === "img") {
    if (selector.src && candidate.src !== selector.src) {
      return false;
    }
    if ((selector.alt ?? "") !== (candidate.alt ?? "")) {
      return false;
    }
    return true;
  }

  if (
    typeof selector.width === "number" &&
    typeof candidate.width === "number" &&
    candidate.width !== selector.width
  ) {
    return false;
  }

  if (
    typeof selector.height === "number" &&
    typeof candidate.height === "number" &&
    candidate.height !== selector.height
  ) {
    return false;
  }

  return true;
}

function parseNumberAttribute(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
