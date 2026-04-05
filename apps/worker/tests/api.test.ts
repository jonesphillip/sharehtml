import { exports } from "cloudflare:workers";
import { isRecord } from "../src/types.js";

const html = "<html><body><h1>Hello</h1></body></html>";
const decoder = new TextDecoder();

async function readUtf8(response: Response) {
  return decoder.decode(await response.arrayBuffer());
}

function getRecord(value: unknown): Record<string, unknown> {
  expect(isRecord(value)).toBe(true);
  if (!isRecord(value)) {
    throw new Error("expected record");
  }
  return value;
}

function getStringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  expect(typeof field).toBe("string");
  if (typeof field !== "string") {
    throw new Error(`expected string field: ${key}`);
  }
  return field;
}

function getArrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = value[key];
  expect(Array.isArray(field)).toBe(true);
  if (!Array.isArray(field)) {
    throw new Error(`expected array field: ${key}`);
  }
  return field;
}

function upload(filename: string, content: string, title?: string) {
  const form = new FormData();
  form.append("file", new File([content], filename, { type: "text/html" }));
  if (title) form.append("title", title);
  return exports.default.fetch("https://example.com/api/documents", {
    method: "POST",
    body: form,
  });
}

function uploadWithSource(
  renderedFilename: string,
  renderedContent: string,
  sourceFilename: string,
  sourceContent: string,
  sourceKind: string,
  title?: string,
) {
  const form = new FormData();
  form.append("file", new File([renderedContent], renderedFilename, { type: "text/html" }));
  form.append("source", new File([sourceContent], sourceFilename, { type: "text/plain" }));
  form.append("sourceKind", sourceKind);
  if (title) form.append("title", title);
  return exports.default.fetch("https://example.com/api/documents", {
    method: "POST",
    body: form,
  });
}

