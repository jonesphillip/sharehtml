import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import hljs from "highlight.js";
import { marked } from "marked";
import { markedHighlight } from "marked-highlight";

const CODE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ".bash": "bash",
  ".c": "c",
  ".cc": "cpp",
  ".cjs": "javascript",
  ".cpp": "cpp",
  ".cs": "csharp",
  ".css": "css",
  ".go": "go",
  ".h": "c",
  ".hpp": "cpp",
  ".ini": "ini",
  ".java": "java",
  ".js": "javascript",
  ".json": "json",
  ".jsx": "javascript",
  ".kt": "kotlin",
  ".mjs": "javascript",
  ".php": "php",
  ".py": "python",
  ".rb": "ruby",
  ".rs": "rust",
  ".scss": "scss",
  ".sh": "bash",
  ".sql": "sql",
  ".swift": "swift",
  ".toml": "toml",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".xml": "xml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zsh": "bash",
};

marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      return highlightCode(code, lang);
    },
  }),
);
marked.setOptions({ gfm: true, breaks: false });

export function isMarkdownFile(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}

export function isCodeFile(filename: string): boolean {
  return getCodeLanguage(filename) !== null;
}

export type SourceKind = "html" | "markdown" | "code";

export function getSourceKind(filename: string): SourceKind {
  if (isMarkdownFile(filename)) {
    return "markdown";
  }

  if (isCodeFile(filename)) {
    return "code";
  }

  return "html";
}

export function renderedFilenameToHtml(filename: string): string {
  if (isMarkdownFile(filename)) {
    return filename.replace(/\.(md|markdown)$/i, ".html");
  }

  if (isCodeFile(filename)) {
    return `${filename}.html`;
  }

  return filename;
}

export function defaultDocumentTitleFromFilename(filename: string): string {
  if (isMarkdownFile(filename)) {
    return filename.replace(/\.(md|markdown)$/i, "");
  }

  if (isCodeFile(filename)) {
    return filename.replace(/\.[^.]+$/i, "");
  }

  return filename.replace(/\.(html?)$/i, "");
}

export function renderMarkdownToHtml(markdown: string, title: string, filePath: string): string {
  const processed = inlineRelativeImages(markdown, filePath);
  const body = marked.parse(processed) as string;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body {
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
  font-size: 13px;
  line-height: 1.6;
  max-width: 860px;
  margin: 0 auto;
  padding: 32px 24px;
  color: #000;
  background: #fff;
}
h1 { font-size: 16px; font-weight: bold; margin: 24px 0 12px; }
h2 { font-size: 14px; font-weight: bold; margin: 20px 0 10px; }
h3 { font-size: 13px; font-weight: bold; margin: 16px 0 8px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 16px 0; }
th { font-weight: bold; border-bottom: 2px solid #000; padding: 6px 8px; text-align: left; }
td { border-bottom: 1px solid #ddd; padding: 6px 8px; }
pre { background: #f5f5f5; border: 1px solid #ddd; padding: 12px; overflow-x: auto; margin: 16px 0; }
pre code { background: none; border: none; padding: 0; }
code { background: #f5f5f5; padding: 2px 4px; font-size: 12px; }
${getHighlightCss()}
blockquote { border-left: 2px solid #999; margin: 16px 0; padding: 4px 16px; color: #444; }
hr { border: none; border-top: 1px solid #000; margin: 24px 0; }
img { max-width: 100%; }
a { color: #000; text-decoration: underline; }
ul, ol { padding-left: 24px; }
li { margin: 4px 0; }
input[type="checkbox"] { margin-right: 6px; }
@media (max-width: 600px) {
  body { padding: 16px 12px; font-size: 12px; }
  h1 { font-size: 15px; }
  h2 { font-size: 13px; }
  table { font-size: 11px; }
}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function renderCodeToHtml(code: string, title: string, filename: string): string {
  const language = getCodeLanguage(filename);
  const highlighted = highlightCode(code, language || undefined);
  const languageLabel = language ? escapeHtml(language) : "text";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
html, body {
  margin: 0;
  min-height: 100%;
  background: #f5f5f5;
}
body {
  color: #000;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
}
.code-page {
  min-height: 100vh;
}
.code-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 24px 0;
  font-size: 12px;
}
.code-title {
  font-weight: 700;
}
.code-language {
  color: #6f6f6f;
  text-transform: lowercase;
}
pre {
  margin: 0;
  padding: 18px 24px 32px;
  overflow-x: auto;
  white-space: pre;
  font-size: 13px;
  line-height: 1.65;
  background: transparent;
}
code {
  display: block;
  min-height: calc(100vh - 64px);
}
${getHighlightCss()}
@media (max-width: 600px) {
  .code-header {
    padding: 14px 16px 0;
    font-size: 11px;
  }
  pre {
    padding: 14px 16px 24px;
    font-size: 12px;
  }
}
</style>
</head>
<body>
  <div class="code-page">
    <div class="code-header">
      <span class="code-title">${escapeHtml(title)}</span>
      <span class="code-language">${languageLabel}</span>
    </div>
    <pre><code class="hljs language-${languageLabel}">${highlighted}</code></pre>
  </div>
</body>
</html>`;
}

export function getCodeLanguage(filename: string): string | null {
  const extension = extname(filename).toLowerCase();
  return CODE_LANGUAGE_BY_EXTENSION[extension] ?? null;
}

function inlineRelativeImages(markdown: string, filePath: string): string {
  const dir = dirname(filePath);

  return markdown.replace(
    /!\[([^\]]*)\]\((\.[^)]+)\)/g,
    (_match, alt: string, imgPath: string) => {
      const absPath = resolve(dir, imgPath);
      try {
        const data = readFileSync(absPath).toString("base64");
        const ext = extname(absPath).slice(1).toLowerCase();
        const mime =
          ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
        return `![${alt}](data:${mime};base64,${data})`;
      } catch {
        console.error(`Warning: image not found: ${imgPath}`);
        return _match;
      }
    },
  );
}

function highlightCode(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang }).value;
  }
  return hljs.highlightAuto(code).value;
}

function getHighlightCss(): string {
  return `
.hljs-keyword, .hljs-selector-tag, .hljs-built_in { color: #6b4d7d; }
.hljs-string, .hljs-attr { color: #4e6b3a; }
.hljs-comment, .hljs-quote { color: #918d88; font-style: italic; }
.hljs-number, .hljs-literal, .hljs-variable.constant_ { color: #7a5530; }
.hljs-type, .hljs-title, .hljs-title.class_, .hljs-title.function_ { color: #2e5580; }
.hljs-params { color: #555; }
.hljs-meta, .hljs-tag { color: #76695a; }
.hljs-attribute, .hljs-symbol { color: #4e6b3a; }
.hljs-selector-class, .hljs-selector-id { color: #6b4d7d; }
.hljs-addition { background: #eef6ee; }
.hljs-deletion { background: #f6eeee; }
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
