const IGNORED_CONTENT_REGEX =
  /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi;

export async function extractDocumentTextFromHtml(html: string): Promise<string> {
  let text = "";
  const sanitizedHtml = html.replace(IGNORED_CONTENT_REGEX, "");

  const collector = {
    text(chunk: { text: string }): void {
      text += chunk.text;
    },
  };

  await new HTMLRewriter().on("*", collector).transform(new Response(sanitizedHtml)).text();
  return text;
}
