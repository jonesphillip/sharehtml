import "./styles.css";

import type { Anchor, Comment, Reaction, Selector, ServerMessage, UserPresence } from "@sharehtml/shared";
import { isRecord } from "../types.js";
import {
  BROWSER_CAPABILITY_HEADER,
  WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX,
  WEBSOCKET_SUBPROTOCOL,
} from "../utils/security-constants.js";

type AuthMode = "access" | "none";
type ShareMode = "private" | "link" | "emails";
type ShareResponse = { mode: ShareMode; emails: string[] };

interface SelectionViewportRect {
  top: number;
  left: number;
  bottom: number;
  width: number;
  height: number;
}

interface CommentConfig {
  docId: string;
  email: string;
  authMode: AuthMode;
  shareMode: ShareMode;
  canManageSharing: boolean;
  contentPath: string;
  collabJsPath: string;
  viewerCapabilityToken: string;
}

interface ElementConstructor<T extends Element> {
  new(): T;
}

interface SelectionPayload {
  text: string;
  anchor: Anchor;
  pixelY: number;
  rect: SelectionViewportRect;
}

interface AnnotationHighlightItem {
  id: string;
  anchor: Anchor;
  resolved: boolean;
}

function parseCommentConfig(value: unknown): CommentConfig | null {
  if (!isRecord(value)) return null;
  if (typeof value.docId !== "string") return null;
  if (typeof value.email !== "string") return null;
  if (value.authMode !== "access" && value.authMode !== "none") return null;
  if (value.shareMode !== "private" && value.shareMode !== "link" && value.shareMode !== "emails") return null;
  if (typeof value.canManageSharing !== "boolean") return null;
  if (typeof value.contentPath !== "string") return null;
  if (typeof value.collabJsPath !== "string") return null;
  if (typeof value.viewerCapabilityToken !== "string") return null;

  return {
    docId: value.docId,
    email: value.email,
    authMode: value.authMode,
    shareMode: value.shareMode,
    canManageSharing: value.canManageSharing,
    contentPath: value.contentPath,
    collabJsPath: value.collabJsPath,
    viewerCapabilityToken: value.viewerCapabilityToken,
  };
}

function getCommentConfig(): CommentConfig {
  const config = parseCommentConfig(Reflect.get(window, "__COMMENT_CONFIG__"));
  if (!config) {
    throw new Error("missing viewer config");
  }
  return config;
}

function getRequiredElementById<T extends Element>(id: string, ctor: ElementConstructor<T>): T {
  const element = document.getElementById(id);
  if (!(element instanceof ctor)) {
    throw new Error(`missing required element: ${id}`);
  }
  return element;
}

const config = getCommentConfig();
const DOC_ID = config.docId;
const USER_EMAIL = config.email;
const AUTH_MODE = config.authMode;
const CAN_MANAGE_SHARING = config.canManageSharing;
const CONTENT_PATH = config.contentPath;
const COLLAB_JS_PATH = config.collabJsPath;
let VIEWER_CAPABILITY_TOKEN = config.viewerCapabilityToken;

// State
let ws: WebSocket | null = null;
let userName = localStorage.getItem("comment_name_" + USER_EMAIL) || "";
let userColor = "";
const users = new Map<string, UserPresence>();
let comments: Comment[] = [];
let showResolved = false;
let activeCommentId: string | null = null;
let orphanedAnnotationIds = new Set<string>();
let hiddenAnnotationIds = new Set<string>();
const hiddenSectionKey = "comment_hidden_section_" + DOC_ID;
let showHiddenSection = localStorage.getItem(hiddenSectionKey) === "expanded";
const sidebarKey = "comment_sidebar_" + DOC_ID;
let reactions: Reaction[] = [];
let pendingSelection: {
  text: string;
  anchor: Anchor;
  pixelY: number;
  rect: SelectionViewportRect;
} | null = null;
let composeAnchor: Anchor | null = null;
let composeText = "";
let composePixelY = 0;
let highlightPixelPositions: Record<string, number> = {};
let iframeScrollHeight = 0;
let iframeScrollTop = 0;
let iframeDriven = false;
let suppressScrollSync = false;
let sidebarSpacer: HTMLElement | null = null;
let hasAnimatedHighlights = false;
let shareMode: ShareMode = AUTH_MODE === "access" ? config.shareMode : "link";
let sharedEmails: string[] = [];
let emailsLoaded = false;
let shareMessageOverride: string | null = null;
let isSavingShareState = false;
const ANNOTATION_ALIGNMENT_BIAS_PX = 24;
const SELECTION_TOOLBAR_EMOJIS = [
  "\u{1F44D}",
  "\u{2764}\u{FE0F}",
  "\u{1F602}",
  "\u{1F389}",
  "\u{1F440}",
  "\u{1F525}",
  "\u{1F64F}",
  "\u{1F680}",
];
const SELECTION_TOOLBAR_GAP_PX = 8;
let selectionToolbar: HTMLElement | null = null;
let selectionEmojiPicker: HTMLElement | null = null;
let mobileSelectionBar: HTMLElement | null = null;
let mobileSelectionMode: "actions" | "compose" | "emoji" = "actions";
let mobileSelectionFocus: SelectionPayload | null = null;

// Elements
const iframe = getRequiredElementById("doc-iframe", HTMLIFrameElement);
const sidebar = getRequiredElementById("sidebar", HTMLDivElement);
const sidebarContent = getRequiredElementById("sidebar-content", HTMLDivElement);
const hiddenSectionHost = document.createElement("div");
const sidebarToggle = getRequiredElementById("sidebar-toggle", HTMLButtonElement);
const presenceDots = getRequiredElementById("presence-dots", HTMLDivElement);
const commentCount = getRequiredElementById("comment-count", HTMLSpanElement);
const filterResolved = getRequiredElementById("filter-resolved", HTMLButtonElement);
const nameModal = getRequiredElementById("name-modal", HTMLDivElement);
const modalEmail = getRequiredElementById("modal-email", HTMLDivElement);
const nameInput = getRequiredElementById("name-input", HTMLInputElement);
const nameSubmit = getRequiredElementById("name-submit", HTMLButtonElement);
const shareBtn = getRequiredElementById("share-btn", HTMLButtonElement);
const shareModal = getRequiredElementById("share-modal", HTMLDivElement);
const shareLinkInput = getRequiredElementById("share-link-input", HTMLInputElement);
const shareCopyBtn = getRequiredElementById("share-copy-btn", HTMLButtonElement);
const shareModeSelect = getRequiredElementById("share-mode-select", HTMLSelectElement);
const shareModeDescription = getRequiredElementById("share-mode-description", HTMLDivElement);
const shareEmailsSection = getRequiredElementById("share-emails-section", HTMLDivElement);
const shareEmailInput = getRequiredElementById("share-email-input", HTMLInputElement);
const shareEmailAdd = getRequiredElementById("share-email-add", HTMLButtonElement);
const shareEmailList = getRequiredElementById("share-email-list", HTMLDivElement);
const sidebarBackdrop = getRequiredElementById("sidebar-backdrop", HTMLDivElement);
const SANDBOXED_IFRAME_ORIGIN = "null";

hiddenSectionHost.className = "sidebar-hidden-host";
sidebar.appendChild(hiddenSectionHost);

function sendToIframe(message: Record<string, unknown>) {
  iframe.contentWindow?.postMessage(message, "*");
}

function isTrustedIframeMessage(event: MessageEvent) {
  return event.source === iframe.contentWindow && event.origin === SANDBOXED_IFRAME_ORIGIN;
}

function isMobileViewport(): boolean {
  return window.innerWidth <= 768;
}

function closeSidebar() {
  sidebar.classList.add("collapsed");
  localStorage.setItem(sidebarKey, "collapsed");
  sidebarBackdrop.classList.remove("visible");
  sendToIframe({ type: "sidebar:state", open: false });
  requestSelectionRefresh();
}

function clearPendingSelection() {
  pendingSelection = null;
  removeSelectionEmojiPicker();
  removeSelectionToolbar();
  removeMobileSelectionBar();
}

function setPendingSelection(
  text: string,
  anchor: Anchor,
  pixelY: number,
  rect: SelectionViewportRect,
) {
  pendingSelection = { text, anchor, pixelY, rect };
}

function requestIframeSelectionClear() {
  sendToIframe({ type: "selection:clear-request" });
}

function requestSelectionRefresh() {
  if (!pendingSelection) return;
  requestAnimationFrame(() => {
    sendToIframe({ type: "selection:request" });
  });
}

function clearSelectionUi({
  clearIframe = false,
  clearPresence = false,
}: { clearIframe?: boolean; clearPresence?: boolean } = {}) {
  clearPendingSelection();
  if (clearIframe) requestIframeSelectionClear();
  if (clearPresence) {
    sendMessage({
      type: "presence:update",
      selection: undefined,
    });
  }
}

function isSelectionViewportRect(value: unknown): value is SelectionViewportRect {
  if (!isRecord(value)) return false;
  const rect = value;
  return typeof rect.top === "number" && typeof rect.left === "number" &&
    typeof rect.bottom === "number" && typeof rect.width === "number" &&
    typeof rect.height === "number";
}

