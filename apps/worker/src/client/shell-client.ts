import "./styles.css";

import type { Anchor, Comment, Reaction, UserPresence } from "@sharehtml/shared";

type AuthMode = "access" | "none";

const config = (window as unknown as {
  __COMMENT_CONFIG__: {
    docId: string;
    email: string;
    authMode: AuthMode;
    isShared: boolean;
    canManageSharing: boolean;
  };
})
  .__COMMENT_CONFIG__;
const DOC_ID = config.docId;
const USER_EMAIL = config.email;
const AUTH_MODE = config.authMode;
const CAN_MANAGE_SHARING = config.canManageSharing;

// State
let ws: WebSocket | null = null;
let userName = localStorage.getItem("comment_name_" + USER_EMAIL) || "";
let userColor = "";
const users = new Map<string, UserPresence>();
let comments: Comment[] = [];
let showResolved = false;
let activeCommentId: string | null = null;
let orphanedIds = new Set<string>();
const sidebarKey = "comment_sidebar_" + DOC_ID;
let reactions: Reaction[] = [];
let composeAnchor: Anchor | null = null;
let composeText = "";
let composePixelY = 0;
let highlightPixelPositions: Record<string, number> = {};
let iframeScrollHeight = 0;
let iframeScrollTop = 0;
let iframeDriven = false;
let suppressScrollSync = false;
let sidebarSpacer: HTMLElement | null = null;
let isShared = AUTH_MODE === "access" ? config.isShared : true;
let shareMessageOverride: string | null = null;
let isSavingShareState = false;

// Elements
const iframe = document.getElementById("doc-iframe") as HTMLIFrameElement;
const sidebar = document.getElementById("sidebar")!;
const sidebarContent = document.getElementById("sidebar-content")!;
const sidebarToggle = document.getElementById("sidebar-toggle")!;
const presenceDots = document.getElementById("presence-dots")!;
const commentCount = document.getElementById("comment-count")!;
const filterResolved = document.getElementById("filter-resolved")!;
const nameModal = document.getElementById("name-modal")!;
const modalEmail = document.getElementById("modal-email")!;
const nameInput = document.getElementById("name-input") as HTMLInputElement;
const nameSubmit = document.getElementById("name-submit") as HTMLButtonElement;
const shareBtn = document.getElementById("share-btn")!;
const shareModal = document.getElementById("share-modal")!;
const shareLinkInput = document.getElementById("share-link-input") as HTMLInputElement;
const shareCopyBtn = document.getElementById("share-copy-btn")!;
const shareStatusText = document.getElementById("share-status-text")!;
const shareToggle = document.getElementById("share-toggle") as HTMLInputElement;
const shareNote = document.getElementById("share-note")!;
const sidebarBackdrop = document.getElementById("sidebar-backdrop")!;
const SANDBOXED_IFRAME_ORIGIN = "null";

function sendToIframe(message: Record<string, unknown>) {
  iframe.contentWindow?.postMessage(message, "*");
}

function isTrustedIframeMessage(event: MessageEvent) {
  return event.source === iframe.contentWindow && event.origin === SANDBOXED_IFRAME_ORIGIN;
}

function closeSidebar() {
  sidebar.classList.add("collapsed");
  localStorage.setItem(sidebarKey, "collapsed");
  sidebarBackdrop.classList.remove("visible");
  sendToIframe({ type: "sidebar:state", open: false });
}

function getShareStatusText(): string {
  if (AUTH_MODE !== "access") {
    return "anyone with the link can view and comment";
  }

  if (isShared) {
    return "anyone with the link who is allowed by Cloudflare Access can view and comment";
  }

  return "only you can open this document";
}

function getShareNoteText(): string {
  if (shareMessageOverride) {
    return shareMessageOverride;
  }

  if (AUTH_MODE !== "access") {
    return "Cloudflare Access is required to turn link sharing off.";
  }

  if (!CAN_MANAGE_SHARING) {
    return "Only the document owner can change sharing.";
  }

  if (isShared) {
    return "Turn sharing off to make this document private again.";
  }

  return "Turn sharing on to let anyone with the link open it.";
}

function renderShareModal() {
  shareLinkInput.value = location.href;
  shareStatusText.textContent = getShareStatusText();
  shareNote.textContent = getShareNoteText();
  shareCopyBtn.textContent = "copy";
  shareToggle.checked = AUTH_MODE !== "access" || isShared;
  shareToggle.disabled = isSavingShareState || !CAN_MANAGE_SHARING;
  shareCopyBtn.disabled = isSavingShareState;
}

