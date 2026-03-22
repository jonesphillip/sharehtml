import { Hono } from "hono";
import { isRecord, isShareMode, parseDocumentSnapshot, shareModeFromInt, shareModeToInt, type AppBindings, type DocumentSnapshot, type ShareMode } from "../types.js";
import { nanoid } from "../utils/ids.js";
import { getRegistry } from "../utils/registry.js";
import { extractDocumentTextFromHtml } from "../utils/document-text.js";

const api = new Hono<AppBindings>();

async function migrateDocumentAnchors(
  documentDo: DurableObjectStub,
  newHtml: string,
  oldText: string,
  newText: string,
): Promise<void> {
  const response = await documentDo.fetch("https://document.local/migrate-anchors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newHtml, oldText, newText }),
  });

  if (!response.ok) {
    throw new Error(`anchor migration failed with status ${response.status}`);
  }
}

async function getDocumentSnapshot(documentDo: DurableObjectStub): Promise<DocumentSnapshot> {
  const response = await documentDo.fetch("https://document.local/snapshot");
  if (!response.ok) {
    throw new Error(`snapshot failed with status ${response.status}`);
  }
  const snapshot = parseDocumentSnapshot(await response.json());
  if (!snapshot) {
    throw new Error("invalid snapshot response from document DO");
  }
  return snapshot;
}

async function restoreDocumentSnapshot(
  documentDo: DurableObjectStub,
  snapshot: DocumentSnapshot,
): Promise<void> {
  const response = await documentDo.fetch("https://document.local/restore-snapshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });

  if (!response.ok) {
    throw new Error(`snapshot restore failed with status ${response.status}`);
  }
}

// Upload a document
api.post("/documents", async (c) => {
  const ownerEmail = c.get("authUser").email;
  const formData = await c.req.formData();
  const rawFile = formData.get("file");
  const file = rawFile instanceof File ? rawFile : null;
  const rawTitle = formData.get("title");
  const title = typeof rawTitle === "string" ? rawTitle : null;

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
    isShared: c.env.AUTH_MODE !== "access",
  });
});

// Find document by filename (owner resolved from token)
api.get("/documents/by-filename", async (c) => {
  const filename = c.req.query("filename");
  if (!filename) {
    return c.json({ error: "filename required" }, 400);
  }
  const owner = c.get("authUser").email;
  const registry = getRegistry(c.env);
  const doc = await registry.getDocumentByFilename(filename, owner);
  return c.json({ document: doc });
});

// Recently viewed documents (scoped to authenticated user)
api.get("/documents/recent", async (c) => {
  const email = c.get("authUser").email;
  const registry = getRegistry(c.env);
  const documents = await registry.getRecentViews(email);
  return c.json({ documents });
});

// List documents (scoped to authenticated user)
api.get("/documents", async (c) => {
  const owner = c.get("authUser").email;
  const registry = getRegistry(c.env);
  const query = (c.req.query("q") || "").trim();
  const limitQuery = Number.parseInt(c.req.query("limit") || "", 10);
  const pageQuery = Number.parseInt(c.req.query("page") || "", 10);
  const hasPaginationParams = Boolean(c.req.query("q")) || Boolean(c.req.query("limit")) ||
    Boolean(c.req.query("page"));

  if (!hasPaginationParams) {
    const documents = await registry.listDocuments(owner);
    return c.json({ documents });
  }

  const limit = Number.isFinite(limitQuery) && limitQuery > 0 ? limitQuery : 10;
  const page = Number.isFinite(pageQuery) && pageQuery > 0 ? pageQuery : 1;
  const result = await registry.listDocumentsPage(owner, { query, limit, page });
  return c.json({
    documents: result.documents,
    totalCount: result.totalCount,
    page: result.page,
    pageSize: limit,
    query,
  });
});

// Download raw document content
api.get("/documents/:id/raw", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc || doc.owner_email !== c.get("authUser").email) {
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
  if (!doc || doc.owner_email !== c.get("authUser").email) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ document: doc });
});