function parseSelectionPayload(value: unknown): SelectionPayload | null {
  if (!isRecord(value)) return null;
  if (typeof value.text !== "string") return null;
  if (typeof value.pixelY !== "number") return null;
  if (!isAnchor(value.anchor)) return null;
  if (!isSelectionViewportRect(value.rect)) return null;

  return {
    text: value.text,
    anchor: value.anchor,
    pixelY: value.pixelY,
    rect: value.rect,
  };
}

function getSelectionAnchorViewportRect() {
  if (!pendingSelection) return null;
  const iframeRect = iframe.getBoundingClientRect();
  return {
    top: iframeRect.top + pendingSelection.rect.top,
    bottom: iframeRect.top + pendingSelection.rect.bottom,
    centerX: iframeRect.left + pendingSelection.rect.left + pendingSelection.rect.width / 2,
  };
}

function getSelectionOverlaySafeTop(): number {
  const topbar = document.querySelector(".topbar");
  if (!(topbar instanceof HTMLElement)) {
    return 8;
  }

  return topbar.getBoundingClientRect().bottom + 8;
}

function isSelectionAnchorVisible(anchor: { top: number; bottom: number }): boolean {
  const safeTop = getSelectionOverlaySafeTop();
  const safeBottom = window.innerHeight - 8;
  return anchor.bottom > safeTop && anchor.top < safeBottom;
}

function setSelectionOverlayVisibility(element: HTMLElement | null, visible: boolean): void {
  if (!element) return;
  element.style.visibility = visible ? "visible" : "hidden";
  element.style.pointerEvents = visible ? "" : "none";
}

function getMobileSelectionSource(): SelectionPayload | null {
  return mobileSelectionFocus ?? pendingSelection;
}

function setMobileSelectionState(
  mode: "actions" | "compose" | "emoji",
  selection: SelectionPayload | null = null,
): void {
  mobileSelectionMode = mode;
  mobileSelectionFocus = selection;
}

function positionSelectionEmojiPicker() {
  if (!selectionEmojiPicker) return;
  const anchor = getSelectionAnchorViewportRect();
  if (!anchor || !isSelectionAnchorVisible(anchor)) {
    setSelectionOverlayVisibility(selectionEmojiPicker, false);
    return;
  }
  setSelectionOverlayVisibility(selectionEmojiPicker, true);

  const safeTop = getSelectionOverlaySafeTop();
  const toolbarRect = selectionToolbar?.getBoundingClientRect();
  const pickerRect = selectionEmojiPicker.getBoundingClientRect();
  const baseTop = toolbarRect
    ? toolbarRect.top - pickerRect.height - 4
    : anchor.top - pickerRect.height - (34 + SELECTION_TOOLBAR_GAP_PX);
  const fallbackTop = toolbarRect
    ? toolbarRect.bottom + 4
    : anchor.bottom + 34 + SELECTION_TOOLBAR_GAP_PX;
  const top = Math.min(
    Math.max(safeTop, baseTop >= safeTop ? baseTop : fallbackTop),
    window.innerHeight - pickerRect.height - 8,
  );
  const left = Math.min(
    Math.max(8, anchor.centerX - pickerRect.width / 2),
    window.innerWidth - pickerRect.width - 8,
  );
  selectionEmojiPicker.style.top = `${top}px`;
  selectionEmojiPicker.style.left = `${left}px`;
}

function positionSelectionToolbar() {
  if (isMobileViewport()) return;
  if (!selectionToolbar) return;
  const anchor = getSelectionAnchorViewportRect();
  if (!anchor || !isSelectionAnchorVisible(anchor)) {
    setSelectionOverlayVisibility(selectionToolbar, false);
    setSelectionOverlayVisibility(selectionEmojiPicker, false);
    return;
  }
  setSelectionOverlayVisibility(selectionToolbar, true);

  const safeTop = getSelectionOverlaySafeTop();
  const toolbarRect = selectionToolbar.getBoundingClientRect();
  const preferredTop = anchor.top >= safeTop + toolbarRect.height + SELECTION_TOOLBAR_GAP_PX
    ? anchor.top - toolbarRect.height - SELECTION_TOOLBAR_GAP_PX
    : anchor.bottom + SELECTION_TOOLBAR_GAP_PX;
  const top = Math.min(
    Math.max(safeTop, preferredTop),
    window.innerHeight - toolbarRect.height - 8,
  );
  const left = Math.min(
    Math.max(8, anchor.centerX - toolbarRect.width / 2),
    window.innerWidth - toolbarRect.width - 8,
  );

  selectionToolbar.style.top = `${top}px`;
  selectionToolbar.style.left = `${left}px`;
  positionSelectionEmojiPicker();
}

function removeSelectionEmojiPicker() {
  if (!selectionEmojiPicker) return;
  selectionEmojiPicker.remove();
  selectionEmojiPicker = null;
}

function removeSelectionToolbar() {
  if (!selectionToolbar) return;
  selectionToolbar.remove();
  selectionToolbar = null;
}

function removeMobileSelectionBar() {
  if (mobileSelectionBar) {
    mobileSelectionBar.remove();
    mobileSelectionBar = null;
  }
  setMobileSelectionState("actions");
}

