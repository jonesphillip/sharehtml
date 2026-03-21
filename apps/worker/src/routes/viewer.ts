import { Hono } from "hono";
import type { AppBindings, DocumentRow } from "../types.js";
import { ShellView } from "../frontend/shell.js";
import { getAssetUrls } from "../utils/assets.js";
import { getRegistry } from "../utils/registry.js";

const viewer = new Hono<AppBindings>();

function canViewDocument(
  doc: Pick<DocumentRow, "owner_email" | "is_shared">,
  email: string,
): boolean {
  return doc.owner_email === email || Boolean(doc.is_shared);
}

// Viewer shell
viewer.get("/d/:id", async (c) => {
  const id = c.req.param("id");
  const { email } = c.get("authUser");

  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);

  if (!doc || !canViewDocument(doc, email)) {
    return c.text("Not found", 404);
  }

  const assets = await getAssetUrls(c.env.ASSETS);

  // Record view (don't block response, but ensure it completes)
  c.executionCtx.waitUntil(registry.recordView(email, id).catch(() => {}));

  return c.html(
    ShellView({
      docId: id,
      title: doc.title,
      ownerEmail: doc.owner_email,
      email,
      authMode: c.env.AUTH_MODE,
      isShared: Boolean(doc.is_shared),
      canManageSharing: c.env.AUTH_MODE === "access" && doc.owner_email === email,
      assets,
    }),
  );
});

// Raw HTML content (served in iframe)
viewer.get("/d/:id/content", async (c) => {
  const id = c.req.param("id");
  const { email } = c.get("authUser");

  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);

  if (!doc || !canViewDocument(doc, email)) {
    return c.text("Not found", 404);
  }

  const obj = await c.env.DOCUMENTS_BUCKET.get(`${id}/${doc.filename}`);

  if (!obj) {
    return c.text("Content not found", 404);
  }

  let html = await obj.text();

  // Inject <base target="_blank"> so links open in new tabs instead of navigating the iframe
  const baseTag = `<base target="_blank">`;
  if (html.includes("<head>")) {
    html = html.replace("<head>", `<head>${baseTag}`);
  } else if (html.includes("<html")) {
    html = html.replace(/<html[^>]*>/, `$&${baseTag}`);
  } else {
    html = baseTag + html;
  }

  // Inject collaboration script before </body>
  const assets = await getAssetUrls(c.env.ASSETS);
  const script = `<script src="${assets.collabJs}"></script>`;
  if (html.includes("</body>")) {
    html = html.replace("</body>", `${script}</body>`);
  } else {
    html += script;
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "sandbox allow-scripts allow-popups",
    },
  });
});

// WebSocket proxy to Document DO
viewer.get("/d/:id/ws", async (c) => {
  const id = c.req.param("id");
  const { email } = c.get("authUser");

  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc || !canViewDocument(doc, email)) {
    return c.text("Not found", 404);
  }

  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Verified-Email", email);

  const docId = c.env.DOCUMENT_DO.idFromName(id);
  const docDo = c.env.DOCUMENT_DO.get(docId);
  return docDo.fetch(
    new Request(`http://do/${id}/ws`, { headers }),
  );
});

export { viewer };
