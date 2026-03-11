import { Hono } from "hono";
import type { Env } from "../types.js";
import { ShellView } from "../frontend/shell.js";
import { getAuthenticatedUser } from "../utils/auth.js";
import { getAssetUrls } from "../utils/assets.js";
import { getRegistry } from "../utils/registry.js";

const viewer = new Hono<{ Bindings: Env }>();

function canViewDocument(
  doc: { owner_email: string; is_shared?: number },
  email: string,
): boolean {
  return doc.owner_email === email || Boolean(doc.is_shared);
}

// Viewer shell
viewer.get("/d/:id", async (c) => {
  const id = c.req.param("id");

  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);

  if (!doc) {
    return c.html("<h1>Document not found</h1>", 404);
  }

  const user = await getAuthenticatedUser(c.req.raw, c.env);
  if (!user) return c.text("Unauthorized", 401);
  const email = user.email;
  if (!canViewDocument(doc as { owner_email: string; is_shared?: number }, email)) {
    return c.text("Not found", 404);
  }

  const assets = await getAssetUrls(c.env.ASSETS);

  // Record view (don't block response, but ensure it completes)
  c.executionCtx.waitUntil(registry.recordView(email, id).catch(() => {}));

  return c.html(
    ShellView({
      docId: id,
      title: doc.title as string,
      ownerEmail: doc.owner_email as string,
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

  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);

  if (!doc) {
    return c.text("Not found", 404);
  }

  const user = await getAuthenticatedUser(c.req.raw, c.env);
  if (!user) return c.text("Unauthorized", 401);
  if (!canViewDocument(doc as { owner_email: string; is_shared?: number }, user.email)) {
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

  return c.html(html);
});

// WebSocket proxy to Document DO
viewer.get("/d/:id/ws", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc) {
    return c.text("Not found", 404);
  }

  // Verify identity and pass to DO so it can't be spoofed
  const user = await getAuthenticatedUser(c.req.raw, c.env);
  if (!user) {
    return c.text("Unauthorized", 401);
  }
  if (!canViewDocument(doc as { owner_email: string; is_shared?: number }, user.email)) {
    return c.text("Not found", 404);
  }

  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Verified-Email", user.email);

  const docId = c.env.DOCUMENT_DO.idFromName(id);
  const docDo = c.env.DOCUMENT_DO.get(docId);
  return docDo.fetch(
    new Request(`http://do/${id}/ws`, { headers }),
  );
});

export { viewer };