async function updateSharing(nextShared: boolean): Promise<boolean> {
  if (!CAN_MANAGE_SHARING || AUTH_MODE !== "access" || nextShared === isShared) {
    renderShareModal();
    return true;
  }

  isSavingShareState = true;
  shareMessageOverride = "saving...";
  renderShareModal();

  try {
    const response = await fetch(`/api/documents/${DOC_ID}/share`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isShared: nextShared }),
    });

    if (!response.ok) {
      shareMessageOverride = "could not update sharing. try again.";
      isSavingShareState = false;
      renderShareModal();
      return false;
    }

    const result = await response.json() as { isShared: boolean };
    isShared = result.isShared;
    shareMessageOverride = null;
    isSavingShareState = false;
    renderShareModal();
    return true;
  } catch {
    shareMessageOverride = "could not update sharing. try again.";
    isSavingShareState = false;
    renderShareModal();
    return false;
  }
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
    sidebar.classList.toggle("collapsed");
    const isOpen = !sidebar.classList.contains("collapsed");
    localStorage.setItem(sidebarKey, isOpen ? "open" : "collapsed");
    sidebarBackdrop.classList.toggle("visible", isOpen);
    // On mobile, sidebar is overlay — don't hide iframe scrollbar
    const hideScroll = isOpen && window.innerWidth > 768;
    sendToIframe({ type: "sidebar:state", open: hideScroll });
  });

  sidebarBackdrop.addEventListener("click", closeSidebar);

  // Share button
  shareBtn.addEventListener("click", () => {
    shareMessageOverride = null;
    renderShareModal();
    shareModal.style.display = "flex";
    shareLinkInput.select();
  });
  shareCopyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareLinkInput.value).then(() => {
      shareCopyBtn.textContent = "copied!";
      setTimeout(() => {
        shareCopyBtn.textContent = "copy";
      }, 1500);
    });
  });
  shareToggle.addEventListener("change", async () => {
    const saved = await updateSharing(shareToggle.checked);
    if (!saved) {
      shareToggle.checked = isShared;
    }
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
}

// WebSocket
let reconnectAttempts = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastPong = 0;

function connectWs() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(protocol + "//" + location.host + "/d/" + DOC_ID + "/ws");

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
    const msg = JSON.parse(e.data as string);
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

function handleServerMessage(msg: Record<string, unknown>) {
  switch (msg.type) {
    case "users:list":
      users.clear();
      for (const u of msg.users as UserPresence[]) {
        users.set(u.email, u);
        if (u.email === USER_EMAIL) userColor = u.color;
      }
      renderPresence();
      break;

    case "user:joined":
      users.set((msg.user as UserPresence).email, msg.user as UserPresence);
      renderPresence();
      break;

    case "user:left":
      users.delete(msg.email as string);
      renderPresence();
      sendToIframe({ type: "selection:remote:clear", email: msg.email });
      break;

    case "user:name_set": {
      const u = users.get(msg.email as string);
      if (u) {
        u.name = msg.name as string;
        users.set(msg.email as string, u);
      }
      renderPresence();
      renderComments();
      break;
    }

    case "presence:updated":
      if (msg.selection) {
        const u = users.get(msg.email as string);
        sendToIframe({
          type: "selection:remote",
          email: msg.email,
          color: u?.color || "#000",
          anchor: (msg.selection as { anchor: Anchor }).anchor,
        });
      } else {
        sendToIframe({
          type: "selection:remote:clear",
          email: msg.email,
        });
      }
      break;

    case "comments:list":
      comments = msg.comments as Comment[];
      renderComments();
      updateHighlights();
      break;

    case "comment:created":
      comments.push(msg.comment as Comment);
      renderComments();
      updateHighlights();
      break;

    case "comment:updated": {
      const idx = comments.findIndex((c) => c.id === (msg.comment as Comment).id);
      if (idx >= 0) comments[idx] = msg.comment as Comment;
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
      if (c) c.resolved = msg.resolved as boolean;
      renderComments();
      updateHighlights();
      break;
    }

    case "reactions:list":
      reactions = msg.reactions as Reaction[];
      updateReactions();
      break;

    case "reaction:added":
      reactions.push(msg.reaction as Reaction);
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

// Handle messages from iframe
function handleIframeMessage(e: MessageEvent) {
  if (!isTrustedIframeMessage(e)) return;
  const msg = e.data;

  switch (msg.type) {
    case "selection:made":
      sendMessage({
        type: "presence:update",
        selection: { anchor: msg.anchor, text: msg.text },
      });
      break;

    case "selection:clear":
      sendMessage({
        type: "presence:update",
        selection: undefined,
      });
      break;

    case "comment:start":
      if (msg.content) {
        // Mobile: comment submitted inline, create directly
        sendMessage({
          type: "comment:create",
          id: generateId(),
          content: msg.content,
          anchor: msg.anchor,
          parent_id: null,
        });
      } else {
        openCompose(msg.text, msg.anchor, msg.pixelY || 0);
      }
      break;

    case "highlight:click":
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

    case "highlights:orphaned":
      orphanedIds = new Set(msg.ids);
      renderComments();
      break;

    case "highlights:positions":
      highlightPixelPositions = msg.pixelPositions || {};
      if (msg.scrollHeight) iframeScrollHeight = msg.scrollHeight;
      renderComments();
      break;

    case "iframe:scroll":
      iframeScrollHeight = msg.scrollHeight;
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

    case "reaction:add":
      sendMessage({
        type: "reaction:add",
        id: generateId(),
        emoji: msg.emoji,
        anchor: msg.anchor,
      });
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
  const resolvedCount = topLevel.filter((c) => c.resolved).length;
  const reactionGroups = getReactionGroups();
  const totalItems = topLevel.length + reactionGroups.length;

  commentCount.textContent = totalItems + " annotation" + (totalItems !== 1 ? "s" : "");
  const toggleText = sidebarToggle.querySelector(".sidebar-toggle-text");
  if (toggleText) toggleText.textContent = totalItems > 0 ? "comments \u{00B7} " + totalItems : "comments";
  filterResolved.textContent = showResolved ? "hide resolved" : "resolved (" + resolvedCount + ")";
  (filterResolved as HTMLElement).style.display = resolvedCount > 0 ? "" : "none";

  if (filtered.length === 0 && reactionGroups.length === 0 && !composeAnchor) {
    sidebarContent.innerHTML =
      '<div class="sidebar-empty">select text in the document to add a comment or reaction</div>';
    return;
  }

  sidebarContent.innerHTML = "";

  // Build unified list of annotations sorted by document position
  type Annotation =
    | { kind: "comment"; id: string; comment: Comment }
    | { kind: "reaction"; id: string; group: ReactionGroup }
    | { kind: "compose"; id: string };

  const annotations: Annotation[] = [];
  for (const comment of filtered) {
    annotations.push({ kind: "comment", id: comment.id, comment });
  }
  for (const group of reactionGroups) {
    const key = reactionAnchorKey(group.anchor);
    annotations.push({ kind: "reaction", id: "reaction_" + (key || group.text), group });
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
    const card =
      item.kind === "comment"
        ? createCommentCard(item.comment)
        : item.kind === "reaction"
          ? createReactionCard((item as { group: ReactionGroup }).group)
          : createComposeForm();

    // Position card to align with its anchor in the document (desktop only)
    if (hasPixelPositions && item.id in allPixelPositions) {
      const targetY = allPixelPositions[item.id];
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

function getReactionGroups(): ReactionGroup[] {
  const grouped = new Map<string, ReactionGroup>();
  for (const r of reactions) {
    const key = reactionAnchorKey(r.anchor);
    if (!key) continue;
    const tqs = r.anchor.selectors!.find((s) => s.type === "TextQuoteSelector")!;
    if (!grouped.has(key)) grouped.set(key, { anchor: r.anchor, text: tqs.exact, reactions: [] });
    grouped.get(key)!.reactions.push(r);
  }
  return Array.from(grouped.values());
}

function createReactionCard(group: ReactionGroup) {
  const card = document.createElement("div");
  const key = reactionAnchorKey(group.anchor);
  const reactionId = "reaction_" + (key || group.text);
  card.className = "reaction-card" + (activeCommentId === reactionId ? " active" : "");
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
    (orphanedIds.has(comment.id) ? " orphaned" : "");
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
    const tqs = comment.anchor.selectors?.find((s) => s.type === "TextQuoteSelector");
    if (tqs) {
      const quote = document.createElement("div");
      quote.className = "comment-quote";
      quote.textContent = tqs.exact.length > 80 ? tqs.exact.slice(0, 80) + "..." : tqs.exact;
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
    if (
      (e.target as Element).closest(".comment-action") ||
      (e.target as Element).closest(".reply-compose")
    )
      return;
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
    }, { once: true });
  }
  return wasCollapsed;
}

function openCompose(text: string, anchor: Anchor, pixelY = 0) {
  composeText = text;
  composeAnchor = anchor;
  composePixelY = pixelY;
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
  // Build highlight items from both comments and reactions
  const reactionItems = buildReactionHighlightItems();
  // Include compose anchor as a pending highlight
  const items = [...topLevel, ...reactionItems];
  if (composeAnchor) {
    items.push({ id: "__compose__", anchor: composeAnchor, resolved: false } as any);
  }
  sendToIframe({
    type: "highlights:render",
    comments: items,
  });
  // Check for orphaned comments after a short delay to let highlights render
  setTimeout(() => {
    sendToIframe({
      type: "highlights:check",
      comments: topLevel,
    });
  }, 100);
}

function buildReactionHighlightItems() {
  const grouped = new Map<string, { id: string; anchor: Anchor; resolved: boolean }>();
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
  const date = new Date(dateStr + "Z");
  const now = new Date();
  const diff = (now.getTime() - date.getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return Math.floor(diff / 60) + "m";
  if (diff < 86400) return Math.floor(diff / 3600) + "h";
  if (diff < 604800) return Math.floor(diff / 86400) + "d";
  return date.toLocaleDateString();
}

// Start
init();