function handleSelectionOverlayPointerDown(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function createSelectionOverlayButton(
  className: string,
  content: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = className;
  button.innerHTML = content;
  button.addEventListener("mousedown", handleSelectionOverlayPointerDown);
  button.addEventListener("click", function handleSelectionOverlayClick(event) {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function addReactionFromSelection(anchor: Anchor, emoji: string): void {
  sendMessage({
    type: "reaction:add",
    id: generateId(),
    emoji,
    anchor,
  });
  clearSelectionUi({ clearIframe: true, clearPresence: true });
}

function ensureMobileSelectionBar(): HTMLElement {
  if (mobileSelectionBar) return mobileSelectionBar;

  const bar = document.createElement("div");
  bar.className = "mobile-selection-bar";
  document.body.appendChild(bar);
  mobileSelectionBar = bar;
  return bar;
}

function showMobileSelectionActions(): void {
  const selection = pendingSelection;
  if (!selection) {
    removeMobileSelectionBar();
    return;
  }

  setMobileSelectionState("actions");

  const bar = ensureMobileSelectionBar();
  bar.innerHTML = "";
  bar.classList.add("visible");

  const commentBtn = createSelectionOverlayButton(
    "selection-toolbar-btn",
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;position:relative;top:0.5px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>comment',
    function openMobileCompose() {
      if (!pendingSelection) return;
      setMobileSelectionState("compose", pendingSelection);
      renderMobileSelectionBar();
    },
  );

  const divider = document.createElement("div");
  divider.className = "selection-toolbar-divider";

  const reactBtn = createSelectionOverlayButton(
    "selection-toolbar-btn",
    "\u{1F525} react",
    function openMobileReactions() {
      if (!pendingSelection) return;
      setMobileSelectionState("emoji", pendingSelection);
      renderMobileSelectionBar();
    },
  );

  bar.appendChild(commentBtn);
  bar.appendChild(divider);
  bar.appendChild(reactBtn);
}

function showMobileSelectionCompose(): void {
  const selection = getMobileSelectionSource();
  if (!selection) {
    removeMobileSelectionBar();
    return;
  }

  const bar = ensureMobileSelectionBar();
  bar.innerHTML = "";
  bar.classList.add("visible");

  const compose = document.createElement("div");
  compose.className = "mobile-compose";

  const quote = document.createElement("div");
  quote.className = "mobile-compose-quote";
  quote.textContent = selection.text.length > 60 ? selection.text.slice(0, 60) + "..." : selection.text;
  compose.appendChild(quote);

  const row = document.createElement("div");
  row.className = "mobile-compose-row";

  const input = document.createElement("textarea");
  input.className = "mobile-compose-input";
  input.placeholder = "add a comment...";
  input.rows = 1;

  const sendBtn = document.createElement("button");
  sendBtn.className = "mobile-compose-send";
  sendBtn.textContent = "send";

  input.addEventListener("input", function handleMobileComposeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    sendBtn.classList.toggle("active", Boolean(input.value.trim()));
  });

  sendBtn.addEventListener("click", function submitMobileCompose() {
    const content = input.value.trim();
    if (!content) return;
    sendMessage({
      type: "comment:create",
      id: generateId(),
      content,
      anchor: selection.anchor,
      parent_id: null,
    });
    clearSelectionUi({ clearIframe: true, clearPresence: true });
  });

  row.appendChild(input);
  row.appendChild(sendBtn);
  compose.appendChild(row);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "mobile-compose-cancel";
  cancelBtn.textContent = "cancel";
  cancelBtn.addEventListener("click", function cancelMobileCompose() {
    setMobileSelectionState("actions");
    renderMobileSelectionBar();
  });
  compose.appendChild(cancelBtn);

  bar.appendChild(compose);
  requestAnimationFrame(() => input.focus());
}

function showMobileSelectionEmojiRow(): void {
  const selection = getMobileSelectionSource();
  if (!selection) {
    removeMobileSelectionBar();
    return;
  }

  const bar = ensureMobileSelectionBar();
  bar.innerHTML = "";
  bar.classList.add("visible");

  for (const emoji of SELECTION_TOOLBAR_EMOJIS) {
    const button = createSelectionOverlayButton("mobile-emoji-btn", emoji, function addMobileReaction() {
      addReactionFromSelection(selection.anchor, emoji);
    });
    bar.appendChild(button);
  }

  const backBtn = createSelectionOverlayButton("selection-toolbar-btn mobile-selection-back", "\u{2190}", function backToActions() {
    setMobileSelectionState("actions");
    renderMobileSelectionBar();
  });
  bar.appendChild(backBtn);
}

function renderMobileSelectionBar(): void {
  if (!isMobileViewport()) {
    removeMobileSelectionBar();
    return;
  }

  const selection = getMobileSelectionSource();
  if (!selection) {
    removeMobileSelectionBar();
    return;
  }

  switch (mobileSelectionMode) {
    case "compose":
      showMobileSelectionCompose();
      break;
    case "emoji":
      showMobileSelectionEmojiRow();
      break;
    case "actions":
    default:
      showMobileSelectionActions();
      break;
  }
}

function renderPendingSelectionUi(): void {
  if (isMobileViewport()) {
    removeSelectionEmojiPicker();
    removeSelectionToolbar();
    renderMobileSelectionBar();
    return;
  }

  removeMobileSelectionBar();
  renderSelectionToolbar();
}

function openSelectionEmojiPicker() {
  if (!pendingSelection) return;
  if (isMobileViewport()) return;
  if (selectionEmojiPicker) {
    removeSelectionEmojiPicker();
    return;
  }

  const picker = document.createElement("div");
  picker.className = "selection-emoji-picker";

  const row = document.createElement("div");
  row.className = "selection-emoji-picker-row";
  for (const emoji of SELECTION_TOOLBAR_EMOJIS) {
    const button = createSelectionOverlayButton("selection-emoji-picker-btn", emoji, function addReaction() {
      if (!pendingSelection) return;
      addReactionFromSelection(pendingSelection.anchor, emoji);
    });
    row.appendChild(button);
  }
  picker.appendChild(row);

  document.body.appendChild(picker);
  selectionEmojiPicker = picker;
  positionSelectionEmojiPicker();
}

function renderSelectionToolbar() {
  if (isMobileViewport()) return;
  if (!pendingSelection) {
    clearPendingSelection();
    return;
  }

  if (!selectionToolbar) {
    const toolbar = document.createElement("div");
    toolbar.className = "selection-toolbar-overlay";

    const commentBtn = createSelectionOverlayButton(
      "selection-toolbar-btn",
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;position:relative;top:0.5px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>comment',
      function openSelectionCompose() {
        if (!pendingSelection) return;
        const selection = pendingSelection;
        clearSelectionUi({ clearIframe: true, clearPresence: true });
        openCompose(selection.text, selection.anchor, selection.pixelY);
      },
    );

    const divider = document.createElement("div");
    divider.className = "selection-toolbar-divider";

    const reactBtn = createSelectionOverlayButton(
      "selection-toolbar-btn",
      "\u{1F525} react",
      function openSelectionReactions() {
        openSelectionEmojiPicker();
      },
    );

    toolbar.appendChild(commentBtn);
    toolbar.appendChild(divider);
    toolbar.appendChild(reactBtn);
    document.body.appendChild(toolbar);
    selectionToolbar = toolbar;
  }

  positionSelectionToolbar();
}

function injectTag(html: string, tag: string, beforeCloseTag: string): string {
  const lastIndex = html.lastIndexOf(beforeCloseTag);
  if (lastIndex !== -1) {
    return html.slice(0, lastIndex) + tag + html.slice(lastIndex);
  }
  return html + tag;
}

function escapeInlineScript(script: string): string {
  return script.replace(/<\/script/gi, "<\\/script");
}

function injectDocumentRuntime(html: string, collabScriptText: string): string {
  const collabScript = `<script type="module">${escapeInlineScript(collabScriptText)}</script>`;
  return injectTag(html, collabScript, "</body>");
}

function renderIframeError(message: string) {
  iframe.srcdoc = `<!doctype html><html lang="en"><body><pre>${escapeHtml(message)}</pre></body></html>`;
}

async function viewerFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set(BROWSER_CAPABILITY_HEADER, VIEWER_CAPABILITY_TOKEN);
  return fetch(input, { ...init, headers });
}

// Refresh the capability token before it expires. The server issues tokens
// with a 10-minute TTL; we refresh every 8 minutes to stay ahead of expiry.
const CAPABILITY_REFRESH_INTERVAL_MS = 8 * 60 * 1000;

async function refreshCapabilityToken() {
  try {
    const response = await viewerFetch(`/d/${DOC_ID}/capability`, { method: "POST" });
    if (!response.ok) return;
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.token === "string") {
      VIEWER_CAPABILITY_TOKEN = body.token;
    }
  } catch {
    // Retry on the next interval.
  }
}

setInterval(refreshCapabilityToken, CAPABILITY_REFRESH_INTERVAL_MS);

async function loadDocumentIntoIframe() {
  try {
    const [contentResponse, collabResponse] = await Promise.all([
      viewerFetch(CONTENT_PATH),
      fetch(COLLAB_JS_PATH),
    ]);
    if (!contentResponse.ok) {
      throw new Error(`document fetch failed with status ${contentResponse.status}`);
    }
    if (!collabResponse.ok) {
      throw new Error(`collab fetch failed with status ${collabResponse.status}`);
    }

    const [html, collabScriptText] = await Promise.all([
      contentResponse.text(),
      collabResponse.text(),
    ]);
    iframe.srcdoc = injectDocumentRuntime(html, collabScriptText);
  } catch {
    renderIframeError("Unable to load document content.");
  }
}

function openDocumentLink(rawHref: unknown) {
  if (typeof rawHref !== "string" || rawHref.trim() === "") return;

  // Fragment-only links (e.g. "#section") have no meaningful target outside
  // the sandboxed iframe -- skip them to avoid navigating the parent shell.
  if (rawHref.startsWith("#")) return;

  let url: URL;
  try {
    // Try as an absolute URL first. Fall back to treating it as relative,
    // but note that relative hrefs will resolve against the parent shell's
    // URL since the iframe's srcdoc has no natural base.
    url = new URL(rawHref, location.href);
  } catch {
    return;
  }

  if (!["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) {
    return;
  }

  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

function getShareDescription(): string {
  if (shareMessageOverride) return shareMessageOverride;
  if (AUTH_MODE !== "access") return "anyone with the link can view and comment";
  switch (shareMode) {
    case "link":
      return "anyone allowed by your Cloudflare Access policy can view and comment";
    case "emails":
      if (sharedEmails.length === 0) return "add people to share this document";
      return `shared with ${sharedEmails.length} ${sharedEmails.length === 1 ? "person" : "people"}`;
    case "private":
      return "only you can open this document";
  }
}

function renderShareModal() {
  shareLinkInput.value = location.href;
  shareModeSelect.value = shareMode;
  shareModeSelect.disabled = isSavingShareState || !CAN_MANAGE_SHARING;
  shareModeDescription.textContent = getShareDescription();
  shareCopyBtn.textContent = "copy";
  shareCopyBtn.disabled = isSavingShareState;
  shareEmailsSection.style.display = shareMode === "emails" ? "" : "none";
  shareEmailInput.disabled = isSavingShareState || !CAN_MANAGE_SHARING;
  shareEmailAdd.classList.toggle("disabled", isSavingShareState || !CAN_MANAGE_SHARING);
  renderEmailList();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function renderEmailList() {
  if (!emailsLoaded && shareMode === "emails") {
    shareEmailList.innerHTML = '<div class="share-email-loading">loading…</div>';
    return;
  }
  shareEmailList.innerHTML = sharedEmails
    .map(
      (email) =>
        `<div class="share-email-item"><span>${escapeHtml(email)}</span>${CAN_MANAGE_SHARING ? `<button class="share-email-remove" data-email="${escapeAttr(email)}">×</button>` : ""}</div>`,
    )
    .join("");
}

function isShareMode(v: unknown): v is ShareMode {
  return v === "private" || v === "link" || v === "emails";
}

function parseShareResponse(data: unknown): ShareResponse | null {
  if (!isRecord(data) || !isShareMode(data.mode)) return null;
  const emails = Array.isArray(data.emails)
    ? data.emails.filter((email): email is string => typeof email === "string")
    : [];
  return { mode: data.mode, emails };
}

async function loadShareState() {
  if (emailsLoaded) return;
  try {
    const response = await viewerFetch(`/api/documents/${DOC_ID}/share`);
    if (!response.ok) throw new Error("fetch failed");
    const data = parseShareResponse(await response.json());
    if (!data) throw new Error("invalid response");
    shareMode = data.mode;
    sharedEmails = data.emails;
    emailsLoaded = true;
  } catch {
    emailsLoaded = true;
    sharedEmails = [];
  }
  renderShareModal();
}

async function updateShareMode(nextMode: ShareMode, nextEmails?: string[]): Promise<boolean> {
  if (!CAN_MANAGE_SHARING || AUTH_MODE !== "access") {
    renderShareModal();
    return true;
  }

  isSavingShareState = true;
  shareMessageOverride = "saving…";
  renderShareModal();

  try {
    const body: Record<string, unknown> = { mode: nextMode };
    if (nextMode === "emails") {
      body.emails = nextEmails ?? sharedEmails;
    }

    const response = await viewerFetch(`/api/documents/${DOC_ID}/share`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      shareMessageOverride = "could not update sharing. try again.";
      return false;
    }

    const result = parseShareResponse(await response.json());
    if (!result) {
      shareMessageOverride = "unexpected response. try again.";
      return false;
    }

    shareMode = result.mode;
    sharedEmails = result.emails;
    emailsLoaded = true;
    shareMessageOverride = null;
    return true;
  } catch {
    shareMessageOverride = "could not update sharing. try again.";
    return false;
  } finally {
    isSavingShareState = false;
    renderShareModal();
  }
}

async function addEmail(email: string): Promise<boolean> {
  const normalized = email.toLowerCase().trim();
  if (!normalized || !normalized.includes("@")) return false;
  if (normalized === USER_EMAIL.toLowerCase()) {
    shareMessageOverride = "you already have access as the owner";
    renderShareModal();
    return false;
  }
  if (sharedEmails.includes(normalized)) return true;
  if (sharedEmails.length >= 100) {
    shareMessageOverride = "maximum 100 people";
    renderShareModal();
    return false;
  }
  return updateShareMode("emails", [...sharedEmails, normalized]);
}

async function removeEmail(email: string): Promise<boolean> {
  const remaining = sharedEmails.filter((e) => e !== email);
  return updateShareMode("emails", remaining);
}

// Init
function init() {
  if (!userName) {
    showNameModal();
  } else {
    connectWs();
  }
  setupEventListeners();

  // Tell iframe whether to hide its scrollbar (desktop only — on mobile sidebar is overlay)
  iframe.addEventListener("load", () => {
    sendToIframe({ type: "collab:init" });
    const isOpen = !sidebar.classList.contains("collapsed") && window.innerWidth > 768;
    sendToIframe({ type: "sidebar:state", open: isOpen });
  });

  void loadDocumentIntoIframe();
}

function showNameModal() {
  modalEmail.textContent = USER_EMAIL;
  nameModal.style.display = "flex";
  nameInput.focus();
}

function setupEventListeners() {
  // Name modal
  nameInput.addEventListener("input", () => {
    nameSubmit.disabled = !nameInput.value.trim();
  });
  nameSubmit.addEventListener("click", () => {
    userName = nameInput.value.trim();
    if (!userName) return;
    localStorage.setItem("comment_name_" + USER_EMAIL, userName);
    nameModal.style.display = "none";
    connectWs();
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && nameInput.value.trim()) {
      nameSubmit.click();
    }
  });

  // Sidebar toggle — restore persisted state (inline <head> script handles flicker)
  if (localStorage.getItem(sidebarKey) === "collapsed") {
    sidebar.classList.add("collapsed");
  } else {
    sidebarBackdrop.classList.add("visible");
  }
  document.documentElement.classList.remove("sidebar-start-collapsed");
  sidebarToggle.addEventListener("click", () => {
    clearSelectionUi({ clearIframe: true, clearPresence: true });
    sidebar.classList.toggle("collapsed");
    const isOpen = !sidebar.classList.contains("collapsed");
    localStorage.setItem(sidebarKey, isOpen ? "open" : "collapsed");
    sidebarBackdrop.classList.toggle("visible", isOpen);
    // On mobile, sidebar is overlay — don't hide iframe scrollbar
    const hideScroll = isOpen && window.innerWidth > 768;
    sendToIframe({ type: "sidebar:state", open: hideScroll });
    requestSelectionRefresh();
  });

  sidebarBackdrop.addEventListener("click", closeSidebar);

  // Share button
  shareBtn.addEventListener("click", () => {
    clearSelectionUi({ clearIframe: true, clearPresence: true });
    shareMessageOverride = null;
    renderShareModal();
    shareModal.style.display = "flex";
    shareLinkInput.select();
    loadShareState();
  });
  shareCopyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
      shareCopyBtn.textContent = "copied!";
      setTimeout(() => {
        shareCopyBtn.textContent = "copy";
      }, 1500);
    });
  });
  shareModeSelect.addEventListener("change", async () => {
    const nextMode = shareModeSelect.value;
    if (!isShareMode(nextMode)) return;
    const saved = await updateShareMode(nextMode);
    if (!saved) {
      shareModeSelect.value = shareMode;
    }
  });
  shareEmailAdd.addEventListener("click", async () => {
    const email = shareEmailInput.value.trim();
    if (await addEmail(email)) {
      shareEmailInput.value = "";
    }
  });
  shareEmailInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const email = shareEmailInput.value.trim();
    if (await addEmail(email)) {
      shareEmailInput.value = "";
    }
  });
  shareEmailList.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest(".share-email-remove");
    if (!(btn instanceof HTMLElement)) return;
    const email = btn.dataset.email;
    if (email) removeEmail(email);
  });
  shareModal.addEventListener("click", (e) => {
    if (e.target === shareModal) shareModal.style.display = "none";
  });

  // Filter resolved
  filterResolved.addEventListener("click", () => {
    showResolved = !showResolved;
    filterResolved.classList.toggle("active", showResolved);
    renderComments();
  });

  // Forward sidebar wheel events to iframe so scrolling over sidebar scrolls the doc
  // (desktop only — on mobile sidebar is overlay with independent scroll)
  sidebarContent.addEventListener("wheel", (e) => {
    if (window.innerWidth <= 768) return;
    e.preventDefault();
    // Optimistically update sidebar scroll immediately (avoid round-trip lag)
    iframeDriven = true;
    sidebarContent.scrollTop += e.deltaY;
    iframeScrollTop = sidebarContent.scrollTop;
    requestAnimationFrame(() => { iframeDriven = false; });
    sendToIframe({ type: "scroll:delta", deltaY: e.deltaY });
  }, { passive: false });

  // Forward sidebar scrollbar drag to iframe (desktop only)
  sidebarContent.addEventListener("scroll", () => {
    if (iframeDriven || window.innerWidth <= 768) return;
    sendToIframe({ type: "scroll:to", scrollTop: sidebarContent.scrollTop });
  });

  // Listen for messages from iframe
  window.addEventListener("message", handleIframeMessage);
  window.addEventListener("resize", handleViewportResize);
  document.addEventListener("mousedown", (event) => {
    if (isMobileViewport()) return;
    const target = event.target;
    if (!(target instanceof Node) || !pendingSelection) return;
    if (selectionToolbar?.contains(target) || selectionEmojiPicker?.contains(target)) return;
    clearSelectionUi({ clearIframe: true, clearPresence: true });
  });
}

