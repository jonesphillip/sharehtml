/** @jsxImportSource hono/jsx */
import { raw } from "hono/utils/html";
import type { AssetUrls } from "../utils/assets.js";
import type { DocumentRow, RecentViewRow } from "../types.js";
import { toHtml, escapeScriptContent } from "./jsx.js";

interface HomeParams {
  assets: AssetUrls;
  email: string;
  workerUrl: string;
  documents: DocumentRow[];
  recentViews: RecentViewRow[];
  query: string;
  page: number;
  pageSize: number;
  totalCount: number;
  requiresLogin: boolean;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr + "Z").getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatSize(bytes: number): string {
  return (bytes / 1024).toFixed(1) + "KB";
}

function DocCard({ doc, subtitle }: { doc: DocumentRow; subtitle: string }) {
  return (
    <a class="doc-card" href={`/d/${doc.id}`}>
      <div class="doc-card-top">
        <span class="doc-card-title">{doc.title}</span>
        <span class="doc-card-filename">{doc.filename}</span>
      </div>
      <div class="doc-card-bottom">
        <span class="doc-card-meta">{subtitle}</span>
        <span class="doc-card-meta">{relativeTime(doc.created_at)}</span>
      </div>
    </a>
  );
}

function RecentDocCard({ doc }: { doc: RecentViewRow }) {
  const viewedAt = doc.last_viewed_at || doc.created_at;

  return (
    <a class="recent-card" href={`/d/${doc.id}`}>
      <div class="recent-card-title">{doc.title}</div>
      <div class="recent-card-filename">{doc.filename}</div>
      <div class="recent-card-meta">viewed {relativeTime(viewedAt)}</div>
    </a>
  );
}

function buildHomePath(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query) {
    params.set("q", query);
  }
  if (page > 1) {
    params.set("page", String(page));
  }

  const search = params.toString();
  return search ? `/?${search}` : "/";
}

function getHomeSearchScript(pageSize: number, workerUrl: string, page: number): string {
  return `
    (() => {
      const form = document.querySelector(".docs-search-form");
      const input = document.querySelector(".docs-search-input");
      const list = document.getElementById("documents-list");
      const pagination = document.getElementById("documents-pagination");
      const meta = document.getElementById("documents-meta");
      const setupTemplate = document.getElementById("documents-setup-template");
      if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) return;
      if (!(list instanceof HTMLDivElement) || !(pagination instanceof HTMLDivElement)) return;
      if (!(meta instanceof HTMLDivElement) || !(setupTemplate instanceof HTMLTemplateElement)) return;

      let timer = 0;
      let requestId = 0;
      let currentQuery = input.value.trim();
      let currentPage = ${page};
      const pageSize = ${pageSize};

      function escapeHtml(value) {
        return value
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function relativeTime(dateStr) {
        const now = Date.now();
        const then = new Date(dateStr + "Z").getTime();
        const diff = now - then;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return "now";
        if (mins < 60) return mins + "m";
        const hours = Math.floor(mins / 60);
        if (hours < 24) return hours + "h";
        const days = Math.floor(hours / 24);
        if (days < 30) return days + "d";
        return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
      }

      function formatSize(bytes) {
        return (bytes / 1024).toFixed(1) + "KB";
      }

      function buildPath(query, page) {
        const params = new URLSearchParams();
        if (query) params.set("q", query);
        if (page > 1) params.set("page", String(page));
        const search = params.toString();
        return search ? "/?" + search : "/";
      }

      function renderDocuments(documents, query) {
        if (documents.length > 0) {
          list.innerHTML = documents.map((doc) => \`
            <a class="doc-card" href="/d/\${escapeHtml(doc.id)}">
              <div class="doc-card-top">
                <span class="doc-card-title">\${escapeHtml(doc.title)}</span>
                <span class="doc-card-filename">\${escapeHtml(doc.filename)}</span>
              </div>
              <div class="doc-card-bottom">
                <span class="doc-card-meta">\${formatSize(doc.size)}</span>
                <span class="doc-card-meta">\${relativeTime(doc.created_at)}</span>
              </div>
            </a>
          \`).join("");
          return;
        }

        if (query) {
          list.innerHTML = \`<div class="section-empty">no documents match "\${escapeHtml(query)}"</div>\`;
          return;
        }

        list.innerHTML = setupTemplate.innerHTML;
      }

      function renderPagination(totalCount, page, query) {
        const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
        if (totalCount === 0 || totalPages <= 1) {
          pagination.innerHTML = "";
          return;
        }

        const previous = page > 1
          ? \`<a class="docs-pagination-link" href="\${buildPath(query, page - 1)}" data-page="\${page - 1}">previous</a>\`
          : '<div class="docs-pagination-spacer"></div>';
        const next = page < totalPages
          ? \`<a class="docs-pagination-link" href="\${buildPath(query, page + 1)}" data-page="\${page + 1}">next</a>\`
          : '<div class="docs-pagination-spacer"></div>';

        pagination.innerHTML = \`
          \${previous}
          <div class="docs-pagination-status">page \${page} of \${totalPages}</div>
          \${next}
        \`;
      }

      function renderMeta(totalCount, query) {
        const label = query
          ? totalCount + " match" + (totalCount === 1 ? "" : "es")
          : totalCount + " document" + (totalCount === 1 ? "" : "s");
        meta.textContent = label;
      }

      function updateUrl(query, page) {
        window.history.replaceState({}, "", buildPath(query, page));
      }

      async function loadDocuments(query, page) {
        const nextRequestId = ++requestId;
        const searchParams = new URLSearchParams();
        if (query) searchParams.set("q", query);
        searchParams.set("page", String(page));
        searchParams.set("limit", String(pageSize));

        const response = await fetch("${workerUrl}/api/documents?" + searchParams.toString(), {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;

        const data = await response.json();
        if (nextRequestId !== requestId) return;

        currentQuery = data.query || "";
        currentPage = data.page || 1;
        renderDocuments(data.documents || [], currentQuery);
        renderPagination(data.totalCount || 0, currentPage, currentQuery);
        renderMeta(data.totalCount || 0, currentQuery);
        updateUrl(currentQuery, currentPage);
      }

      function submitSearch() {
        const nextValue = input.value.trim();
        if (nextValue === currentQuery) return;
        loadDocuments(nextValue, 1);
      }

      input.addEventListener("input", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(submitSearch, 120);
      });

      input.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        window.clearTimeout(timer);
        submitSearch();
      });

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        window.clearTimeout(timer);
        submitSearch();
      });

      pagination.addEventListener("click", (event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        const link = target.closest("[data-page]");
        if (!(link instanceof HTMLAnchorElement)) return;
        const page = Number.parseInt(link.dataset.page || "", 10);
        if (!Number.isFinite(page) || page < 1) return;
        event.preventDefault();
        loadDocuments(currentQuery, page);
      });
    })();
  `;
}