describe("Document API", () => {
  it("uploads, lists, fetches, and deletes a document", async () => {
    const uploadRes = await upload("test.html", html, "Test Doc");
    expect(uploadRes.status).toBe(200);
    const doc = getRecord(await uploadRes.json());
    expect(getStringField(doc, "title")).toBe("Test Doc");
    expect(getStringField(doc, "filename")).toBe("test.html");
    const docId = getStringField(doc, "id");
    expect(docId).toBeTruthy();

    const listRes = await exports.default.fetch("https://example.com/api/documents");
    expect(listRes.status).toBe(200);
    const list = getRecord(await listRes.json());
    const documents = getArrayField(list, "documents")
      .map((entry) => getRecord(entry));
    expect(documents.some((entry) => getStringField(entry, "id") === docId)).toBe(true);

    const metaRes = await exports.default.fetch(`https://example.com/api/documents/${docId}`);
    expect(metaRes.status).toBe(200);
    const meta = getRecord(await metaRes.json());
    const metaDocument = getRecord(meta.document);
    expect(getStringField(metaDocument, "title")).toBe("Test Doc");

    const rawRes = await exports.default.fetch(`https://example.com/api/documents/${docId}/raw`);
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(rawRes.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await readUtf8(rawRes)).toBe(html);

    const deleteRes = await exports.default.fetch(`https://example.com/api/documents/${docId}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    const goneRes = await exports.default.fetch(`https://example.com/api/documents/${docId}`);
    expect(goneRes.status).toBe(404);
  });

  it("returns 400 when file is missing", async () => {
    const form = new FormData();
    form.append("title", "No file");
    const res = await exports.default.fetch("https://example.com/api/documents", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
    const body = getRecord(await res.json());
    expect(getStringField(body, "error")).toBe("file is required");
  });

  it("derives title from filename when not provided", async () => {
    const res = await upload("quarterly-report.html", html);
    expect(res.status).toBe(200);
    const doc = getRecord(await res.json());
    expect(getStringField(doc, "title")).toBe("quarterly-report");
  });

  it("updates a document", async () => {
    const uploadRes = await upload("original.html", "<h1>v1</h1>", "Original");
    const doc = getRecord(await uploadRes.json());
    const docId = getStringField(doc, "id");

    const form = new FormData();
    form.append("file", new File(["<h1>v2</h1>"], "updated.html", { type: "text/html" }));
    form.append("title", "Updated");
    const updateRes = await exports.default.fetch(`https://example.com/api/documents/${docId}`, {
      method: "PUT",
      body: form,
    });
    expect(updateRes.status).toBe(200);
    const updated = getRecord(await updateRes.json());
    expect(getStringField(updated, "title")).toBe("Updated");
    expect(getStringField(updated, "filename")).toBe("updated.html");

    const rawRes = await exports.default.fetch(`https://example.com/api/documents/${docId}/raw`);
    expect(rawRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await readUtf8(rawRes)).toBe("<h1>v2</h1>");
  });

  it("returns 404 for nonexistent document", async () => {
    const res = await exports.default.fetch("https://example.com/api/documents/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns share state for a document", async () => {
    const uploadRes = await upload("share-test.html", html, "Share Test");
    const doc = getRecord(await uploadRes.json());
    const docId = getStringField(doc, "id");

    const res = await exports.default.fetch(`https://example.com/api/documents/${docId}/share`);
    expect(res.status).toBe(200);
    const state = getRecord(await res.json());
    expect(getStringField(state, "mode")).toBe("link");
    expect(getArrayField(state, "emails")).toEqual([]);
  });

  it("rejects share updates when AUTH_MODE is not access", async () => {
    const uploadRes = await upload("share-reject.html", html);
    const doc = getRecord(await uploadRes.json());
    const docId = getStringField(doc, "id");

    const res = await exports.default.fetch(`https://example.com/api/documents/${docId}/share`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "private" }),
    });
    expect(res.status).toBe(400);
  });

  it("stores and retrieves source and rendered separately", async () => {
    const md = "# Hello\n\nWorld";
    const rendered = "<html><body><h1>Hello</h1><p>World</p></body></html>";
    const res = await uploadWithSource("hello.html", rendered, "hello.md", md, "markdown", "Hello");
    expect(res.status).toBe(200);
    const doc = getRecord(await res.json());
    const docId = getStringField(doc, "id");
    expect(getStringField(doc, "filename")).toBe("hello.md");

    const sourceRes = await exports.default.fetch(`https://example.com/api/documents/${docId}/source`);
    expect(sourceRes.status).toBe(200);
    expect(sourceRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await readUtf8(sourceRes)).toBe(md);
    expect(sourceRes.headers.get("X-ShareHTML-Source-Kind")).toBe("markdown");

    const renderedRes = await exports.default.fetch(`https://example.com/api/documents/${docId}/rendered`);
    expect(renderedRes.status).toBe(200);
    expect(renderedRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await readUtf8(renderedRes)).toBe(rendered);

    const rawRes = await exports.default.fetch(`https://example.com/api/documents/${docId}/raw`);
    expect(rawRes.status).toBe(200);
    expect(rawRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await readUtf8(rawRes)).toBe(md);
  });

  it("returns source unavailable for legacy uploads", async () => {
    const res = await upload("legacy.html", html, "Legacy");
    const doc = getRecord(await res.json());
    const docId = getStringField(doc, "id");

    const sourceRes = await exports.default.fetch(`https://example.com/api/documents/${docId}/source`);
    expect(sourceRes.status).toBe(404);
    const body = getRecord(await sourceRes.json());
    expect(getStringField(body, "error")).toBe("source unavailable");

    const renderedRes = await exports.default.fetch(`https://example.com/api/documents/${docId}/rendered`);
    expect(renderedRes.status).toBe(200);
    expect(renderedRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await readUtf8(renderedRes)).toBe(html);
  });

  it("updates source on re-upload", async () => {
    const res = await uploadWithSource("doc.html", html, "doc.ts", "const v1 = 1;", "code");
    const doc = getRecord(await res.json());
    const docId = getStringField(doc, "id");

    const form = new FormData();
    form.append("file", new File(["<h1>v2</h1>"], "doc.html", { type: "text/html" }));
    form.append("source", new File(["const v2 = 2;"], "doc.ts", { type: "text/plain" }));
    form.append("sourceKind", "code");
    await exports.default.fetch(`https://example.com/api/documents/${docId}`, {
      method: "PUT",
      body: form,
    });

    const sourceRes = await exports.default.fetch(`https://example.com/api/documents/${docId}/source`);
    expect(sourceRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await readUtf8(sourceRes)).toBe("const v2 = 2;");

    const renderedRes = await exports.default.fetch(`https://example.com/api/documents/${docId}/rendered`);
    expect(renderedRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(await readUtf8(renderedRes)).toBe("<h1>v2</h1>");
  });


  it("returns comments for a document", async () => {
    const uploadRes = await upload("comments-test.html", html, "Comments Test");
    const doc = getRecord(await uploadRes.json());
    const docId = getStringField(doc, "id");

    const res = await exports.default.fetch(`https://example.com/api/documents/${docId}/comments`);
    expect(res.status).toBe(200);
    const body = getRecord(await res.json());
    const document = getRecord(body.document);
    expect(getStringField(document, "id")).toBe(docId);
    expect(getStringField(document, "title")).toBe("Comments Test");
    expect(Array.isArray(body.comments)).toBe(true);
  });
});
