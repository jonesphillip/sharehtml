import type { Anchor, ElementSelector, Selector } from "@sharehtml/shared";

(function () {
  const parent = window.parent;
  if (parent === window) return; // Not in iframe

  let parentOrigin: string | null = null;

  function sendToParent(message: Record<string, unknown>) {
    parent.postMessage(message, parentOrigin ?? "*");
  }

  function isTrustedParentMessage(event: MessageEvent): boolean {
    return event.source === parent && event.origin === parentOrigin;
  }

  function isParentInitMessage(event: MessageEvent): boolean {
    return event.source === parent && event.data?.type === "collab:init" &&
      typeof event.origin === "string";
  }

  function findLinkTarget(target: EventTarget | null): HTMLAnchorElement | null {
    if (!(target instanceof Element)) return null;
    const link = target.closest("a[href]");
    return link instanceof HTMLAnchorElement ? link : null;
  }

  // Styles for in-document elements
  const style = document.createElement("style");
  style.textContent = `
    /* Hide iframe scrollbar when sidebar is open — scroll is driven by parent sidebar */
    html.hide-scrollbar { scrollbar-width: none; }
    html.hide-scrollbar::-webkit-scrollbar { display: none; }
    .collab-overlay-root {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      pointer-events: none;
      z-index: 9998;
    }
    .collab-highlight-rect {
      position: absolute;
      background: rgba(255,213,79,0.25);
      transition: background 120ms ease;
      border-radius: 1px;
      pointer-events: auto;
      cursor: pointer;
    }
    .collab-highlight-rect.hovered {
      background: rgba(255,213,79,0.45);
    }
    .collab-highlight-rect.active {
      background: rgba(255,213,79,0.5);
    }
    .collab-selection-rect {
      position: absolute;
      border-radius: 1px;
    }
    .collab-element-target {
      outline: 2px solid rgba(255,213,79,0.55);
      outline-offset: 2px;
      cursor: pointer;
    }
  `;
  document.head.appendChild(style);

  const overlayRoot = document.createElement("div");
  overlayRoot.className = "collab-overlay-root";
  document.body.appendChild(overlayRoot);

  let activeHighlightId: string | null = null;
  let hoveredHighlightId: string | null = null;
  let hoveredAnnotatableElement: Element | null = null;
  let renderedHighlights: HighlightComment[] = [];
  const highlightRects = new Map<string, HTMLElement[]>();
  const highlightPixelOffsets = new Map<string, number>();
  const remoteSelections = new Map<string, HTMLElement[]>();
  type LocalSelector = Selector;
  type LocalAnchor = Anchor;

  interface LocalSelection {
    text: string;
    anchor: LocalAnchor;
    rect: DOMRect;
    pixelY: number;
  }

  interface ViewportRectPayload {
    top: number;
    left: number;
    bottom: number;
    width: number;
    height: number;
  }

  const remoteSelectionState = new Map<
    string,
    {
      color: string;
      anchor: LocalAnchor;
    }
  >();
  let currentSelection: LocalSelection | null = null;

  // Check parent window width — iframe may be narrower due to sidebar
  let parentWidth = window.innerWidth;
  try { parentWidth = window.parent.innerWidth; } catch {}
  const isMobile = parentWidth <= 768;

  // Build selection data from current browser selection
  function processSelection(): typeof currentSelection {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (!text) return null;

    const selectors: LocalSelector[] = [];

    const exactText = getExactTextFromRange(range);
    const exactStart = getTextOffsetForRange(range);
    if (exactStart >= 0) {
      const fullText = collectDocumentTextIndex().text;
      selectors.push({
        type: "TextQuoteSelector",
        exact: exactText,
        prefix: fullText.slice(Math.max(0, exactStart - 32), exactStart),
        suffix: fullText.slice(exactStart + exactText.length, exactStart + exactText.length + 32),
      });
      selectors.push({
        type: "TextPositionSelector",
        start: exactStart,
        end: exactStart + exactText.length,
      });
    }

    const startContainer =
      range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : range.startContainer instanceof Element
        ? range.startContainer
        : null;
    if (startContainer) {
      selectors.push({
        type: "CssSelector",
        value: getCssSelector(startContainer),
      });
    }

    const fragments = Array.from(range.getClientRects()).filter((fragment) =>
      fragment.width > 0 && fragment.height > 0
    );
    const pixelY = fragments.length > 0
      ? Math.min(...fragments.map((fragment) => fragment.top + window.scrollY))
      : range.getBoundingClientRect().top + window.scrollY;

    return {
      text,
      anchor: { selectors },
      rect: range.getBoundingClientRect(),
      pixelY,
    };
  }

  function isAnnotatableElement(element: Element | null): element is HTMLImageElement | HTMLCanvasElement {
    return Boolean(element) &&
      (element instanceof HTMLImageElement || element instanceof HTMLCanvasElement);
  }

  function findAnnotatableElement(target: EventTarget | null): HTMLImageElement | HTMLCanvasElement | null {
    if (!(target instanceof Element)) return null;
    const element = target.closest("img, canvas");
    return isAnnotatableElement(element) ? element : null;
  }

  const hoverMutationTargets = new Set<Element>();
  function setHoveredAnnotatableElement(element: Element | null) {
    if (hoveredAnnotatableElement === element) return;
    if (hoveredAnnotatableElement) {
      hoverMutationTargets.add(hoveredAnnotatableElement);
      hoveredAnnotatableElement.classList.remove("collab-element-target");
    }
    hoveredAnnotatableElement = element;
    if (hoveredAnnotatableElement) {
      hoverMutationTargets.add(hoveredAnnotatableElement);
      hoveredAnnotatableElement.classList.add("collab-element-target");
    }
  }

  function getAnnotatableLabel(element: HTMLImageElement | HTMLCanvasElement): string {
    if (element instanceof HTMLImageElement) {
      const alt = element.getAttribute("alt")?.trim();
      return alt ? `image: ${alt}` : "image";
    }
    return "chart";
  }

  function processElementSelection(
    element: HTMLImageElement | HTMLCanvasElement,
  ): LocalSelection {
    const rect = element.getBoundingClientRect();
    const selectors: LocalSelector[] = [{
      type: "ElementSelector",
      cssSelector: getCssSelector(element),
      tagName: element.tagName.toLowerCase(),
      ordinal: getAnnotatableOrdinal(element),
      src: element instanceof HTMLImageElement ? element.getAttribute("src") ?? undefined : undefined,
      alt: element instanceof HTMLImageElement ? element.getAttribute("alt") ?? undefined : undefined,
      width: getNumericElementDimension(element, "width"),
      height: getNumericElementDimension(element, "height"),
    }];

    return {
      text: getAnnotatableLabel(element),
      anchor: { selectors },
      rect,
      pixelY: rect.top + window.scrollY,
    };
  }

  function serializeViewportRect(rect: DOMRect): ViewportRectPayload {
    return {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }

  function refreshCurrentSelection(): LocalSelection | null {
    const textSelection = processSelection();
    if (textSelection) {
      currentSelection = textSelection;
      return currentSelection;
    }

    if (!currentSelection) return null;

    const element = findElementFromAnchor(currentSelection.anchor);
    if (!element) {
      currentSelection = null;
      return null;
    }

    currentSelection = processElementSelection(element);
    return currentSelection;
  }

  function emitCurrentSelection(type: "selection:made" | "selection:geometry" = "selection:made") {
    const selection = refreshCurrentSelection();
    if (!selection) {
      sendToParent({ type: "selection:clear" });
      return;
    }

    sendToParent({
      type,
      text: selection.text,
      anchor: selection.anchor,
      pixelY: selection.pixelY,
      rect: serializeViewportRect(selection.rect),
    });
  }

  function getAnnotatableOrdinal(element: HTMLImageElement | HTMLCanvasElement): number {
    const elements = Array.from(document.querySelectorAll(element.tagName.toLowerCase()));
    return elements.indexOf(element) + 1;
  }

  function getNumericElementDimension(
    element: HTMLImageElement | HTMLCanvasElement,
    attribute: "width" | "height",
  ): number | undefined {
    const value = element.getAttribute(attribute);
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  // Track text selection (desktop)
  document.addEventListener("mouseup", (e) => {
    if (isMobile) return;

    setTimeout(() => {
      currentSelection = processSelection();
      if (!currentSelection) {
        const annotatableElement = findAnnotatableElement(e.target);
        if (annotatableElement) {
          currentSelection = processElementSelection(annotatableElement);
        }
      }

      if (!currentSelection) {
        setHoveredAnnotatableElement(null);
        sendToParent({ type: "selection:clear" });
      } else {
        emitCurrentSelection("selection:made");
      }
    }, 10);
  });

  document.addEventListener("mousemove", (e) => {
    if (isMobile) return;
    if (window.getSelection()?.toString()) {
      setHoveredAnnotatableElement(null);
      return;
    }
    setHoveredAnnotatableElement(findAnnotatableElement(e.target));
  });

  document.addEventListener("mouseleave", () => {
    setHoveredAnnotatableElement(null);
  });

  if (isMobile) {
    let selectionTimer: ReturnType<typeof setTimeout> | null = null;
    document.addEventListener("selectionchange", () => {
      if (selectionTimer) clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        currentSelection = processSelection();
        if (!currentSelection) {
          const activeElement = document.activeElement;
          if (isAnnotatableElement(activeElement)) {
            currentSelection = processElementSelection(activeElement);
          }
        }
        if (currentSelection) {
          emitCurrentSelection("selection:made");
        } else {
          sendToParent({ type: "selection:clear" });
        }
      }, 200);
    });

    document.addEventListener("click", (event) => {
      const link = findLinkTarget(event.target);
      if (link) {
        event.preventDefault();
        event.stopPropagation();
        sendToParent({ type: "document:open-link", href: link.getAttribute("href") || link.href });
        return;
      }

      const annotatableElement = findAnnotatableElement(event.target);
      if (!annotatableElement) return;

      currentSelection = processElementSelection(annotatableElement);
      emitCurrentSelection("selection:made");
    });
  } else {
    document.addEventListener("click", (event) => {
      const link = findLinkTarget(event.target);
      if (!link) return;
      event.preventDefault();
      event.stopPropagation();
      sendToParent({ type: "document:open-link", href: link.getAttribute("href") || link.href });
    });
  }

  function reportHighlightPositions() {
    const entries: Array<{ id: string; top: number }> = [];
    const pixelPositions: Record<string, number> = {};
    for (const [id, top] of highlightPixelOffsets) {
      pixelPositions[id] = top;
      entries.push({ id, top });
    }

    entries.sort((left, right) => left.top - right.top);
    const positions: Record<string, number> = {};
    entries.forEach((entry, index) => {
      positions[entry.id] = index;
    });

    sendToParent({
      type: "highlights:positions",
      positions,
      pixelPositions,
      animating: hasAnimatingAnchors(),
      scrollHeight: document.documentElement.scrollHeight,
    });
  }

  function syncOverlayRootBounds() {
    overlayRoot.style.height = document.documentElement.scrollHeight + "px";
  }

  function clearHighlightRects() {
    for (const rects of highlightRects.values()) {
      for (const rect of rects) {
        rect.remove();
      }
    }
    highlightRects.clear();
    highlightPixelOffsets.clear();
  }

  function clearRemoteSelectionRects() {
    for (const rects of remoteSelections.values()) {
      for (const rect of rects) {
        rect.remove();
      }
    }
    remoteSelections.clear();
  }

  function isEventWithinHighlight(eventTarget: EventTarget | null, commentId: string): boolean {
    if (!(eventTarget instanceof HTMLElement)) return false;
    return eventTarget.dataset.commentId === commentId;
  }

  function collectTextNodeFragments(range: Range): DOMRect[] {
    const fragments: DOMRect[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (!(current instanceof Text)) continue;
      if (!current.textContent || current.textContent.length === 0) continue;
      if (!range.intersectsNode(current)) continue;

      const startOffset = current === range.startContainer ? range.startOffset : 0;
      const endOffset =
        current === range.endContainer ? range.endOffset : current.textContent.length;

      if (startOffset >= endOffset) continue;

      const fragmentRange = document.createRange();
      fragmentRange.setStart(current, startOffset);
      fragmentRange.setEnd(current, endOffset);

      const nodeFragments = Array.from(fragmentRange.getClientRects()).filter((rect) => {
        return rect.width > 0 && rect.height > 0;
      });
      fragments.push(...nodeFragments);
      fragmentRange.detach();
    }

    return fragments;
  }

  function createOverlayRects(
    fragments: DOMRect[],
    className: string,
    dataIdName: string,
    dataIdValue: string,
    onClick?: () => void,
  ): HTMLElement[] {
    const rects: HTMLElement[] = [];

    for (const fragment of fragments) {
      const rect = document.createElement("div");
      rect.className = className;
      rect.dataset[dataIdName] = dataIdValue;
      rect.style.left = fragment.left + window.scrollX + "px";
      rect.style.top = fragment.top + window.scrollY + "px";
      rect.style.width = fragment.width + "px";
      rect.style.height = fragment.height + "px";
      if (onClick) {
        rect.addEventListener("click", (event) => {
          event.stopPropagation();
          onClick();
        });
      }
      overlayRoot.appendChild(rect);
      rects.push(rect);
    }

    return rects;
  }

  // Sync scroll with parent sidebar
  window.addEventListener("scroll", () => {
    sendToParent({
      type: "iframe:scroll",
      scrollTop: window.scrollY,
      scrollHeight: document.documentElement.scrollHeight,
    });
    if (currentSelection) {
      emitCurrentSelection("selection:geometry");
    }
  }, { passive: true });

  // Receive messages from parent
  window.addEventListener("message", (e) => {
    if (parentOrigin === null) {
      if (!isParentInitMessage(e)) return;
      parentOrigin = e.origin;
      return;
    }

    if (!isTrustedParentMessage(e)) return;
    const msg = e.data;

    switch (msg.type) {
      case "highlights:render":
        renderHighlights(msg.comments);
        break;
      case "highlights:check":
        checkedComments = msg.comments;
        reportHighlightStates(msg.comments);
        break;
      case "highlight:activate":
        activateHighlight(msg.commentId);
        break;
      case "highlight:deactivate":
        deactivateHighlights();
        break;
      case "selection:remote":
        renderRemoteSelection(msg.email, msg.color, msg.anchor);
        break;
      case "selection:remote:clear":
        clearRemoteSelection(msg.email);
        break;
      case "scroll:delta":
        window.scrollBy(0, msg.deltaY);
        break;
      case "scroll:to":
        window.scrollTo(0, msg.scrollTop);
        break;
      case "sidebar:state":
        document.documentElement.classList.toggle("hide-scrollbar", msg.open);
        break;
      case "highlights:request":
        reportHighlightPositions();
        break;
      case "scroll:request":
        sendToParent({
          type: "iframe:scroll",
          scrollTop: window.scrollY,
          scrollHeight: document.documentElement.scrollHeight,
        });
        break;
      case "selection:request":
        emitCurrentSelection("selection:geometry");
        break;
      case "selection:clear-request":
        window.getSelection()?.removeAllRanges();
        currentSelection = null;
        sendToParent({ type: "selection:clear" });
        break;
    }
  });

  interface HighlightComment {
    id: string;
    anchor?: LocalAnchor | null;
    resolved?: boolean;
    parent_id?: string | null;
  }

  let checkedComments: HighlightComment[] = [];

  function reportHighlightStates(comments: HighlightComment[]) {
    const hidden: string[] = [];
    const orphaned: string[] = [];
    for (const comment of comments) {
      if (!comment.anchor || comment.resolved || comment.parent_id) continue;
      const visibility = getAnchorVisibility(comment.anchor);
      if (visibility.kind === "hidden") hidden.push(comment.id);
      if (visibility.kind === "orphaned") orphaned.push(comment.id);
    }
    sendToParent({ type: "highlights:states", hidden, orphaned });
  }

  // Highlight rendering
  function renderHighlights(comments: HighlightComment[]) {
    renderedHighlights = comments;
    clearHighlightRects();
    syncOverlayRootBounds();

    for (const comment of comments) {
      if (!comment.anchor) continue;
      applyHighlight(comment);
    }

    if (activeHighlightId) {
      applyActiveHighlightState(activeHighlightId);
    }
    if (hoveredHighlightId) {
      applyHoveredHighlightState();
    }

    // Report positions after layout is ready
    requestAnimationFrame(() => {
      reportHighlightPositions();
    });

    ensureAnimationRefreshLoop();
  }

  function applyHighlight(comment: HighlightComment) {
    const anchor = comment.anchor;
    if (!anchor || !anchor.selectors) return;
    const fragments = findAnchorFragments(anchor);
    if (fragments.length === 0) return;

    const top = Math.min(...fragments.map((fragment) => fragment.top + window.scrollY));
    highlightPixelOffsets.set(comment.id, top);

    if (comment.resolved) return;

    const rects = createOverlayRects(
      fragments,
      "collab-highlight-rect",
      "commentId",
      comment.id,
      comment.id === "__compose__"
        ? undefined
        : () => {
        sendToParent({ type: "highlight:click", commentId: comment.id });
        },
    );
    if (rects.length > 0) {
      if (comment.id !== "__compose__") {
        rects.forEach((rect) => {
          rect.addEventListener("mouseenter", () => {
            hoveredHighlightId = comment.id;
            applyHoveredHighlightState();
          });
          rect.addEventListener("mouseleave", (event) => {
            if (isEventWithinHighlight(event.relatedTarget, comment.id)) return;
            if (hoveredHighlightId !== comment.id) return;
            hoveredHighlightId = null;
            applyHoveredHighlightState();
          });
        });
      }
      highlightRects.set(comment.id, rects);
    }
  }

  function getTextOffsetForRange(range: Range): number {
    const textIndex = collectDocumentTextIndex();
    for (const entry of textIndex.nodes) {
      if (entry.node === range.startContainer) {
        return entry.start + range.startOffset;
      }
    }
    return -1;
  }

  function getExactTextFromRange(range: Range): string {
    // cloneContents handles Element containers (e.g. when selection ends at
    // a <p> boundary) and its textContent concatenates without separators,
    // matching how findTextRange accumulates text on the receiving side.
    return range.cloneContents().textContent || "";
  }

  function findAnchorRange(anchor: LocalAnchor): Range | null {
    if (!anchor?.selectors) return null;

    const quote = anchor.selectors.find((selector) => selector.type === "TextQuoteSelector");
    if (!quote?.exact) return null;

    const textIndex = collectDocumentTextIndex();
    const position = anchor.selectors.find((selector) => selector.type === "TextPositionSelector");
    if (
      position &&
      typeof position.start === "number" &&
      typeof position.end === "number" &&
      textIndex.text.slice(position.start, position.end) === quote.exact
    ) {
      return createRangeFromOffsets(textIndex.nodes, position.start, position.end);
    }

    const match = findStrictQuoteOffsets(textIndex.text, quote.exact, quote.prefix, quote.suffix);
    if (!match) return null;

    return createRangeFromOffsets(textIndex.nodes, match.start, match.end);
  }

  function findElementFromAnchor(anchor: LocalAnchor): HTMLImageElement | HTMLCanvasElement | null {
    if (!anchor.selectors) return null;

    const selector = anchor.selectors.find((item): item is ElementSelector => {
      return item.type === "ElementSelector";
    });
    if (!selector?.cssSelector || !selector.tagName) return null;

    const directMatch = document.querySelector(selector.cssSelector);
    if (isAnnotatableElement(directMatch) && matchesElementSelector(directMatch, selector)) {
      return directMatch;
    }

    const candidates = Array.from(document.querySelectorAll(selector.tagName));
    const signatureMatches = candidates.filter((candidate) => {
      return isAnnotatableElement(candidate) && matchesElementSelector(candidate, selector);
    });

    if (signatureMatches.length === 1) {
      return signatureMatches[0];
    }

    if (typeof selector.ordinal !== "number") {
      return null;
    }

    const ordinalMatches = signatureMatches.filter((candidate) => {
      return getAnnotatableOrdinal(candidate) === selector.ordinal;
    });
    return ordinalMatches.length === 1 ? ordinalMatches[0] : null;
  }

  function matchesElementSelector(
    element: HTMLImageElement | HTMLCanvasElement,
    selector: ElementSelector,
  ): boolean {
    if (element.tagName.toLowerCase() !== selector.tagName) return false;
    if (element instanceof HTMLImageElement) {
      if (selector.src && element.getAttribute("src") !== selector.src) return false;
      if ((selector.alt ?? "") !== (element.getAttribute("alt") ?? "")) return false;
    }
    if (
      typeof selector.width === "number" &&
      getNumericElementDimension(element, "width") !== selector.width
    ) {
      return false;
    }
    if (
      typeof selector.height === "number" &&
      getNumericElementDimension(element, "height") !== selector.height
    ) {
      return false;
    }
    return true;
  }

  function findAnchorFragments(anchor: LocalAnchor): DOMRect[] {
    const visibility = getAnchorVisibility(anchor);
    return visibility.kind === "visible" ? visibility.fragments : [];
  }

  function getAnchorVisibility(
    anchor: LocalAnchor,
  ): { kind: "visible"; fragments: DOMRect[] } | { kind: "hidden" } | { kind: "orphaned" } {
    const element = findElementFromAnchor(anchor);
    if (element) {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return { kind: "visible", fragments: [rect] };
      }
      return { kind: "hidden" };
    }

    const elementSelector = anchor.selectors?.find((selector) => selector.type === "ElementSelector");
    if (elementSelector) return { kind: "orphaned" };

    const range = findAnchorRange(anchor);
    if (!range) return { kind: "orphaned" };

    const fragments = collectTextNodeFragments(range);
    if (fragments.length === 0) return { kind: "hidden" };
    return { kind: "visible", fragments };
  }

  function collectDocumentTextIndex() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let text = "";
    const nodes: { node: Text; start: number; end: number }[] = [];

    while (true) {
      const nextNode = walker.nextNode();
      if (!(nextNode instanceof Text)) break;
      const node = nextNode;
      if (!isCountedTextNode(node)) continue;
      const start = text.length;
      text += node.textContent || "";
      nodes.push({ node, start, end: text.length });
    }

    return { text, nodes };
  }

  function isCountedTextNode(node: Text): boolean {
    let current: Element | null = node.parentElement;
    while (current) {
      if (
        current.tagName === "SCRIPT" ||
        current.tagName === "STYLE" ||
        current.tagName === "NOSCRIPT" ||
        current.tagName === "TEMPLATE"
      ) {
        return false;
      }
      current = current.parentElement;
    }
    return true;
  }

  function findStrictQuoteOffsets(
    text: string,
    exact: string,
    prefix?: string,
    suffix?: string,
  ): { start: number; end: number } | null {
    const perfectMatches: { start: number; end: number }[] = [];
    const oneSidedMatches: { start: number; end: number }[] = [];
    const allMatches: { start: number; end: number }[] = [];
    let searchFrom = 0;

    while (true) {
      const index = text.indexOf(exact, searchFrom);
      if (index === -1) break;

      const candidate = { start: index, end: index + exact.length };
      const prefixMatched = Boolean(prefix) &&
        text.slice(Math.max(0, index - prefix.length), index) === prefix;
      const suffixMatched = Boolean(suffix) &&
        text.slice(index + exact.length, index + exact.length + suffix.length) === suffix;

      allMatches.push(candidate);
      if (prefixMatched && suffixMatched) {
        perfectMatches.push(candidate);
      } else if (prefixMatched || suffixMatched) {
        oneSidedMatches.push(candidate);
      }

      searchFrom = index + 1;
    }

    if (perfectMatches.length === 1) return perfectMatches[0];
    if (perfectMatches.length > 1) return null;
    if (oneSidedMatches.length === 1) return oneSidedMatches[0];
    if (oneSidedMatches.length > 1) return null;
    if (allMatches.length === 1 && exact.length >= 24) return allMatches[0];
    return null;
  }

  function createRangeFromOffsets(
    nodes: { node: Text; start: number; end: number }[],
    start: number,
    end: number,
  ): Range | null {
    let startNode: Text | null = null;
    let endNode: Text | null = null;
    let startOffset = 0;
    let endOffset = 0;

    for (const entry of nodes) {
      if (!startNode && start < entry.end) {
        startNode = entry.node;
        startOffset = start - entry.start;
      }
      if (end <= entry.end) {
        endNode = entry.node;
        endOffset = end - entry.start;
        break;
      }
    }

    if (!startNode || !endNode) return null;

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function activateHighlight(commentId: string) {
    activeHighlightId = commentId;
    applyActiveHighlightState(commentId);
    const rects = highlightRects.get(commentId);
    if (rects && rects.length > 0) {
      rects[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function deactivateHighlights() {
    activeHighlightId = null;
    for (const rects of highlightRects.values()) {
      rects.forEach((rect) => rect.classList.remove("active"));
    }
  }

  function applyHoveredHighlightState() {
    for (const [id, rects] of highlightRects) {
      rects.forEach((rect) => {
        rect.classList.toggle("hovered", id === hoveredHighlightId);
      });
    }
  }

  function applyActiveHighlightState(commentId: string) {
    for (const [id, rects] of highlightRects) {
      rects.forEach((rect) => {
        rect.classList.toggle("active", id === commentId);
      });
    }
  }

  function renderRemoteSelection(
    email: string,
    color: string,
    anchor: LocalAnchor,
  ) {
    clearRemoteSelection(email);
    if (!anchor || !anchor.selectors) return;

    remoteSelectionState.set(email, { color, anchor });
    syncOverlayRootBounds();
    const fragments = findAnchorFragments(anchor);
    if (fragments.length === 0) return;

    const rects = createOverlayRects(
      fragments,
      "collab-selection-rect",
      "selectionEmail",
      email,
    );
    rects.forEach((rect) => {
      rect.style.background = color + "20";
    });

    if (rects.length > 0) {
      remoteSelections.set(email, rects);
    }

    ensureAnimationRefreshLoop();
  }

  function clearRemoteSelection(email: string) {
    const rects = remoteSelections.get(email);
    if (rects) {
      for (const rect of rects) {
        rect.remove();
      }
    }
    remoteSelections.delete(email);
    remoteSelectionState.delete(email);
  }

  function getCssSelector(el: Element): string {
    if (el.id) return "#" + el.id;
    const parts: string[] = [];
    let current: Element | null = el;
    while (current && current !== document.body) {
      const selector =
        current.tagName.toLowerCase() +
        ":nth-child(" + (Array.from(current.parentElement?.children ?? []).indexOf(current) + 1) + ")";
      parts.unshift(selector);
      current = current.parentElement;
    }
    return "body > " + parts.join(" > ");
  }

  function rerenderOverlays() {
    syncOverlayRootBounds();
    if (renderedHighlights.length > 0) {
      renderHighlights(renderedHighlights);
    } else {
      clearHighlightRects();
      reportHighlightPositions();
    }

    if (checkedComments.length > 0) {
      reportHighlightStates(checkedComments);
    }

    const selections = Array.from(remoteSelectionState.entries());
    clearRemoteSelectionRects();
    for (const [email, selection] of selections) {
      renderRemoteSelection(email, selection.color, selection.anchor);
    }

    ensureAnimationRefreshLoop();
  }

  let refreshScheduled = false;
  let animationRefreshFrame: number | null = null;

  function scheduleOverlayRefresh() {
    if (refreshScheduled) return;
    refreshScheduled = true;
    requestAnimationFrame(() => {
      refreshScheduled = false;
      rerenderOverlays();
    });
  }

  function hasTrackedOverlayState(): boolean {
    return renderedHighlights.length > 0 || checkedComments.length > 0 || remoteSelectionState.size > 0;
  }

  function hasAnimatingAnchors(): boolean {
    if (document.hidden || !hasTrackedOverlayState()) return false;

    for (const comment of renderedHighlights) {
      if (comment.anchor && anchorHasRunningAnimation(comment.anchor)) {
        return true;
      }
    }

    for (const selection of remoteSelectionState.values()) {
      if (anchorHasRunningAnimation(selection.anchor)) {
        return true;
      }
    }

    return false;
  }

  function runAnimationRefreshLoop() {
    animationRefreshFrame = null;
    rerenderOverlays();
  }

  function ensureAnimationRefreshLoop() {
    if (animationRefreshFrame !== null) return;
    if (!hasAnimatingAnchors()) return;
    animationRefreshFrame = requestAnimationFrame(runAnimationRefreshLoop);
  }

  function anchorHasRunningAnimation(anchor: LocalAnchor): boolean {
    const element = findElementFromAnchor(anchor);
    if (element) {
      return elementOrAncestorHasRunningAnimation(element);
    }

    const range = findAnchorRange(anchor);
    if (!range) return false;

    const startElement = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement;
    return elementOrAncestorHasRunningAnimation(startElement);
  }

  function elementOrAncestorHasRunningAnimation(element: Element | null): boolean {
    let current = element;
    while (current) {
      if (current.getAnimations().some((animation) => animation.playState === "running")) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  function isOverlayMutationTarget(target: Node): boolean {
    return target === overlayRoot || overlayRoot.contains(target);
  }

  const mutationObserver = new MutationObserver((mutations) => {
    // Drain hover targets so we can identify class mutations we caused
    let drainedHoverTargets: Set<Element> | null = null;
    if (hoverMutationTargets.size > 0) {
      drainedHoverTargets = new Set(hoverMutationTargets);
      hoverMutationTargets.clear();
    }

    const shouldRefresh = mutations.some((mutation) => {
      if (isOverlayMutationTarget(mutation.target)) return false;
      // Ignore class mutations caused by hover-highlight toggling
      if (
        drainedHoverTargets &&
        mutation.type === "attributes" &&
        mutation.attributeName === "class" &&
        mutation.target instanceof Element &&
        drainedHoverTargets.has(mutation.target)
      ) {
        return false;
      }
      return true;
    });

    if (shouldRefresh) {
      scheduleOverlayRefresh();
    }
  });

  mutationObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden"],
  });

  // Signal parent that collab-client is ready to receive messages
  window.addEventListener("resize", () => {
    rerenderOverlays();
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      ensureAnimationRefreshLoop();
    }
  });

  sendToParent({ type: "collab:ready" });
})();