function SetupBlock({ workerUrl, requiresLogin }: { workerUrl: string; requiresLogin: boolean }) {
  return (
    <div class="setup-block">
      <p>
        Deploy HTML, Markdown, or code files with the{" "}
        <a href="https://github.com/jonesphillip/sharehtml">sharehtml CLI</a>.{" "}
        Requires <a href="https://bun.sh">Bun</a>.
      </p>
      {raw(`<pre><span class="cmd-comment"># install the CLI</span>
bun install -g sharehtml

<span class="cmd-comment"># configure</span>
sharehtml config set-url ${workerUrl}
${requiresLogin ? "sharehtml login\n" : ""}
<span class="cmd-comment"># deploy a file</span>
sharehtml deploy example/coffee-report.html</pre>`)}
    </div>
  );
}

export function HomeView({
  assets,
  email,
  workerUrl,
  documents,
  recentViews,
  query,
  page,
  pageSize,
  totalCount,
  requiresLogin,
}: HomeParams) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const hasDocuments = totalCount > 0;
  const hasQuery = query.length > 0;
  const previousPageHref = buildHomePath(query, page - 1);
  const nextPageHref = buildHomePath(query, page + 1);
  const resultsLabel = hasQuery
    ? `${totalCount} match${totalCount === 1 ? "" : "es"}`
    : `${totalCount} document${totalCount === 1 ? "" : "s"}`;

  const jsx = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>sharehtml</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        {assets.homeCss && <link rel="stylesheet" href={assets.homeCss} />}
        {assets.homeClientJs && <script type="module" src={assets.homeClientJs}></script>}
      </head>
      <body>
        <div class="topbar">
          <a class="topbar-home" href="/">
            sharehtml
          </a>
          <div class="topbar-right">
            <span class="topbar-email">{email}</span>
          </div>
        </div>
        <div class="content">
          <div class="section">
            <div class="section-label">recently viewed</div>
            <div class="recent-grid">
              {recentViews.length > 0 ? (
                recentViews.map((d) => <RecentDocCard doc={d} />)
              ) : (
                <div class="section-empty">no recently viewed documents</div>
              )}
            </div>
          </div>
          <div class="section">
            <div class="section-header">
              <div class="section-label">my documents</div>
              <div class="section-meta" id="documents-meta">{resultsLabel}</div>
            </div>
            <form class="docs-search-form" method="get" action="/">
              <input
                class="docs-search-input"
                type="text"
                name="q"
                value={query}
                placeholder="search by title or filename"
                autocomplete="off"
              />
            </form>
            <div class="doc-list" id="documents-list">
              {documents.length > 0 ? (
                documents.map((d) => <DocCard doc={d} subtitle={formatSize(d.size)} />)
              ) : hasQuery ? (
                <div class="section-empty">no documents match "{query}"</div>
              ) : (
                <SetupBlock workerUrl={workerUrl} requiresLogin={requiresLogin} />
              )}
            </div>
            <template id="documents-setup-template">
              <SetupBlock workerUrl={workerUrl} requiresLogin={requiresLogin} />
            </template>
            {hasDocuments && totalPages > 1 && (
              <div class="docs-pagination" id="documents-pagination">
                {page > 1 ? (
                  <a class="docs-pagination-link" href={previousPageHref} data-page={page - 1}>
                    previous
                  </a>
                ) : (
                  <div class="docs-pagination-spacer"></div>
                )}
                <div class="docs-pagination-status">
                  page {page} of {totalPages}
                </div>
                {page < totalPages ? (
                  <a class="docs-pagination-link" href={nextPageHref} data-page={page + 1}>
                    next
                  </a>
                ) : (
                  <div class="docs-pagination-spacer"></div>
                )}
              </div>
            )}
            {!hasDocuments || totalPages <= 1 ? (
              <div class="docs-pagination" id="documents-pagination"></div>
            ) : null}
          </div>
        </div>
        <script>{raw(escapeScriptContent(getHomeSearchScript(pageSize, workerUrl, page)))}</script>
      </body>
    </html>
  );
  return toHtml(jsx);
}
