import { Hono } from "hono";
import type { AppBindings } from "../types.js";
import { apiAuth } from "../utils/auth.js";
import { nanoid } from "../utils/ids.js";
import { getRegistry } from "../utils/registry.js";

const api = new Hono<AppBindings>();

api.use("/*", apiAuth);

// Upload a document
api.post("/documents", async (c) => {
  const ownerEmail = c.get("apiUser");
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const title = formData.get("title") as string | null;

  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }

  const id = nanoid();
  const filename = file.name || "document.html";
  const resolvedTitle = title || filename.replace(/\.(html?|md|markdown)$/i, "");

  const registry = getRegistry(c.env);

  // Store in R2 and register in parallel
  await Promise.all([
    c.env.DOCUMENTS_BUCKET.put(`${id}/${filename}`, file.stream(), {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { title: resolvedTitle, ownerEmail },
    }),
    registry.createDocument({
      id,
      title: resolvedTitle,
      filename,
      size: file.size,
      owner_email: ownerEmail,
      is_shared: c.env.AUTH_MODE === "access" ? 0 : 1,
    }),
  ]);

  const url = new URL(c.req.url);
  const docUrl = `${url.origin}/d/${id}`;

  return c.json({
    id,
    url: docUrl,
    title: resolvedTitle,
    filename,
    size: file.size,
    isShared: c.env.AUTH_MODE === "access" ? false : true,
  });
});

// Find document by filename (owner resolved from token)
api.get("/documents/by-filename", async (c) => {
  const filename = c.req.query("filename");
  if (!filename) {
    return c.json({ error: "filename required" }, 400);
  }
  const owner = c.get("apiUser");
  const registry = getRegistry(c.env);
  const doc = await registry.getDocumentByFilename(filename, owner);
  return c.json({ document: doc });
});

// Recently viewed documents (scoped to authenticated user)
api.get("/documents/recent", async (c) => {
  const email = c.get("apiUser");
  const registry = getRegistry(c.env);
  const documents = await registry.getRecentViews(email);
  return c.json({ documents });
});

// List documents (scoped to authenticated user)
api.get("/documents", async (c) => {
  const owner = c.get("apiUser");
  const registry = getRegistry(c.env);
  const documents = await registry.listDocuments(owner);
  return c.json({ documents });
});

// Download raw document content
api.get("/documents/:id/raw", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc || doc.owner_email !== c.get("apiUser")) {
    return c.json({ error: "not found" }, 404);
  }

  const object = await c.env.DOCUMENTS_BUCKET.get(`${id}/${doc.filename}`);
  if (!object) {
    return c.json({ error: "file not found in storage" }, 404);
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${doc.filename.replace(/["\\]/g, "_")}"`,
    },
  });
});

// Get document metadata (ownership check)
api.get("/documents/:id", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc || doc.owner_email !== c.get("apiUser")) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ document: doc });
});

// Update document
api.put("/documents/:id", async (c) => {
  const id = c.req.param("id");
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  const title = formData.get("title") as string | null;

  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }

  const filename = file.name || "document.html";
  const resolvedTitle = title || filename.replace(/\.(html?|md|markdown)$/i, "");

  const registry = getRegistry(c.env);
  const meta = await registry.getDocument(id);

  if (!meta) {
    return c.json({ error: "not found" }, 404);
  }

  if (meta.owner_email !== c.get("apiUser")) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Delete old R2, store new R2, and update registry in parallel
  await Promise.all([
    c.env.DOCUMENTS_BUCKET.delete(`${id}/${meta.filename}`),
    c.env.DOCUMENTS_BUCKET.put(`${id}/${filename}`, file.stream(), {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { title: resolvedTitle, ownerEmail: meta.owner_email as string },
    }),
    registry.updateDocument(id, { title: resolvedTitle, filename, size: file.size }),
  ]);

  const url = new URL(c.req.url);
  const docUrl = `${url.origin}/d/${id}`;

  return c.json({
    id,
    url: docUrl,
    title: resolvedTitle,
    filename,
    size: file.size,
    isShared: Boolean(meta.is_shared),
  });
});

api.put("/documents/:id/share", async (c) => {
  const id = c.req.param("id");

  if (c.env.AUTH_MODE !== "access") {
    return c.json({ error: "Cloudflare Access is required for document sharing controls" }, 400);
  }

  const body = await c.req.json<{ isShared?: boolean }>();
  if (typeof body.isShared !== "boolean") {
    return c.json({ error: "isShared must be a boolean" }, 400);
  }

  const registry = getRegistry(c.env);
  const meta = await registry.getDocument(id);

  if (!meta) {
    return c.json({ error: "not found" }, 404);
  }

  if (meta.owner_email !== c.get("apiUser")) {
    return c.json({ error: "forbidden" }, 403);
  }

  await registry.setDocumentShared(id, body.isShared);

  return c.json({ ok: true, isShared: body.isShared });
});

// Delete document
api.delete("/documents/:id", async (c) => {
  const id = c.req.param("id");

  const registry = getRegistry(c.env);
  const meta = await registry.getDocument(id);

  if (!meta) {
    return c.json({ error: "not found" }, 404);
  }

  if (meta.owner_email !== c.get("apiUser")) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Delete from R2 and registry in parallel
  await Promise.all([
    c.env.DOCUMENTS_BUCKET.delete(`${id}/${meta.filename}`),
    registry.deleteDocument(id),
  ]);

  return c.json({ ok: true });
});

export { api };
