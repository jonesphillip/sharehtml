import { Hono } from "hono";
import { isRecord, isShareMode, isSourceKind, parseDocumentSnapshot, shareModeFromInt, shareModeToInt, type AppBindings, type DocumentSnapshot, type ShareMode, type SourceKind } from "../types.js";
import { nanoid } from "../utils/ids.js";
import { getRegistry } from "../utils/registry.js";
import { extractDocumentTextFromHtml } from "../utils/document-text.js";
import {
  getLegacyDocumentKey,
  getRenderedDocumentKey,
  getRenderedObject,
  getSourceDocumentKey,
  getSourceObject,
} from "../utils/document-storage.js";
import { createAttachmentHeaders } from "../utils/download.js";
import { requireHomeBrowserCapability, requireViewerBrowserCapability } from "../utils/request-security.js";

const api = new Hono<AppBindings>();

function inferSourceKind(filename: string): SourceKind {
  if (/\.(md|markdown)$/i.test(filename)) {
    return "markdown";
  }

  if (/\.[^.]+$/i.test(filename) && !/\.(html?)$/i.test(filename)) {
    return "code";
  }

  return "html";
}

function getDocumentTitle(filename: string, title: string | null, sourceKind?: SourceKind | null): string {
  if (title) {
    return title;
  }

  const resolvedKind = sourceKind || inferSourceKind(filename);
  if (resolvedKind === "markdown") {
    return filename.replace(/\.(md|markdown)$/i, "");
  }

  if (resolvedKind === "code") {
    return filename.replace(/\.[^.]+$/i, "");
  }

  return filename.replace(/\.(html?)$/i, "");
}