function handleViewportResize(): void {
  if (isMobileViewport()) {
    removeSelectionEmojiPicker();
    removeSelectionToolbar();
    if (pendingSelection || mobileSelectionFocus) {
      renderMobileSelectionBar();
    }
    return;
  }

  removeMobileSelectionBar();
  if (pendingSelection) {
    renderSelectionToolbar();
    positionSelectionToolbar();
  }
}

// WebSocket
let reconnectAttempts = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPong = 0;

function connectWs() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = new URL(protocol + "//" + location.host + "/d/" + DOC_ID + "/ws");
  const capabilityProtocol = `${WEBSOCKET_CAPABILITY_PROTOCOL_PREFIX}${VIEWER_CAPABILITY_TOKEN}`;
  ws = new WebSocket(wsUrl.toString(), [WEBSOCKET_SUBPROTOCOL, capabilityProtocol]);

  ws.addEventListener("open", () => {
    reconnectAttempts = 0;
    lastPong = Date.now();
    ws!.send(
      JSON.stringify({
        type: "user:join",
        name: userName,
        email: USER_EMAIL,
      }),
    );
    startHeartbeat();
  });

  ws.addEventListener("message", (e) => {
    lastPong = Date.now();
    if (e.data === "pong") return;
    if (typeof e.data !== "string") return;
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(e.data);
    } catch {
      return;
    }
    const msg = parseServerMessage(rawMessage);
    if (!msg) return;
    handleServerMessage(msg);
  });

  ws.addEventListener("close", () => {
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    ws?.close();
  });
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) {
      // If no message received in 35s, connection is likely dead
      if (Date.now() - lastPong > 35000) {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  const delay = Math.min(1000 * 2 ** reconnectAttempts, 30000);
  reconnectAttempts++;
  setTimeout(connectWs, delay);
}

// Reconnect immediately when tab becomes visible (e.g. after laptop sleep)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ws?.readyState !== WebSocket.OPEN) {
    reconnectAttempts = 0;
    ws?.close();
    connectWs();
  }
});

function sendMessage(msg: Record<string, unknown>) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function isSelector(value: unknown): value is Selector {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  switch (value.type) {
    case "TextQuoteSelector":
      return typeof value.exact === "string" &&
        typeof value.prefix === "string" &&
        typeof value.suffix === "string";
    case "TextPositionSelector":
      return typeof value.start === "number" && typeof value.end === "number";
    case "CssSelector":
      return typeof value.value === "string";
    case "RegionSelector":
      return typeof value.cssSelector === "string" &&
        typeof value.x === "number" &&
        typeof value.y === "number" &&
        typeof value.width === "number" &&
        typeof value.height === "number";
    case "ElementSelector":
      if (typeof value.cssSelector !== "string") return false;
      if (value.tagName !== "img" && value.tagName !== "canvas") return false;
      if ("ordinal" in value && value.ordinal !== undefined && typeof value.ordinal !== "number") return false;
      if ("src" in value && value.src !== undefined && typeof value.src !== "string") return false;
      if ("alt" in value && value.alt !== undefined && typeof value.alt !== "string") return false;
      if ("width" in value && value.width !== undefined && typeof value.width !== "number") return false;
      if ("height" in value && value.height !== undefined && typeof value.height !== "number") return false;
      return true;
    default:
      return false;
  }
}