// Update document
api.put("/documents/:id", async (c) => {
  const id = c.req.param("id");
  const formData = await c.req.formData();
  const rawFile = formData.get("file");
  const file = rawFile instanceof File ? rawFile : null;
  const rawTitle = formData.get("title");
  const title = typeof rawTitle === "string" ? rawTitle : null;

  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }

  const filename = file.name || "document.html";
  const resolvedTitle = title || filename.replace(/\.(html?|md|markdown)$/i, "");
  const nextHtml = await file.text();

  const registry = getRegistry(c.env);
  const meta = await registry.getDocument(id);

  if (!meta) {
    return c.json({ error: "not found" }, 404);
  }

  if (meta.owner_email !== c.get("authUser").email) {
    return c.json({ error: "forbidden" }, 403);
  }

  const currentObject = await c.env.DOCUMENTS_BUCKET.get(`${id}/${meta.filename}`);
  const currentHtml = currentObject ? await currentObject.text() : null;
  const documentDoId = c.env.DOCUMENT_DO.idFromName(id);
  const documentDo = c.env.DOCUMENT_DO.get(documentDoId);
  const oldKey = `${id}/${meta.filename}`;
  const finalKey = `${id}/${filename}`;
  const tempKey = `${id}/.__pending__.${Date.now()}.${filename}`;

  let oldText: string | null = null;
  let newText: string | null = null;
  let snapshot: DocumentSnapshot | null = null;
  if (currentHtml !== null) {
    [oldText, newText, snapshot] = await Promise.all([
      extractDocumentTextFromHtml(currentHtml),
      extractDocumentTextFromHtml(nextHtml),
      getDocumentSnapshot(documentDo),
    ]);
  }

  let didMigrateAnchors = false;

  await c.env.DOCUMENTS_BUCKET.put(tempKey, nextHtml, {
    httpMetadata: { contentType: "text/html" },
    customMetadata: { title: resolvedTitle, ownerEmail: meta.owner_email },
  });

  try {
    if (oldText !== null && newText !== null) {
      await migrateDocumentAnchors(documentDo, nextHtml, oldText, newText);
      didMigrateAnchors = true;
    }

    await c.env.DOCUMENTS_BUCKET.put(finalKey, nextHtml, {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { title: resolvedTitle, ownerEmail: meta.owner_email },
    });
    await registry.updateDocument(id, { title: resolvedTitle, filename, size: file.size });

    if (oldKey !== finalKey) {
      await c.env.DOCUMENTS_BUCKET.delete(oldKey);
    }
  } catch (error) {
    if (didMigrateAnchors && snapshot) {
      try {
        await restoreDocumentSnapshot(documentDo, snapshot);
      } catch {
        // Best effort rollback only.
      }
    }
    throw error;
  } finally {
    await c.env.DOCUMENTS_BUCKET.delete(tempKey).catch(() => {});
  }

  const url = new URL(c.req.url);
  const docUrl = `${url.origin}/d/${id}`;

  return c.json({
    id,
    url: docUrl,
    title: resolvedTitle,
    filename,
    size: file.size,
    isShared: meta.is_shared === 1,
  });
});

api.get("/documents/:id/share", async (c) => {
  const id = c.req.param("id");
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc || doc.owner_email !== c.get("authUser").email) {
    return c.json({ error: "not found" }, 404);
  }
  const mode = shareModeFromInt(doc.is_shared);
  const emails = mode === "emails" ? await registry.getSharedEmails(id) : [];
  return c.json({ mode, emails });
});

api.put("/documents/:id/share", async (c) => {
  const id = c.req.param("id");

  if (c.env.AUTH_MODE !== "access") {
    return c.json({ error: "Cloudflare Access is required for document sharing controls" }, 400);
  }

  const body: unknown = await c.req.json();
  if (!isRecord(body)) {
    return c.json({ error: "invalid request body" }, 400);
  }

  let mode: ShareMode;
  let emails: string[] | undefined;

  if (isShareMode(body.mode)) {
    mode = body.mode;
    if (mode === "emails") {
      if (Array.isArray(body.emails)) {
        if (body.emails.length > 100) {
          return c.json({ error: "maximum 100 emails" }, 400);
        }
        if (!body.emails.every((e: unknown) => typeof e === "string" && e.includes("@"))) {
          return c.json({ error: "each email must be a valid email address" }, 400);
        }
        emails = body.emails;
      } else {
        emails = [];
      }
    }
  } else if (typeof body.isShared === "boolean") {
    mode = body.isShared ? "link" : "private";
  } else {
    return c.json({ error: "must provide mode or isShared" }, 400);
  }

  const registry = getRegistry(c.env);
  const meta = await registry.getDocument(id);

  if (!meta) {
    return c.json({ error: "not found" }, 404);
  }

  if (meta.owner_email !== c.get("authUser").email) {
    return c.json({ error: "forbidden" }, 403);
  }

  const ownerEmail = meta.owner_email.toLowerCase();
  await registry.setDocumentShareMode(id, shareModeToInt(mode));
  if (emails) {
    await registry.setSharedEmails(id, emails.filter((e) => e.toLowerCase() !== ownerEmail));
  }

  const responseEmails = mode === "emails" ? await registry.getSharedEmails(id) : [];
  return c.json({ ok: true, mode, isShared: mode === "link", emails: responseEmails });
});

// Delete document
api.delete("/documents/:id", async (c) => {
  const id = c.req.param("id");

  const registry = getRegistry(c.env);
  const meta = await registry.getDocument(id);

  if (!meta) {
    return c.json({ error: "not found" }, 404);
  }

  if (meta.owner_email !== c.get("authUser").email) {
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