function getSourceMimeType(kind: SourceKind): string {
  if (kind === "html") {
    return "text/html; charset=utf-8";
  }

  if (kind === "markdown") {
    return "text/markdown; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

function narrowSourceKind(value: string | null): SourceKind {
  return isSourceKind(value) ? value : "html";
}

function parseSourceFields(formData: FormData): {
  source: File | null;
  sourceKind: SourceKind | null;
  sourceLanguage: string | null;
} {
  const rawSource = formData.get("source");
  const source = rawSource instanceof File ? rawSource : null;
  const rawSourceKind = formData.get("sourceKind");
  const sourceKind = isSourceKind(rawSourceKind) ? rawSourceKind : null;
  const rawSourceLanguage = formData.get("sourceLanguage");
  const sourceLanguage = typeof rawSourceLanguage === "string" ? rawSourceLanguage : null;
  return { source, sourceKind, sourceLanguage };
}

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

api.post("/documents", async (c) => {
  const protectedResponse = await requireHomeBrowserCapability(c);
  if (protectedResponse) return protectedResponse;

  const ownerEmail = c.get("authUser").email;
  const formData = await c.req.formData();
  const rawFile = formData.get("file");
  const file = rawFile instanceof File ? rawFile : null;
  const rawTitle = formData.get("title");
  const title = typeof rawTitle === "string" ? rawTitle : null;
  const { source, sourceKind, sourceLanguage } = parseSourceFields(formData);

  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }

  const id = nanoid();
  const renderedFilename = file.name || "document.html";
  const sourceFilename = source?.name || renderedFilename;
  const resolvedTitle = getDocumentTitle(sourceFilename, title, sourceKind);

  const registry = getRegistry(c.env);

  const writes: Array<Promise<unknown>> = [
    c.env.DOCUMENTS_BUCKET.put(getRenderedDocumentKey(id, renderedFilename), file.stream(), {
      httpMetadata: { contentType: "text/html" },
      customMetadata: { title: resolvedTitle, ownerEmail },
    }),
    registry.createDocument({
      id,
      title: resolvedTitle,
      filename: sourceFilename,
      size: file.size,
      owner_email: ownerEmail,
      is_shared: c.env.AUTH_MODE === "access" ? 0 : 1,
      rendered_filename: renderedFilename,
      source_filename: source && sourceKind ? sourceFilename : null,
      source_kind: sourceKind,
      source_language: sourceLanguage,
    }),
  ];

  if (source && sourceKind) {
    writes.push(
      c.env.DOCUMENTS_BUCKET.put(getSourceDocumentKey(id, sourceFilename), source.stream(), {
        httpMetadata: { contentType: getSourceMimeType(sourceKind) },
        customMetadata: { title: resolvedTitle, ownerEmail, sourceKind },
      }),
    );
  }

  await Promise.all(writes);

  const url = new URL(c.req.url);
  const docUrl = `${url.origin}/d/${id}`;

  return c.json({
    id,
    url: docUrl,
    title: resolvedTitle,
    filename: sourceFilename,
    size: file.size,
    isShared: c.env.AUTH_MODE !== "access",
  });
});

api.get("/documents/by-filename", async (c) => {
  const protectedResponse = await requireHomeBrowserCapability(c, { requireOrigin: false });
  if (protectedResponse) return protectedResponse;

  const filename = c.req.query("filename");
  if (!filename) {
    return c.json({ error: "filename required" }, 400);
  }
  const match = c.req.query("match");
  let matchMode: "source" | "rendered" | "any" = "any";
  if (match) {
    if (match === "source" || match === "rendered" || match === "any") {
      matchMode = match;
    } else {
      return c.json({ error: "match must be source, rendered, or any" }, 400);
    }
  }
  const owner = c.get("authUser").email;
  const registry = getRegistry(c.env);
  const doc = await registry.getDocumentByFilename(filename, owner, matchMode);
  return c.json({ document: doc });
});

// Recently viewed documents (scoped to authenticated user)
api.get("/documents/recent", async (c) => {
  const protectedResponse = await requireHomeBrowserCapability(c, { requireOrigin: false });
  if (protectedResponse) return protectedResponse;

  const email = c.get("authUser").email;
  const registry = getRegistry(c.env);
  const documents = await registry.getRecentViews(email);
  return c.json({ documents });
});

// List documents (scoped to authenticated user)
api.get("/documents", async (c) => {
  const protectedResponse = await requireHomeBrowserCapability(c, { requireOrigin: false });
  if (protectedResponse) return protectedResponse;

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

api.get("/documents/:id/raw", async (c) => {
  const id = c.req.param("id");
  const protectedResponse = await requireViewerBrowserCapability(c, id, { requireOrigin: false });
  if (protectedResponse) return protectedResponse;
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc || doc.owner_email !== c.get("authUser").email) {
    return c.json({ error: "not found" }, 404);
  }

  const sourceObject = await getSourceObject(c.env.DOCUMENTS_BUCKET, id, doc);
  const renderedObject = sourceObject ? null : await getRenderedObject(c.env.DOCUMENTS_BUCKET, id, doc);
  const object = sourceObject || renderedObject;
  if (!object) {
    return c.json({ error: "file not found in storage" }, 404);
  }

  const downloadFilename = sourceObject && doc.source_filename
    ? doc.source_filename
    : doc.filename;
  const contentType = sourceObject
    ? getSourceMimeType(narrowSourceKind(doc.source_kind))
    : "text/html; charset=utf-8";

  return new Response(object.body, {
    headers: createAttachmentHeaders(downloadFilename, {
      "X-ShareHTML-Download-Content-Type": contentType,
    }),
  });
});

api.get("/documents/:id/source", async (c) => {
  const id = c.req.param("id");
  const protectedResponse = await requireViewerBrowserCapability(c, id, { requireOrigin: false });
  if (protectedResponse) return protectedResponse;
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc || doc.owner_email !== c.get("authUser").email) {
    return c.json({ error: "not found" }, 404);
  }

  const object = await getSourceObject(c.env.DOCUMENTS_BUCKET, id, doc);
  if (!object || !doc.source_filename) {
    return c.json({ error: "source unavailable" }, 404);
  }

  return new Response(object.body, {
    headers: createAttachmentHeaders(doc.source_filename, {
      "X-ShareHTML-Download-Content-Type": getSourceMimeType(narrowSourceKind(doc.source_kind)),
      "X-ShareHTML-Source-Kind": doc.source_kind || "html",
      "X-ShareHTML-Source-Language": doc.source_language || "",
    }),
  });
});

api.get("/documents/:id/rendered", async (c) => {
  const id = c.req.param("id");
  const protectedResponse = await requireViewerBrowserCapability(c, id, { requireOrigin: false });
  if (protectedResponse) return protectedResponse;
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc || doc.owner_email !== c.get("authUser").email) {
    return c.json({ error: "not found" }, 404);
  }

  const object = await getRenderedObject(c.env.DOCUMENTS_BUCKET, id, doc);
  if (!object) {
    return c.json({ error: "file not found in storage" }, 404);
  }

  const renderedFilename = doc.rendered_filename || doc.filename;
  return new Response(object.body, {
    headers: createAttachmentHeaders(renderedFilename, {
      "X-ShareHTML-Download-Content-Type": "text/html; charset=utf-8",
    }),
  });
});

