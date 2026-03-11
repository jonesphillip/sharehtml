/** @jsxImportSource hono/jsx */
import { raw } from "hono/utils/html";
import type { HtmlEscapedString } from "hono/utils/html";

interface Document {
  id: string;
  title: string;
  filename: string;
  size: number;
  owner_email: string;
  created_at: string;
  last_viewed_at?: string;
}

interface HomeParams {
  email: string;
  workerUrl: string;
  documents: Document[];
  recentViews: Document[];
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

function DocCard({ doc, subtitle }: { doc: Document; subtitle: string }) {
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

export function HomeView({
  email,
  workerUrl,
  documents,
  recentViews,
  requiresLogin,
}: HomeParams): HtmlEscapedString {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>sharehtml</title>
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <style>
          {raw(`
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px;
            line-height: 1.5;
            color: #000000;
            background: #ffffff;
            height: 100vh;
            overflow-y: auto;
          }
          .topbar {
            height: 44px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 16px;
            border-bottom: 1px solid #000000;
            background: #ffffff;
            position: sticky;
            top: 0;
            z-index: 10;
          }
          .topbar-title {
            font-size: 14px;
            font-weight: 500;
          }
          .topbar-right {
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .topbar-email {
            font-size: 12px;
            font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
            color: #a3a3a3;
          }
          .content {
            max-width: 640px;
            margin: 0 auto;
            padding: 32px 16px;
          }
          .section {
            margin-bottom: 32px;
          }
          .section-label {
            font-size: 12px;
            font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
            color: #737373;
            margin-bottom: 12px;
          }
          .section-empty {
            font-size: 13px;
            color: #a3a3a3;
            padding: 16px 0;
          }
          .doc-list {
            display: flex;
            flex-direction: column;
            gap: 8px;
          }
          .doc-card {
            display: block;
            border: 1px solid #d4d4d4;
            border-radius: 4px;
            padding: 12px;
            text-decoration: none;
            color: inherit;
            transition: border-color 120ms ease;
            animation: fadeIn 150ms ease;
          }
          .doc-card:hover {
            border-color: #000000;
          }
          .doc-card-top {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            gap: 12px;
            margin-bottom: 4px;
          }
          .doc-card-title {
            font-size: 14px;
            font-weight: 500;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .doc-card-filename {
            font-size: 12px;
            font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
            color: #a3a3a3;
            flex-shrink: 0;
          }
          .doc-card-bottom {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
          }
          .doc-card-meta {
            font-size: 12px;
            font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
            color: #a3a3a3;
          }
          .setup-block {
            border: 1px solid #d4d4d4;
            border-radius: 4px;
            padding: 20px;
          }
          .setup-block p {
            font-size: 13px;
            color: #737373;
            margin-bottom: 16px;
            line-height: 1.5;
          }
          .setup-block p a {
            color: #000000;
          }
          .setup-block pre {
            background: #f5f5f5;
            border: 1px solid #d4d4d4;
            border-radius: 4px;
            padding: 12px 14px;
            font-size: 12px;
            font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
            line-height: 1.7;
            overflow-x: auto;
            white-space: pre;
            color: #000000;
          }
          .setup-block .cmd-comment {
            color: #a3a3a3;
          }
          @keyframes fadeIn {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
          }
        `)}
        </style>
      </head>
      <body>
        <div class="topbar">
          <div class="topbar-title">sharehtml</div>
          <div class="topbar-right">
            <span class="topbar-email">{email}</span>
          </div>
        </div>
        <div class="content">
          <div class="section">
            <div class="section-label">recently viewed</div>
            <div class="doc-list">
              {recentViews.length > 0 ? (
                recentViews.map((d) => (
                  <DocCard
                    doc={d}
                    subtitle={`viewed ${relativeTime(d.last_viewed_at || d.created_at)}`}
                  />
                ))
              ) : (
                <div class="section-empty">no recently viewed documents</div>
              )}
            </div>
          </div>
          <div class="section">
            <div class="section-label">documents</div>
            <div class="doc-list">
              {documents.length > 0 ? (
                documents.map((d) => <DocCard doc={d} subtitle={formatSize(d.size)} />)
              ) : (
                <div class="setup-block">
                  <p>
                    Deploy HTML or Markdown files with the{" "}
                    <a href="https://github.com/jonesphillip/sharehtml">sharehtml CLI</a>, then:
                  </p>
                  {raw(`<pre><span class="cmd-comment"># install the CLI</span>
git clone https://github.com/jonesphillip/sharehtml.git
cd sharehtml && pnpm install
cd apps/cli && pnpm build && bun link

<span class="cmd-comment"># configure</span>
sharehtml config set-url ${workerUrl}
${requiresLogin ? "sharehtml login\n" : ""}

<span class="cmd-comment"># deploy a file</span>
sharehtml deploy example/coffee-report.html</pre>`)}
                </div>
              )}
            </div>
          </div>
        </div>
      </body>
    </html>
  ) as unknown as HtmlEscapedString;
}
