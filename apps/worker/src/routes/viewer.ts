import { Hono } from "hono";
import { shareModeFromInt, type AppBindings, type DocumentRow } from "../types.js";
import { ShellView } from "../frontend/shell.js";
import { getAssetUrls } from "../utils/assets.js";
import { getRegistry } from "../utils/registry.js";

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
    }),
  );
});

// Raw HTML content (served in iframe)
viewer.get("/d/:id/content", async (c) => {
  const id = c.req.param("id");
  const { email } = c.get("authUser");

  const result = await loadDocWithAccessCheck(c.env, id, email);
  if (!result) return c.text("Not found", 404);
  const { doc } = result;

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