// Get document metadata (ownership check)
api.get("/documents/:id", async (c) => {
  const id = c.req.param("id");
  const protectedResponse = await requireViewerBrowserCapability(c, id, { requireOrigin: false });
  if (protectedResponse) return protectedResponse;
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc || doc.owner_email !== c.get("authUser").email) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json({ document: doc });
});

api.put("/documents/:id", async (c) => {
  const id = c.req.param("id");
  const protectedResponse = await requireViewerBrowserCapability(c, id);
  if (protectedResponse) return protectedResponse;
  const formData = await c.req.formData();
  const rawFile = formData.get("file");
  const file = rawFile instanceof File ? rawFile : null;
  const rawTitle = formData.get("title");
  const title = typeof rawTitle === "string" ? rawTitle : null;
  const { source, sourceKind, sourceLanguage } = parseSourceFields(formData);

  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }

  const renderedFilename = file.name || "document.html";
  const sourceFilename = source?.name || renderedFilename;
  const nextHtml = await file.text();

  const registry = getRegistry(c.env);
  const meta = await registry.getDocument(id);

  if (!meta) {
    return c.json({ error: "not found" }, 404);
  }

  if (meta.owner_email !== c.get("authUser").email) {
    return c.json({ error: "forbidden" }, 403);
  }

  const existingSourceKind = isSourceKind(meta.source_kind) ? meta.source_kind : null;
  const resolvedTitle = getDocumentTitle(sourceFilename, title, sourceKind || existingSourceKind);

  const currentObject = await getRenderedObject(c.env.DOCUMENTS_BUCKET, id, meta);
  const currentHtml = currentObject ? await currentObject.text() : null;
  const documentDoId = c.env.DOCUMENT_DO.idFromName(id);
  const documentDo = c.env.DOCUMENT_DO.get(documentDoId);
  const oldRenderedFilename = meta.rendered_filename || meta.filename;
  const oldRenderedKey = meta.rendered_filename
    ? getRenderedDocumentKey(id, oldRenderedFilename)
    : getLegacyDocumentKey(id, oldRenderedFilename);
  const oldSourceKey = meta.source_filename
    ? getSourceDocumentKey(id, meta.source_filename)
    : null;
  const finalRenderedKey = getRenderedDocumentKey(id, renderedFilename);
  const nextSourceFilename = source && sourceKind
    ? sourceFilename
    : meta.source_filename || null;
  const nextSourceKind = source && sourceKind
    ? sourceKind
    : meta.source_kind || null;
  const nextSourceLanguage = source && sourceKind
    ? sourceLanguage
    : meta.source_language || null;
  const finalSourceKey = nextSourceFilename ? getSourceDocumentKey(id, nextSourceFilename) : null;
  const tempKey = `${id}/.__pending__.${Date.now()}.${renderedFilename}`;

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

    const r2Writes: Array<Promise<unknown>> = [
      c.env.DOCUMENTS_BUCKET.put(finalRenderedKey, nextHtml, {
        httpMetadata: { contentType: "text/html" },
        customMetadata: { title: resolvedTitle, ownerEmail: meta.owner_email },
      }),
    ];
    if (source && sourceKind && finalSourceKey) {
      r2Writes.push(
        c.env.DOCUMENTS_BUCKET.put(finalSourceKey, source.stream(), {
          httpMetadata: { contentType: getSourceMimeType(sourceKind) },
          customMetadata: { title: resolvedTitle, ownerEmail: meta.owner_email, sourceKind },
        }),
      );
    }
    await Promise.all(r2Writes);
    await registry.updateDocument(id, {
      title: resolvedTitle,
      filename: nextSourceFilename || sourceFilename,
      size: file.size,
      rendered_filename: renderedFilename,
      source_filename: nextSourceFilename,
      source_kind: nextSourceKind,
      source_language: nextSourceLanguage,
    });

    const cleanupDeletes: Array<Promise<void>> = [];
    if (oldRenderedKey !== finalRenderedKey) {
      cleanupDeletes.push(c.env.DOCUMENTS_BUCKET.delete(oldRenderedKey));
    }
    if (oldSourceKey && oldSourceKey !== finalSourceKey) {
      cleanupDeletes.push(c.env.DOCUMENTS_BUCKET.delete(oldSourceKey));
    }
    await Promise.all(cleanupDeletes);
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
    filename: nextSourceFilename || sourceFilename,
    size: file.size,
    isShared: Boolean(meta.is_shared),
  });
});