function isAnchor(value: unknown): value is Anchor {
  return isRecord(value) &&
    Array.isArray(value.selectors) &&
    value.selectors.every(isSelector);
}

function isPresenceSelection(
  value: unknown,
): value is NonNullable<UserPresence["selection"]> {
  return isRecord(value) &&
    isAnchor(value.anchor) &&
    typeof value.text === "string";
}

function isUserPresence(value: unknown): value is UserPresence {
  return isRecord(value) &&
    typeof value.email === "string" &&
    typeof value.name === "string" &&
    typeof value.color === "string" &&
    typeof value.last_seen === "number" &&
    (value.selection === undefined || isPresenceSelection(value.selection));
}

function isComment(value: unknown): value is Comment {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.document_id === "string" &&
    typeof value.author_email === "string" &&
    typeof value.author_name === "string" &&
    typeof value.author_color === "string" &&
    typeof value.content === "string" &&
    (value.anchor === null || isAnchor(value.anchor)) &&
    (value.parent_id === null || typeof value.parent_id === "string") &&
    typeof value.resolved === "boolean" &&
    typeof value.created_at === "string" &&
    typeof value.updated_at === "string";
}

function isReaction(value: unknown): value is Reaction {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.document_id === "string" &&
    typeof value.author_email === "string" &&
    typeof value.author_name === "string" &&
    typeof value.emoji === "string" &&
    isAnchor(value.anchor) &&
    typeof value.created_at === "string";
}

const serverMessageTypes = new Set<string>([
  "users:list",
  "comments:list",
  "user:joined",
  "user:left",
  "user:name_set",
  "presence:updated",
  "comment:created",
  "comment:updated",
  "comment:deleted",
  "comment:resolved",
  "reactions:list",
  "reaction:added",
  "reaction:removed",
  "error",
]);

function parseServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string" || !serverMessageTypes.has(value.type)) {
    return null;
  }

  switch (value.type) {
    case "users:list":
      if (!Array.isArray(value.users) || !value.users.every(isUserPresence)) return null;
      return { type: "users:list", users: value.users };
    case "comments:list":
      if (!Array.isArray(value.comments) || !value.comments.every(isComment)) return null;
      return { type: "comments:list", comments: value.comments };
    case "user:joined":
      if (!isUserPresence(value.user)) return null;
      return { type: "user:joined", user: value.user };
    case "user:left":
      if (typeof value.email !== "string") return null;
      return { type: "user:left", email: value.email };
    case "user:name_set":
      if (typeof value.email !== "string" || typeof value.name !== "string") return null;
      return { type: "user:name_set", email: value.email, name: value.name };
    case "presence:updated":
      if (typeof value.email !== "string") return null;
      if (value.selection !== undefined && !isPresenceSelection(value.selection)) return null;
      return { type: "presence:updated", email: value.email, selection: value.selection };
    case "comment:created":
      if (!isComment(value.comment)) return null;
      return { type: "comment:created", comment: value.comment };
    case "comment:updated":
      if (!isComment(value.comment)) return null;
      return { type: "comment:updated", comment: value.comment };
    case "comment:deleted":
      if (typeof value.id !== "string") return null;
      return { type: "comment:deleted", id: value.id };
    case "comment:resolved":
      if (typeof value.id !== "string" || typeof value.resolved !== "boolean") return null;
      return { type: "comment:resolved", id: value.id, resolved: value.resolved };
    case "reactions:list":
      if (!Array.isArray(value.reactions) || !value.reactions.every(isReaction)) return null;
      return { type: "reactions:list", reactions: value.reactions };
    case "reaction:added":
      if (!isReaction(value.reaction)) return null;
      return { type: "reaction:added", reaction: value.reaction };
    case "reaction:removed":
      if (typeof value.id !== "string") return null;
      return { type: "reaction:removed", id: value.id };
    case "error":
      if (typeof value.message !== "string") return null;
      return { type: "error", message: value.message };
    default:
      return null;
  }
}

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "users:list":
      users.clear();
      for (const u of msg.users) {
        users.set(u.email, u);
        if (u.email === USER_EMAIL) userColor = u.color;
      }
      renderPresence();
      break;

    case "user:joined":
      users.set(msg.user.email, msg.user);
      renderPresence();
      break;

    case "user:left":
      users.delete(msg.email);
      renderPresence();
      sendToIframe({ type: "selection:remote:clear", email: msg.email });
      break;

    case "user:name_set": {
      const u = users.get(msg.email);
      if (u) {
        u.name = msg.name;
        users.set(msg.email, u);
      }
      renderPresence();
      renderComments();
      break;
    }

    case "presence:updated":
      if (msg.selection) {
        const u = users.get(msg.email);
        sendToIframe({
          type: "selection:remote",
          email: msg.email,
          color: u?.color || "#000",
          anchor: msg.selection.anchor,
        });
      } else {
        sendToIframe({
          type: "selection:remote:clear",
          email: msg.email,
        });
      }
      break;

    case "comments:list":
      comments = msg.comments;
      renderComments();
      updateHighlights();
      break;

    case "comment:created":
      comments.push(msg.comment);
      renderComments();
      updateHighlights();
      break;

    case "comment:updated": {
      const idx = comments.findIndex((c) => c.id === msg.comment.id);
      if (idx >= 0) comments[idx] = msg.comment;
      renderComments();
      updateHighlights();
      break;
    }

    case "comment:deleted":
      comments = comments.filter((c) => c.id !== msg.id && c.parent_id !== msg.id);
      renderComments();
      updateHighlights();
      break;

    case "comment:resolved": {
      const c = comments.find((c) => c.id === msg.id);
      if (c) c.resolved = msg.resolved;
      renderComments();
      updateHighlights();
      break;
    }

    case "reactions:list":
      reactions = msg.reactions;
      updateReactions();
      break;

    case "reaction:added":
      reactions.push(msg.reaction);
      updateReactions();
      break;

    case "reaction:removed":
      reactions = reactions.filter((r) => r.id !== msg.id);
      updateReactions();
      break;

    case "error":
      console.error("Server error:", msg.message);
      break;
  }
}

function parsePixelPositions(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};

  const pixelPositions: Record<string, number> = {};
  for (const [id, top] of Object.entries(value)) {
    if (typeof top === "number") {
      pixelPositions[id] = top;
    }
  }
  return pixelPositions;
}

// Handle messages from iframe
function handleIframeMessage(e: MessageEvent) {
  if (!isTrustedIframeMessage(e)) return;
  if (!isRecord(e.data) || typeof e.data.type !== "string") return;
  const msg = e.data;

  switch (msg.type) {
    case "selection:made": {
      const selection = parseSelectionPayload(msg);
      if (!selection) break;
      setPendingSelection(selection.text, selection.anchor, selection.pixelY, selection.rect);
      sendMessage({
        type: "presence:update",
        selection: { anchor: selection.anchor, text: selection.text },
      });
      if (isMobileViewport() && mobileSelectionMode !== "actions") break;
      renderPendingSelectionUi();
      break;
    }

    case "selection:geometry": {
      const selection = parseSelectionPayload(msg);
      if (!selection) break;
      setPendingSelection(selection.text, selection.anchor, selection.pixelY, selection.rect);
      if (isMobileViewport() && mobileSelectionMode !== "actions") break;
      renderPendingSelectionUi();
      break;
    }

    case "selection:clear":
      if (isMobileViewport() && mobileSelectionMode !== "actions" && mobileSelectionFocus) {
        pendingSelection = null;
        removeSelectionEmojiPicker();
        removeSelectionToolbar();
      } else if (!composeAnchor) {
        clearPendingSelection();
      }
      sendMessage({
        type: "presence:update",
        selection: undefined,
      });
      break;

    case "highlight:click":
      if (typeof msg.commentId !== "string") break;
      scrollToComment(msg.commentId);
      break;

    case "collab:ready":
      // Iframe collab-client just loaded — re-send highlights and state
      sendToIframe({ type: "collab:init" });
      updateHighlights();
      sendToIframe({
        type: "sidebar:state",
        open: !sidebar.classList.contains("collapsed"),
      });
      sendToIframe({ type: "scroll:request" });
      break;

    case "highlights:states":
      {
        if (!Array.isArray(msg.hidden) || !Array.isArray(msg.orphaned)) break;
        const nextHiddenIds = new Set(msg.hidden.filter((id): id is string => typeof id === "string"));
        const nextOrphanedIds = new Set(msg.orphaned.filter((id): id is string => typeof id === "string"));
        const statesChanged =
          !setsEqual(hiddenAnnotationIds, nextHiddenIds) ||
          !setsEqual(orphanedAnnotationIds, nextOrphanedIds);
        hiddenAnnotationIds = nextHiddenIds;
        orphanedAnnotationIds = nextOrphanedIds;
        if (!composeAnchor && statesChanged) {
          renderComments();
        }
      }
      break;

    case "highlights:positions": {
      if (!isRecord(msg.pixelPositions) || typeof msg.scrollHeight !== "number") break;
      const nextPixelPositions = parsePixelPositions(msg.pixelPositions);
      iframeScrollHeight = msg.scrollHeight;
      const nextAnimatedHighlights = Boolean(msg.animating);
      let shouldRender = false;

      if (nextAnimatedHighlights) {
        if (!hasAnimatedHighlights) {
          highlightPixelPositions = nextPixelPositions;
          shouldRender = true;
        } else {
          const mergedPixelPositions = { ...highlightPixelPositions };
          let addedPosition = false;
          for (const [id, top] of Object.entries(nextPixelPositions)) {
            if (id in mergedPixelPositions) continue;
            mergedPixelPositions[id] = top;
            addedPosition = true;
          }
          if (addedPosition) {
            highlightPixelPositions = mergedPixelPositions;
            shouldRender = true;
          }
        }
      } else {
        highlightPixelPositions = nextPixelPositions;
        shouldRender = true;
      }

      hasAnimatedHighlights = nextAnimatedHighlights;

      if (!composeAnchor && shouldRender) {
        renderComments();
      }
      break;
    }

    case "iframe:scroll":
      if (typeof msg.scrollHeight !== "number" || typeof msg.scrollTop !== "number") break;
      iframeScrollHeight = msg.scrollHeight;
      if (pendingSelection) {
        if (isMobileViewport()) {
          if (mobileSelectionMode === "actions") {
            renderMobileSelectionBar();
          }
        } else {
          positionSelectionToolbar();
        }
      }
      // On mobile, sidebar is overlay — don't sync scroll
      if (window.innerWidth <= 768) break;
      updateSidebarSpacer();
      if (!suppressScrollSync) {
        iframeScrollTop = msg.scrollTop;
        iframeDriven = true;
        sidebarContent.scrollTop = msg.scrollTop;
        requestAnimationFrame(() => { iframeDriven = false; });
      }
      break;

    case "document:open-link":
      openDocumentLink(msg.href);
      break;
  }
}

