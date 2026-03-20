/** @jsxImportSource hono/jsx */
import { raw } from "hono/utils/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { AssetUrls } from "../utils/assets.js";

interface ShellParams {
  docId: string;
  title: string;
  ownerEmail: string;
  email: string;
  authMode: "access" | "none";
  isShared: boolean;
  canManageSharing: boolean;
  assets: AssetUrls;
}

function getShareStatusText(authMode: "access" | "none", isShared: boolean): string {
  if (authMode !== "access") {
    return "anyone with the link can view and comment";
  }

  if (isShared) {
    return "anyone with the link who is allowed by Cloudflare Access can view and comment";
  }

  return "only you can open this document";
}

function getShareNoteText(
  authMode: "access" | "none",
  isShared: boolean,
  canManageSharing: boolean,
): string {
  if (authMode !== "access") {
    return "Cloudflare Access is required to turn link sharing off.";
  }

  if (!canManageSharing) {
    return "Only the document owner can change sharing.";
  }

  if (isShared) {
    return "Turn sharing off to make this document private again.";
  }

  return "Turn sharing on to let anyone with the link open it.";
}

export function ShellView(
  { docId, title, ownerEmail, email, authMode, isShared, canManageSharing, assets }: ShellParams,
): HtmlEscapedString {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title} — sharehtml</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        {assets.shellClientCss && <link rel="stylesheet" href={assets.shellClientCss} />}
        <script>
          {raw(
            `if(localStorage.getItem('comment_sidebar_${docId}')==='collapsed'){document.documentElement.classList.add('sidebar-start-collapsed')}`,
          )}
        </script>
        <style>
          {raw(`.sidebar-start-collapsed .sidebar{width:0;border-left:none;overflow:hidden}`)}
        </style>
      </head>
      <body>
        <div class="topbar">
          <a class="topbar-home" href="/">
            sharehtml
          </a>
          <div class="topbar-title-wrapper">
            <div class="topbar-title">{title}</div>
            <div class="topbar-title-tooltip">
              <div class="topbar-title-tooltip-label">created by</div>
              <div class="topbar-title-tooltip-email">{ownerEmail}</div>
            </div>
          </div>
          <div class="topbar-right">
            <div class="presence-dots" id="presence-dots"></div>
            <button class="share-btn" id="share-btn" title="Share link">
              {raw(
                `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`,
              )}
            </button>
            <button class="sidebar-toggle" id="sidebar-toggle">
              <span class="sidebar-toggle-text">comments</span>
              {raw(
                `<svg class="sidebar-toggle-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
              )}
            </button>
          </div>
        </div>

        <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
        <div class="main">
          <div class="iframe-container">
            <iframe
              id="doc-iframe"
              src={`/d/${docId}/content`}
              sandbox="allow-scripts allow-popups"
              allow="fullscreen"
              allowFullScreen
            ></iframe>
          </div>
          <div class="sidebar" id="sidebar">
            <div class="sidebar-header">
              <span id="comment-count">0 comments</span>
              <button class="filter-toggle" id="filter-resolved" title="Show resolved">
                resolved
              </button>
            </div>
            <div class="sidebar-content" id="sidebar-content">
              <div class="sidebar-empty">select text in the document to add a comment</div>
            </div>
          </div>
        </div>

        <div class="modal-backdrop" id="name-modal" style="display:none">
          <div class="modal-content">
            <div class="modal-title">what should we call you?</div>
            <div class="modal-email" id="modal-email"></div>
            <input
              class="modal-input"
              id="name-input"
              type="text"
              placeholder="your name"
              autocomplete="off"
            />
            <br />
            <button class="modal-submit" id="name-submit" disabled>
              continue
            </button>
          </div>
        </div>

        <div class="modal-backdrop" id="share-modal" style="display:none">
          <div class="modal-content">
            <div class="modal-title">share this document</div>
            <div class="modal-email" id="share-status-text" style="margin-bottom:16px">
              {getShareStatusText(authMode, isShared)}
            </div>
            <div class="share-link-row">
              <input class="share-link-input" id="share-link-input" type="text" readonly />
              <button class="modal-submit share-copy-btn" id="share-copy-btn">
                copy
              </button>
            </div>
            <div class="share-toggle-row">
              <div class="share-toggle-copy">
                <div class="share-toggle-label">share by link</div>
                <div class="share-toggle-note" id="share-note">
                  {getShareNoteText(authMode, isShared, canManageSharing)}
                </div>
              </div>
              <label class="share-switch">
                <input
                  id="share-toggle"
                  type="checkbox"
                  checked={authMode !== "access" || isShared}
                  disabled={!canManageSharing}
                />
                <span class="share-switch-ui"></span>
              </label>
            </div>
          </div>
        </div>

        <script>
          {raw(
            `window.__COMMENT_CONFIG__ = ${JSON.stringify({ docId, email, authMode, isShared, canManageSharing })}`,
          )}
        </script>
        <script type="module" src={assets.shellClientJs}></script>
      </body>
    </html>
  ) as unknown as HtmlEscapedString;
}
