import { Hono } from "hono";
import { shareModeFromInt, type AppBindings } from "../types.js";
import { ShellView } from "../frontend/shell.js";
import { getAssetUrls } from "../utils/assets.js";
import { createCapabilityToken } from "../utils/capability.js";
import { loadDocWithAccessCheck } from "../utils/document-access.js";
import { createAttachmentHeaders } from "../utils/download.js";
import { emailsMatch, normalizeEmail } from "../utils/email.js";
import { requireViewerBrowserCapability } from "../utils/request-security.js";
import { getRenderedObject } from "../utils/document-storage.js";

const CAPABILITY_TTL_SECONDS = 600;

const viewer = new Hono<AppBindings>();

// Viewer shell
viewer.get("/d/:id", async (c) => {
  const id = c.req.param("id");
  const email = normalizeEmail(c.get("authUser").email);

  const result = await loadDocWithAccessCheck(c.env, id, email);
  if (!result) return c.text("Not found", 404);
  const { doc, registry } = result;

  const assets = await getAssetUrls(c.env.ASSETS);
  const viewerCapabilityToken = await createCapabilityToken(c.env, {
    scope: "viewer",
    email,
    documentId: id,
    ttlSeconds: CAPABILITY_TTL_SECONDS,
  });

  // Record view (don't block response, but ensure it completes)
  c.executionCtx.waitUntil(registry.recordView(email, id).catch(() => {}));

  return c.html(
    ShellView({
      docId: id,
      title: doc.title,
      ownerEmail: doc.owner_email,
      email,
      authMode: c.env.AUTH_MODE,
      shareMode: shareModeFromInt(doc.is_shared),
      canManageSharing: c.env.AUTH_MODE === "access" && emailsMatch(doc.owner_email, email),
      assets,
      viewerCapabilityToken,
    }),
  );
});

// Refresh a viewer capability token. The shell calls this before the current
// token expires so long-lived sessions keep working.
viewer.post("/d/:id/capability", async (c) => {
  const id = c.req.param("id");
  const email = normalizeEmail(c.get("authUser").email);

  const protectedResponse = await requireViewerBrowserCapability(c, id);
  if (protectedResponse) return protectedResponse;

  const result = await loadDocWithAccessCheck(c.env, id, email);
  if (!result) return c.text("Not found", 404);

  const token = await createCapabilityToken(c.env, {
    scope: "viewer",
    email,
    documentId: id,
    ttlSeconds: CAPABILITY_TTL_SECONDS,
  });
  return c.json({ token });
});

// Rendered document bytes. The shell fetches this and assigns iframe.srcdoc.
viewer.get("/d/:id/content", async (c) => {
  const id = c.req.param("id");
  const email = normalizeEmail(c.get("authUser").email);

  const protectedResponse = await requireViewerBrowserCapability(c, id, { responseType: "text" });
  if (protectedResponse) return protectedResponse;

  const result = await loadDocWithAccessCheck(c.env, id, email);
  if (!result) return c.text("Not found", 404);
  const { doc } = result;

  const obj = await getRenderedObject(c.env.DOCUMENTS_BUCKET, id, doc);

  if (!obj) {
    return c.text("Content not found", 404);
  }

  const renderedFilename = doc.rendered_filename || doc.filename;

  return new Response(obj.body, {
    headers: createAttachmentHeaders(renderedFilename, {
      "X-ShareHTML-Download-Content-Type": "text/html; charset=utf-8",
    }),
  });
});

// WebSocket proxy to Document DO
viewer.get("/d/:id/ws", async (c) => {
  const id = c.req.param("id");
  const email = normalizeEmail(c.get("authUser").email);

  const protectedResponse = await requireViewerBrowserCapability(c, id, {
    requireOrigin: true,
    responseType: "text",
    allowWebSocketProtocolCapability: true,
  });
  if (protectedResponse) return protectedResponse;

  const result = await loadDocWithAccessCheck(c.env, id, email);
  if (!result) return c.text("Not found", 404);

  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Verified-Email", email);

  const docId = c.env.DOCUMENT_DO.idFromName(id);
  const docDo = c.env.DOCUMENT_DO.get(docId);
  return docDo.fetch(
    new Request(`http://do/${id}/ws`, { headers }),
  );
});

export { viewer };