// Presence rendering
const MAX_VISIBLE_DOTS = window.innerWidth <= 768 ? 2 : 4;

function renderPresence() {
  presenceDots.innerHTML = "";
  const userList = Array.from(users.values());
  const overflow = userList.length > MAX_VISIBLE_DOTS;
  const visible = overflow ? userList.slice(0, MAX_VISIBLE_DOTS) : userList;

  for (const u of visible) {
    presenceDots.appendChild(createPresenceDot(u));
  }

  if (overflow) {
    const remaining = userList.slice(MAX_VISIBLE_DOTS);
    const wrapper = document.createElement("div");
    wrapper.className = "presence-dot-wrapper";

    const dot = document.createElement("div");
    dot.className = "presence-dot presence-overflow-dot";
    dot.textContent = "\u{22EF}";

    const tooltip = document.createElement("div");
    tooltip.className = "presence-tooltip presence-overflow-tooltip";

    for (const u of remaining) {
      const row = document.createElement("div");
      row.className = "presence-overflow-row";

      const avatar = document.createElement("div");
      avatar.className = "presence-overflow-avatar";
      avatar.style.background = u.color;
      avatar.textContent = getInitials(u.name || u.email);

      const info = document.createElement("div");
      info.className = "presence-overflow-info";
      const nameEl = document.createElement("div");
      nameEl.className = "presence-tooltip-name";
      nameEl.textContent = u.name || u.email;
      const emailEl = document.createElement("div");
      emailEl.className = "presence-tooltip-email";
      emailEl.textContent = u.email;
      info.appendChild(nameEl);
      info.appendChild(emailEl);

      row.appendChild(avatar);
      row.appendChild(info);
      tooltip.appendChild(row);
    }

    wrapper.appendChild(dot);
    wrapper.appendChild(tooltip);
    presenceDots.appendChild(wrapper);
  }
}

function createPresenceDot(u: UserPresence) {
  const wrapper = document.createElement("div");
  wrapper.className = "presence-dot-wrapper";

  const dot = document.createElement("div");
  dot.className = "presence-dot";
  dot.style.background = u.color;
  dot.textContent = getInitials(u.name || u.email);

  const tooltip = document.createElement("div");
  tooltip.className = "presence-tooltip";

  const avatar = document.createElement("div");
  avatar.className = "presence-tooltip-avatar";
  avatar.style.background = u.color;
  avatar.textContent = getInitials(u.name || u.email);

  const info = document.createElement("div");
  info.className = "presence-tooltip-info";
  const nameEl = document.createElement("div");
  nameEl.className = "presence-tooltip-name";
  nameEl.textContent = u.name || u.email;
  const emailEl = document.createElement("div");
  emailEl.className = "presence-tooltip-email";
  emailEl.textContent = u.email;
  info.appendChild(nameEl);
  info.appendChild(emailEl);

  tooltip.appendChild(avatar);
  tooltip.appendChild(info);
  wrapper.appendChild(dot);
  wrapper.appendChild(tooltip);
  return wrapper;
}

function getInitials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Comment rendering
interface ReactionGroup {
  anchor: Anchor;
  text: string;
  reactions: Reaction[];
}

function renderComments() {
  const topLevel = comments.filter((c) => !c.parent_id);
  const filtered = showResolved ? topLevel : topLevel.filter((c) => !c.resolved);
  const visibleComments = filtered.filter((comment) => !hiddenAnnotationIds.has(comment.id));
  const hiddenComments = filtered.filter((comment) => hiddenAnnotationIds.has(comment.id));
  const resolvedCount = topLevel.filter((c) => c.resolved).length;
  const reactionGroups = getReactionGroups();
  const visibleReactionGroups = reactionGroups.filter((group) =>
    !hiddenAnnotationIds.has(getReactionGroupId(group))
  );
  const hiddenReactionGroups = reactionGroups.filter((group) =>
    hiddenAnnotationIds.has(getReactionGroupId(group))
  );
  const hiddenAnnotationCount = hiddenComments.length + hiddenReactionGroups.length;
  const totalItems = topLevel.length + reactionGroups.length;
  const hasVisibleAnnotations =
    visibleComments.length > 0 || visibleReactionGroups.length > 0 || Boolean(composeAnchor);
  const hiddenSectionForcedOpen = hiddenAnnotationCount > 0 && !hasVisibleAnnotations;
  const hiddenSectionExpanded = hiddenAnnotationCount > 0 &&
    (showHiddenSection || hiddenSectionForcedOpen);

  commentCount.textContent = totalItems + " annotation" + (totalItems !== 1 ? "s" : "");
  const toggleText = sidebarToggle.querySelector(".sidebar-toggle-text");
  if (toggleText) toggleText.textContent = totalItems > 0 ? "comments \u{00B7} " + totalItems : "comments";
  filterResolved.textContent = showResolved ? "hide resolved" : "resolved (" + resolvedCount + ")";
  filterResolved.style.display = resolvedCount > 0 ? "" : "none";

  if (
    visibleComments.length === 0 &&
    hiddenComments.length === 0 &&
    visibleReactionGroups.length === 0 &&
    hiddenReactionGroups.length === 0 &&
    !composeAnchor
  ) {
    hiddenSectionHost.innerHTML = "";
    hiddenSectionHost.classList.remove("visible");
    sidebarContent.innerHTML =
      '<div class="sidebar-empty">select text in the document to add a comment or reaction</div>';
    return;
  }

  sidebarContent.innerHTML = "";
  hiddenSectionHost.innerHTML = "";
  hiddenSectionHost.classList.remove("visible");

  // Build unified list of annotations sorted by document position
  type Annotation =
    | { kind: "comment"; id: string; comment: Comment }
    | { kind: "reaction"; id: string; group: ReactionGroup }
    | { kind: "compose"; id: string };

  const annotations: Annotation[] = [];
  for (const comment of visibleComments) {
    annotations.push({ kind: "comment", id: comment.id, comment });
  }
  for (const group of visibleReactionGroups) {
    annotations.push({ kind: "reaction", id: getReactionGroupId(group), group });
  }
  if (composeAnchor) {
    annotations.push({ kind: "compose", id: "__compose__" });
  }

  // Sort by document position (items without a position go to the end)
  const allPixelPositions = { ...highlightPixelPositions };
  if (composeAnchor && composePixelY > 0) {
    allPixelPositions["__compose__"] = composePixelY;
  }

  annotations.sort((a, b) => {
    // Sort by pixel position when available, fall back to highlight order
    const posA = allPixelPositions[a.id] ?? Infinity;
    const posB = allPixelPositions[b.id] ?? Infinity;
    return posA - posB;
  });

  const isMobile = window.innerWidth <= 768;
  const hasPixelPositions = !isMobile && Object.keys(allPixelPositions).length > 0;
  let lastBottom = 0;
  let idx = 0;

  for (const item of annotations) {
    const card = createAnnotationCard(item);

    // Position card to align with its anchor in the document (desktop only)
    if (hasPixelPositions && item.id in allPixelPositions) {
      const targetY = Math.max(0, allPixelPositions[item.id] - ANNOTATION_ALIGNMENT_BIAS_PX);
      const gap = Math.max(8, targetY - lastBottom);
      card.style.marginTop = gap + "px";
    } else {
      card.style.marginTop = idx > 0 ? "12px" : "0";
    }

    sidebarContent.appendChild(card);

    if (hasPixelPositions && item.id in allPixelPositions) {
      lastBottom = card.offsetTop + card.offsetHeight;
    }
    idx++;
  }

  if (hiddenAnnotationCount > 0) {
    const hiddenSection = document.createElement("div");
    hiddenSection.className = "sidebar-section";
    if (!hiddenSectionExpanded) {
      hiddenSection.classList.add("collapsed");
    }

    const heading = hiddenSectionForcedOpen
      ? document.createElement("div")
      : document.createElement("button");
    heading.className = hiddenSectionForcedOpen ? "sidebar-section-label" : "sidebar-section-toggle";
    heading.textContent = getHiddenSectionLabel(
      hiddenAnnotationCount,
      hiddenSectionExpanded,
      hiddenSectionForcedOpen,
    );
    if (heading instanceof HTMLButtonElement) {
      heading.type = "button";
      heading.addEventListener("click", () => {
        showHiddenSection = !hiddenSectionExpanded;
        localStorage.setItem(hiddenSectionKey, showHiddenSection ? "expanded" : "collapsed");
        renderComments();
      });
    }
    hiddenSection.appendChild(heading);

    if (hiddenSectionExpanded) {
      for (const comment of hiddenComments) {
        const card = createCommentCard(comment);
        card.style.marginTop = "12px";
        hiddenSection.appendChild(card);
      }
      for (const group of hiddenReactionGroups) {
        const card = createReactionCard(group);
        card.style.marginTop = "12px";
        hiddenSection.appendChild(card);
      }
    }

    hiddenSectionHost.classList.add("visible");
    hiddenSectionHost.appendChild(hiddenSection);
  }

  if (!isMobile) {
    // Add spacer so sidebar's max scrollTop matches iframe's max scrollTop
    sidebarSpacer = document.createElement("div");
    sidebarSpacer.style.flexShrink = "0";
    sidebarContent.appendChild(sidebarSpacer);
    updateSidebarSpacer();

    // Restore scroll position to stay in sync with iframe
    iframeDriven = true;
    sidebarContent.scrollTop = iframeScrollTop;
    iframeDriven = false;
  }
}

