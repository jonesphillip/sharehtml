import type { HtmlEscapedString } from "hono/utils/html";

// Hono JSX.Element = HtmlEscapedString | Promise<HtmlEscapedString>.
// Our views are synchronous, so we narrow out the Promise at runtime.
export function toHtml(jsx: HtmlEscapedString | Promise<HtmlEscapedString>): HtmlEscapedString {
  if (jsx instanceof Promise) {
    throw new Error("Expected synchronous JSX");
  }
  return jsx;
}

// Escape a string for safe embedding inside a <script> tag.
// Prevents </script> injection and HTML comment/CDATA breakouts.
export function escapeScriptContent(str: string): string {
  return str.replace(/<\//g, "<\\/").replace(/<!--/g, "<\\!--");
}

// JSON.stringify + escapeScriptContent for safe inline <script> data.
export function safeJsonForScript(value: unknown): string {
  return escapeScriptContent(JSON.stringify(value));
}