api.get("/documents/:id/share", async (c) => {
  const id = c.req.param("id");
  const protectedResponse = await requireViewerBrowserCapability(c, id, { requireOrigin: false });
  if (protectedResponse) return protectedResponse;
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
  const protectedResponse = await requireViewerBrowserCapability(c, id);
  if (protectedResponse) return protectedResponse;

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
  const protectedResponse = await requireViewerBrowserCapability(c, id);
  if (protectedResponse) return protectedResponse;

  const registry = getRegistry(c.env);
  const meta = await registry.getDocument(id);

  if (!meta) {
    return c.json({ error: "not found" }, 404);
  }

  if (meta.owner_email !== c.get("authUser").email) {
    return c.json({ error: "forbidden" }, 403);
  }

  // Delete from R2 and registry in parallel
  const renderedFilename = meta.rendered_filename || meta.filename;
  const renderedKey = meta.rendered_filename
    ? getRenderedDocumentKey(id, renderedFilename)
    : getLegacyDocumentKey(id, renderedFilename);
  const sourceKey = meta.source_filename
    ? getSourceDocumentKey(id, meta.source_filename)
    : null;
  const deletes: Array<Promise<unknown>> = [
    c.env.DOCUMENTS_BUCKET.delete(renderedKey),
    registry.deleteDocument(id),
  ];
  if (sourceKey) {
    deletes.push(c.env.DOCUMENTS_BUCKET.delete(sourceKey));
  }
  await Promise.all(deletes);

  return c.json({ ok: true });
});

api.get("/documents/:id/comments", async (c) => {
  const id = c.req.param("id");
  const protectedResponse = await requireViewerBrowserCapability(c, id, { requireOrigin: false });
  if (protectedResponse) return protectedResponse;
  const email = c.get("authUser").email;
  const registry = getRegistry(c.env);
  const doc = await registry.getDocument(id);
  if (!doc) {
    return c.json({ error: "not found" }, 404);
  }

  // Shared users can view comments, not just the owner
  const isOwner = doc.owner_email === email;
  const isLinkShared = doc.is_shared === 1;
  const isEmailShared = doc.is_shared === 2 &&
    (await registry.getSharedEmails(id)).includes(email.toLowerCase());
  if (!isOwner && !isLinkShared && !isEmailShared) {
    return c.json({ error: "not found" }, 404);
  }

  const documentDoId = c.env.DOCUMENT_DO.idFromName(id);
  const documentDo = c.env.DOCUMENT_DO.get(documentDoId);
  const response = await documentDo.fetch(new Request(`http://do/${id}/comments`));
  if (!response.ok) {
    return c.json({ error: "failed to fetch comments" }, 500);
  }

  const data: unknown = await response.json();
  const comments = isRecord(data) && Array.isArray(data.comments) ? data.comments : [];

  return c.json({
    document: {
      id: doc.id,
      title: doc.title,
      filename: doc.filename,
      owner_email: doc.owner_email,
      is_shared: doc.is_shared,
    },
    comments,
  });
});

export { api };