function getHiddenSectionLabel(count: number, expanded: boolean, forcedOpen: boolean) {
  if (forcedOpen) {
    return count + " hidden on current view";
  }

  return count + " hidden on current view" + (expanded ? " -" : " +");
}

function setsEqual(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

function createAnnotationCard(
  item:
    | { kind: "comment"; id: string; comment: Comment }
    | { kind: "reaction"; id: string; group: ReactionGroup }
    | { kind: "compose"; id: string },
) {
  switch (item.kind) {
    case "comment":
      return createCommentCard(item.comment);
    case "reaction":
      return createReactionCard(item.group);
    case "compose":
      return createComposeForm();
  }
}

function updateSidebarSpacer() {
  if (!sidebarSpacer || iframeScrollHeight <= 0) return;
  // Collapse spacer, then measure actual content height using bounding rects
  sidebarSpacer.style.height = "0";
  const containerRect = sidebarContent.getBoundingClientRect();
  const spacerRect = sidebarSpacer.getBoundingClientRect();
  const contentHeight = spacerRect.top - containerRect.top + sidebarContent.scrollTop +
    (parseFloat(getComputedStyle(sidebarContent).paddingBottom) || 0);
  const needed = Math.max(0, iframeScrollHeight - contentHeight);
  sidebarSpacer.style.height = needed + "px";
}

function reactionAnchorKey(anchor: Anchor): string | null {
  const elementSelector = anchor?.selectors?.find((s) => s.type === "ElementSelector");
  if (elementSelector && "cssSelector" in elementSelector && "tagName" in elementSelector) {
    return `${elementSelector.tagName}:${elementSelector.cssSelector}`;
  }

  const tqs = anchor?.selectors?.find((s) => s.type === "TextQuoteSelector");
  if (!tqs) return null;
  // Hash prefix+exact to get a CSS-safe key that distinguishes same text at different positions
  let hash = 0;
  const str = (tqs.prefix || "") + "|" + tqs.exact;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return tqs.exact + "_" + (hash >>> 0).toString(36);
}

function getReactionGroupId(group: ReactionGroup): string {
  const key = reactionAnchorKey(group.anchor);
  return "reaction_" + (key || group.text);
}

function getAnchorLabel(anchor: Anchor): string | null {
  const textQuote = anchor.selectors?.find((selector) => selector.type === "TextQuoteSelector");
  if (textQuote && "exact" in textQuote) {
    return textQuote.exact;
  }

  const elementSelector = anchor.selectors?.find((selector) => selector.type === "ElementSelector");
  if (!elementSelector || !("tagName" in elementSelector)) {
    return null;
  }

  if (elementSelector.tagName === "img") {
    if ("alt" in elementSelector && elementSelector.alt) {
      return elementSelector.alt;
    }
    return "image";
  }

  return "chart";
}

function getReactionGroups(): ReactionGroup[] {
  const grouped = new Map<string, ReactionGroup>();
  for (const r of reactions) {
    const key = reactionAnchorKey(r.anchor);
    if (!key) continue;
    const label = getAnchorLabel(r.anchor) ?? "selection";

    if (!grouped.has(key)) grouped.set(key, { anchor: r.anchor, text: label, reactions: [] });
    grouped.get(key)!.reactions.push(r);
  }
  return Array.from(grouped.values());
}

function createReactionCard(group: ReactionGroup) {
  const card = document.createElement("div");
  const reactionId = getReactionGroupId(group);
  card.className =
    "reaction-card" +
    (activeCommentId === reactionId ? " active" : "") +
    (hiddenAnnotationIds.has(reactionId) ? " hidden-view" : "");
  card.dataset.commentId = reactionId;

  // Quoted text
  const quote = document.createElement("div");
  quote.className = "comment-quote";
  quote.textContent = group.text.length > 80 ? group.text.slice(0, 80) + "..." : group.text;
  quote.addEventListener("click", () => {
    sendToIframe({ type: "highlight:activate", commentId: reactionId });
    if (window.innerWidth <= 768) closeSidebar();
  });
  card.appendChild(quote);

  // Emoji row — each unique emoji with count and author list
  const emojiRow = document.createElement("div");
  emojiRow.className = "reaction-emoji-row";

  // Build per-emoji data: count, authors, and whether current user reacted
  const emojiData = new Map<
    string,
    { count: number; authors: string[]; myReactionId: string | null }
  >();
  for (const r of group.reactions) {
    if (!emojiData.has(r.emoji)) {
      emojiData.set(r.emoji, { count: 0, authors: [], myReactionId: null });
    }
    const d = emojiData.get(r.emoji)!;
    d.count++;
    d.authors.push(r.author_name);
    if (r.author_email === USER_EMAIL) {
      d.myReactionId = r.id;
    }
  }

  for (const [emoji, data] of emojiData) {
    const pill = document.createElement("button");
    pill.className = "reaction-pill" + (data.myReactionId ? " mine" : "");
    pill.title = data.authors.join(", ");

    const emojiSpan = document.createElement("span");
    emojiSpan.className = "reaction-pill-emoji";
    emojiSpan.textContent = emoji;
    pill.appendChild(emojiSpan);

    const countSpan = document.createElement("span");
    countSpan.className = "reaction-pill-count";
    countSpan.textContent = "" + data.count;
    pill.appendChild(countSpan);

    // Click pill to +1 (only if not already reacted)
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!data.myReactionId) {
        sendMessage({
          type: "reaction:add",
          id: generateId(),
          emoji,
          anchor: group.anchor,
        });
      }
    });

    // Delete button for own reactions
    if (data.myReactionId) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "reaction-pill-remove";
      removeBtn.textContent = "\u{00D7}";
      removeBtn.title = "remove your reaction";
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        sendMessage({ type: "reaction:remove", id: data.myReactionId });
      });
      pill.appendChild(removeBtn);
    }

    emojiRow.appendChild(pill);
  }

  card.appendChild(emojiRow);

  // Authors line
  const allAuthors = [...new Set(group.reactions.map((r) => r.author_name))];
  const authorsEl = document.createElement("div");
  authorsEl.className = "reaction-authors";
  authorsEl.textContent = allAuthors.join(", ");
  card.appendChild(authorsEl);

  return card;
}
function createCommentCard(comment: Comment) {
  const card = document.createElement("div");
  card.className =
    "comment-card" +
    (comment.resolved ? " resolved" : "") +
    (activeCommentId === comment.id ? " active" : "") +
    (hiddenAnnotationIds.has(comment.id) ? " hidden-view" : "") +
    (orphanedAnnotationIds.has(comment.id) ? " orphaned" : "");
  card.dataset.commentId = comment.id;

  const header = document.createElement("div");
  header.className = "comment-header";

  const author = document.createElement("div");
  author.className = "comment-author";
  const dot = document.createElement("div");
  dot.className = "comment-author-dot";
  dot.style.background = comment.author_color;
  const name = document.createElement("span");
  name.className = "comment-author-name";
  name.textContent = comment.author_name;
  author.appendChild(dot);
  author.appendChild(name);

  const time = document.createElement("span");
  time.className = "comment-time";
  time.textContent = relativeTime(comment.created_at);

  header.appendChild(author);
  header.appendChild(time);
  card.appendChild(header);

  // Quoted text
  if (comment.anchor) {
    const anchorLabel = getAnchorLabel(comment.anchor);
    if (anchorLabel) {
      const quote = document.createElement("div");
      quote.className = "comment-quote";
      quote.textContent = anchorLabel.length > 80 ? anchorLabel.slice(0, 80) + "..." : anchorLabel;
      quote.addEventListener("click", () => {
        sendToIframe({ type: "highlight:activate", commentId: comment.id });
        if (window.innerWidth <= 768) closeSidebar();
      });
      card.appendChild(quote);
    }
  }

  // Body
  const body = document.createElement("div");
  body.className = "comment-body";
  body.textContent = comment.content;
  card.appendChild(body);

  // Replies
  const replies = comments.filter((c) => c.parent_id === comment.id);
  if (replies.length > 0) {
    const repliesDiv = document.createElement("div");
    repliesDiv.className = "comment-replies";
    for (const reply of replies) {
      repliesDiv.appendChild(createReplyCard(reply));
    }
    card.appendChild(repliesDiv);
  }

  // Actions
  const actions = document.createElement("div");
  actions.className = "comment-actions";

  const leftActions = document.createElement("div");
  const replyBtn = document.createElement("button");
  replyBtn.className = "comment-action";
  replyBtn.textContent = "reply";
  replyBtn.addEventListener("click", () => showReplyForm(card, comment.id));
  leftActions.appendChild(replyBtn);

  const rightActions = document.createElement("div");
  const resolveBtn = document.createElement("button");
  resolveBtn.className = "comment-action";
  resolveBtn.textContent = comment.resolved ? "unresolve" : "resolve";
  resolveBtn.addEventListener("click", () => {
    sendMessage({ type: "comment:resolve", id: comment.id, resolved: !comment.resolved });
  });
  rightActions.appendChild(resolveBtn);

  if (comment.author_email === USER_EMAIL) {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "comment-action";
    deleteBtn.textContent = "delete";
    deleteBtn.style.marginLeft = "8px";
    deleteBtn.addEventListener("click", () => {
      sendMessage({ type: "comment:delete", id: comment.id });
    });
    rightActions.appendChild(deleteBtn);
  }

  actions.appendChild(leftActions);
  actions.appendChild(rightActions);
  card.appendChild(actions);

  // Click card to highlight in doc
  card.addEventListener("click", (e) => {
    const target = e.target;
    if (target instanceof Element && (target.closest(".comment-action") || target.closest(".reply-compose"))) {
      return;
    }
    activeCommentId = comment.id;
    sendToIframe({ type: "highlight:activate", commentId: comment.id });
    if (window.innerWidth <= 768) {
      closeSidebar();
    } else {
      renderComments();
    }
  });

  return card;
}

