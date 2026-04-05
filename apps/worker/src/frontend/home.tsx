/** @jsxImportSource hono/jsx */
import { raw } from "hono/utils/html";
import type { AssetUrls } from "../utils/assets.js";
import { buildHomePath, formatDocumentSize, formatDocumentsResultsLabel, formatRelativeTime } from "../utils/home-view.js";
import type { DocumentRow, RecentViewRow } from "../types.js";
import { toHtml, safeJsonForScript } from "./jsx.js";

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
  homeCapabilityToken: string;
}

interface DocCardProps {
  doc: DocumentRow;
  subtitle: string;
}

interface RecentDocCardProps {
  doc: RecentViewRow;
}

interface SetupBlockProps {
  workerUrl: string;
  requiresLogin: boolean;
}

function DocCard({ doc, subtitle }: DocCardProps): JSX.Element {
  return (
    <a class="doc-card" href={`/d/${doc.id}`}>
      <div class="doc-card-top">
        <span class="doc-card-title">{doc.title}</span>
        <span class="doc-card-filename">{doc.filename}</span>
      </div>
      <div class="doc-card-bottom">
        <span class="doc-card-meta">{subtitle}</span>
        <span class="doc-card-meta">{formatRelativeTime(doc.created_at)}</span>
      </div>
    </a>
  );
}

function RecentDocCard({ doc }: RecentDocCardProps): JSX.Element {
  const viewedAt = doc.last_viewed_at || doc.created_at;

  return (
    <a class="recent-card" href={`/d/${doc.id}`}>
      <div class="recent-card-title">{doc.title}</div>
      <div class="recent-card-filename">{doc.filename}</div>
      <div class="recent-card-meta">viewed {formatRelativeTime(viewedAt)}</div>
    </a>
  );
}

function SetupBlock({ workerUrl, requiresLogin }: SetupBlockProps): JSX.Element {
  return (
    <div class="setup-block">
      <p>
        Deploy HTML, Markdown, or code files with the{" "}
        <a href="https://github.com/jonesphillip/sharehtml">sharehtml CLI</a>.{" "}
        Requires <a href="https://bun.sh">Bun</a>.
      </p>
      <pre>
        {raw(`<span class="cmd-comment"># install the CLI</span>\n`)}
        bun install -g sharehtml{"\n\n"}
        {raw(`<span class="cmd-comment"># configure</span>\n`)}
        sharehtml config set-url {workerUrl}{"\n"}
        {requiresLogin ? "sharehtml login\n" : ""}
        {"\n"}
        {raw(`<span class="cmd-comment"># deploy a file</span>\n`)}
        sharehtml deploy example/coffee-report.html
      </pre>
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
  homeCapabilityToken,
}: HomeParams): string {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const hasDocuments = totalCount > 0;
  const hasQuery = query.length > 0;
  const previousPageHref = buildHomePath(query, page - 1);
  const nextPageHref = buildHomePath(query, page + 1);
  const resultsLabel = formatDocumentsResultsLabel(totalCount, hasQuery ? query : "");

  const jsx = (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>sharehtml</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        {assets.homeCss && <link rel="stylesheet" href={assets.homeCss} />}
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
                documents.map((d) => <DocCard doc={d} subtitle={formatDocumentSize(d.size)} />)
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
        <script>
          {raw(
            `window.__HOME_CONFIG__ = ${safeJsonForScript({
              page,
              pageSize,
              homeCapabilityToken,
            })}`,
          )}
        </script>
        {assets.homeClientJs && <script type="module" src={assets.homeClientJs}></script>}
      </body>
    </html>
  );
  return toHtml(jsx);
}
