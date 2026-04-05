import { Hono } from "hono";
import { shareModeFromInt, type AppBindings, type DocumentRow } from "../types.js";
import { ShellView } from "../frontend/shell.js";
import { getAssetUrls } from "../utils/assets.js";
import { createCapabilityToken } from "../utils/capability.js";
import { createAttachmentHeaders } from "../utils/download.js";
import { requireViewerBrowserCapability } from "../utils/request-security.js";
import { getRegistry } from "../utils/registry.js";
import { getRenderedObject } from "../utils/document-storage.js";

const CAPABILITY_TTL_SECONDS = 600;

const viewer = new Hono<AppBindings>();

function canViewDocument(
  doc: Pick<DocumentRow, "owner_email" | "is_shared">,
  email: string,
  sharedEmails?: string[],
): boolean {
  if (doc.owner_email === email) return true;
  if (doc.is_shared === 1) return true;
  if (doc.is_shared === 2 && sharedEmails?.includes(email.toLowerCase())) return true;
  return false;
}

async function loadDocWithAccessCheck(
  env: AppBindings["Bindings"],
  id: string,
  email: string,
): Promise<{ doc: DocumentRow; registry: ReturnType<typeof getRegistry> } | null> {
  const registry = getRegistry(env);
  const doc = await registry.getDocument(id);
  if (!doc) return null;
  const sharedEmails = doc.is_shared === 2 ? await registry.getSharedEmails(id) : undefined;
  if (!canViewDocument(doc, email, sharedEmails)) return null;
  return { doc, registry };
}

// Viewer shell
viewer.get("/d/:id", async (c) => {
  const id = c.req.param("id");
  const { email } = c.get("authUser");

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
      canManageSharing: c.env.AUTH_MODE === "access" && doc.owner_email === email,
      assets,
      viewerCapabilityToken,
    }),
  );
});

// Refresh a viewer capability token. The shell calls this before the current
// token expires so long-lived sessions keep working.
viewer.post("/d/:id/capability", async (c) => {
  const id = c.req.param("id");
  const { email } = c.get("authUser");

  const result = await loadDocWithAccessCheck(c.env, id, email);
  if (!result) return c.text("Not found", 404);

  const protectedResponse = await requireViewerBrowserCapability(c, id);
  if (protectedResponse) return protectedResponse;

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
  const { email } = c.get("authUser");

  const result = await loadDocWithAccessCheck(c.env, id, email);
  if (!result) return c.text("Not found", 404);
  const { doc } = result;
  const protectedResponse = await requireViewerBrowserCapability(c, id, { responseType: "text" });
  if (protectedResponse) return protectedResponse;

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
  const { email } = c.get("authUser");

  const result = await loadDocWithAccessCheck(c.env, id, email);
  if (!result) return c.text("Not found", 404);
  const protectedResponse = await requireViewerBrowserCapability(c, id, {
    requireOrigin: true,
    responseType: "text",
    allowQueryCapability: true,
  });
  if (protectedResponse) return protectedResponse;

  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Verified-Email", email);

  const docId = c.env.DOCUMENT_DO.idFromName(id);
  const docDo = c.env.DOCUMENT_DO.get(docId);
  return docDo.fetch(
    new Request(`http://do/${id}/ws`, { headers }),
  );
});

export { viewer };