function createReplyCard(reply: Comment) {
  const card = document.createElement("div");
  card.className = "reply-card";

  const header = document.createElement("div");
  header.className = "reply-header";

  const author = document.createElement("div");
  author.className = "reply-author";
  const dot = document.createElement("div");
  dot.className = "comment-author-dot";
  dot.style.background = reply.author_color;
  const name = document.createElement("span");
  name.textContent = reply.author_name;
  author.appendChild(dot);
  author.appendChild(name);

  const time = document.createElement("span");
  time.className = "comment-time";
  time.textContent = relativeTime(reply.created_at);

  header.appendChild(author);
  header.appendChild(time);
  card.appendChild(header);

  const body = document.createElement("div");
  body.className = "reply-body";
  body.textContent = reply.content;
  card.appendChild(body);

  return card;
}

function showReplyForm(cardEl: HTMLElement, parentId: string) {
  // Remove any existing reply form
  document.querySelectorAll(".reply-compose").forEach((el) => el.remove());

  const form = document.createElement("div");
  form.className = "reply-compose";

  const textarea = document.createElement("textarea");
  textarea.className = "reply-textarea";
  textarea.placeholder = "write a reply...";
  form.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "reply-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-cancel";
  cancelBtn.textContent = "cancel";
  cancelBtn.addEventListener("click", () => form.remove());

  const submitBtn = document.createElement("button");
  submitBtn.className = "btn-submit";
  submitBtn.textContent = "reply";
  submitBtn.addEventListener("click", () => {
    const content = textarea.value.trim();
    if (!content) return;
    sendMessage({
      type: "comment:create",
      id: generateId(),
      content,
      anchor: null,
      parent_id: parentId,
    });
    form.remove();
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  cardEl.appendChild(form);
  textarea.focus();

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      submitBtn.click();
    }
    if (e.key === "Escape") {
      form.remove();
    }
  });
}

function createComposeForm() {
  const form = document.createElement("div");
  form.className = "compose-form";

  if (composeText) {
    const quote = document.createElement("div");
    quote.className = "compose-quote";
    quote.textContent = composeText.length > 100 ? composeText.slice(0, 100) + "..." : composeText;
    form.appendChild(quote);
  }

  const textarea = document.createElement("textarea");
  textarea.className = "compose-textarea";
  textarea.placeholder = "add a comment...";
  form.appendChild(textarea);

  const actions = document.createElement("div");
  actions.className = "compose-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-cancel";
  cancelBtn.textContent = "cancel";
  cancelBtn.addEventListener("click", () => {
    composeAnchor = null;
    composeText = "";
    composePixelY = 0;
    renderComments();
    updateHighlights();
  });

  const submitBtn = document.createElement("button");
  submitBtn.className = "btn-submit";
  submitBtn.textContent = "comment";
  submitBtn.disabled = true;
  submitBtn.addEventListener("click", () => {
    const content = textarea.value.trim();
    if (!content) return;
    sendMessage({
      type: "comment:create",
      id: generateId(),
      content,
      anchor: composeAnchor,
      parent_id: null,
    });
    composeAnchor = null;
    composeText = "";
    composePixelY = 0;
    clearPendingSelection();
    renderComments();
  });

  textarea.addEventListener("input", () => {
    submitBtn.disabled = !textarea.value.trim();
  });

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      submitBtn.click();
    }
    if (e.key === "Escape") {
      cancelBtn.click();
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  // Auto-focus after render
  requestAnimationFrame(() => textarea.focus());

  return form;
}

function openSidebar(): boolean {
  const wasCollapsed = sidebar.classList.contains("collapsed");
  // Capture scroll position before anything changes
  const savedScrollTop = iframeScrollTop;
  sidebar.classList.remove("collapsed");
  localStorage.setItem(sidebarKey, "open");
  sidebarBackdrop.classList.add("visible");
  sendToIframe({ type: "sidebar:state", open: window.innerWidth > 768 });
  if (wasCollapsed) {
    // Suppress scroll sync during transition — iframe scroll resets as it resizes
    suppressScrollSync = true;
    sidebar.addEventListener("transitionend", () => {
      suppressScrollSync = false;
      // Restore iframe scroll to where it was before sidebar opened
      sendToIframe({ type: "scroll:to", scrollTop: savedScrollTop });
      iframeScrollTop = savedScrollTop;
      sendToIframe({ type: "highlights:request" });
      requestSelectionRefresh();
    }, { once: true });
  } else {
    requestSelectionRefresh();
  }
  return wasCollapsed;
}

function openCompose(text: string, anchor: Anchor, pixelY = 0) {
  composeText = text;
  composeAnchor = anchor;
  composePixelY = pixelY;
  clearPendingSelection();
  updateHighlights();
  sendToIframe({ type: "highlight:activate", commentId: "__compose__" });
  const wasCollapsed = openSidebar();
  // If transitioning from collapsed, transitionend will trigger re-render with correct layout
  if (!wasCollapsed) renderComments();
}

function scrollToComment(commentId: string) {
  activeCommentId = commentId;
  const wasCollapsed = openSidebar();
  if (!wasCollapsed) renderComments();
  // Scroll the iframe to the highlight — sidebar will follow via scroll sync
  sendToIframe({ type: "highlight:activate", commentId });
}

function updateHighlights() {
  const topLevel = comments.filter((c) => !c.parent_id);
  const commentItems: AnnotationHighlightItem[] = topLevel
    .filter((comment): comment is Comment & { anchor: Anchor } => comment.anchor !== null)
    .map((comment) => ({ id: comment.id, anchor: comment.anchor, resolved: comment.resolved }));
  const reactionItems = buildReactionHighlightItems();
  const items: AnnotationHighlightItem[] = [...commentItems, ...reactionItems];
  if (composeAnchor) {
    items.push({ id: "__compose__", anchor: composeAnchor, resolved: false });
  }
  sendToIframe({
    type: "highlights:render",
    comments: items,
  });
  setTimeout(() => {
    sendToIframe({
      type: "highlights:check",
      comments: [...commentItems, ...reactionItems],
    });
  }, 100);
}

function buildReactionHighlightItems(): AnnotationHighlightItem[] {
  const grouped = new Map<string, AnnotationHighlightItem>();
  for (const r of reactions) {
    const key = reactionAnchorKey(r.anchor);
    if (!key) continue;
    if (!grouped.has(key)) {
      grouped.set(key, { id: "reaction_" + key, anchor: r.anchor, resolved: false });
    }
  }
  return Array.from(grouped.values());
}

function updateReactions() {
  renderComments();
  updateHighlights();
}

// Utilities
function generateId() {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (let i = 0; i < 12; i++) id += chars[bytes[i] % chars.length];
  return id;
}

function relativeTime(dateStr: string) {
  const date = parseTimestamp(dateStr);
  const now = new Date();
  const diff = (now.getTime() - date.getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  if (diff < 604800) return Math.floor(diff / 86400) + "d";
  return date.toLocaleDateString();
}

function parseTimestamp(dateStr: string) {
  if (dateStr.includes("T")) {
    return new Date(dateStr);
  }

  return new Date(dateStr + "Z");
}

// Start
init();
