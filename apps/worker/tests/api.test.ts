import { exports } from "cloudflare:workers";

const html = "<html><body><h1>Hello</h1></body></html>";

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
    const doc = await uploadRes.json<{ id: string; title: string; filename: string; size: number }>();
    expect(doc.title).toBe("Test Doc");
    expect(doc.filename).toBe("test.html");
    expect(doc.id).toBeTruthy();

    const listRes = await exports.default.fetch("https://example.com/api/documents");
    expect(listRes.status).toBe(200);
    const list = await listRes.json<{ documents: { id: string }[] }>();
    expect(list.documents.some((d) => d.id === doc.id)).toBe(true);

    const metaRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}`);
    expect(metaRes.status).toBe(200);
    const meta = await metaRes.json<{ document: { id: string; title: string } }>();
    expect(meta.document.title).toBe("Test Doc");

    const rawRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/raw`);
    expect(rawRes.status).toBe(200);
    expect(await rawRes.text()).toBe(html);

    const deleteRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    const goneRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}`);
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
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("file is required");
  });

  it("derives title from filename when not provided", async () => {
    const res = await upload("quarterly-report.html", html);
    expect(res.status).toBe(200);
    const doc = await res.json<{ title: string }>();
    expect(doc.title).toBe("quarterly-report");
  });

  it("updates a document", async () => {
    const uploadRes = await upload("original.html", "<h1>v1</h1>", "Original");
    const doc = await uploadRes.json<{ id: string }>();

    const form = new FormData();
    form.append("file", new File(["<h1>v2</h1>"], "updated.html", { type: "text/html" }));
    form.append("title", "Updated");
    const updateRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}`, {
      method: "PUT",
      body: form,
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json<{ title: string; filename: string }>();
    expect(updated.title).toBe("Updated");
    expect(updated.filename).toBe("updated.html");

    const rawRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/raw`);
    expect(await rawRes.text()).toBe("<h1>v2</h1>");
  });

  it("returns 404 for nonexistent document", async () => {
    const res = await exports.default.fetch("https://example.com/api/documents/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns share state for a document", async () => {
    const uploadRes = await upload("share-test.html", html, "Share Test");
    const doc = await uploadRes.json<{ id: string }>();

    const res = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/share`);
    expect(res.status).toBe(200);
    const state = await res.json<{ mode: string; emails: string[] }>();
    expect(state.mode).toBe("link");
    expect(state.emails).toEqual([]);
  });

  it("rejects share updates when AUTH_MODE is not access", async () => {
    const uploadRes = await upload("share-reject.html", html);
    const doc = await uploadRes.json<{ id: string }>();

    const res = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/share`, {
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
    const doc = await res.json<{ id: string; filename: string }>();
    expect(doc.filename).toBe("hello.md");

    const sourceRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/source`);
    expect(sourceRes.status).toBe(200);
    expect(await sourceRes.text()).toBe(md);
    expect(sourceRes.headers.get("X-ShareHTML-Source-Kind")).toBe("markdown");

    const renderedRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/rendered`);
    expect(renderedRes.status).toBe(200);
    expect(await renderedRes.text()).toBe(rendered);

    const rawRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/raw`);
    expect(rawRes.status).toBe(200);
    expect(await rawRes.text()).toBe(md);
  });

  it("returns source unavailable for legacy uploads", async () => {
    const res = await upload("legacy.html", html, "Legacy");
    const doc = await res.json<{ id: string }>();

    const sourceRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/source`);
    expect(sourceRes.status).toBe(404);
    const body = await sourceRes.json<{ error: string }>();
    expect(body.error).toBe("source unavailable");

    const renderedRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/rendered`);
    expect(renderedRes.status).toBe(200);
    expect(await renderedRes.text()).toBe(html);
  });

  it("updates source on re-upload", async () => {
    const res = await uploadWithSource("doc.html", html, "doc.ts", "const v1 = 1;", "code");
    const doc = await res.json<{ id: string }>();

    const form = new FormData();
    form.append("file", new File(["<h1>v2</h1>"], "doc.html", { type: "text/html" }));
    form.append("source", new File(["const v2 = 2;"], "doc.ts", { type: "text/plain" }));
    form.append("sourceKind", "code");
    await exports.default.fetch(`https://example.com/api/documents/${doc.id}`, {
      method: "PUT",
      body: form,
    });

    const sourceRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/source`);
    expect(await sourceRes.text()).toBe("const v2 = 2;");

    const renderedRes = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/rendered`);
    expect(await renderedRes.text()).toBe("<h1>v2</h1>");
  });


  it("returns comments for a document", async () => {
    const uploadRes = await upload("comments-test.html", html, "Comments Test");
    const doc = await uploadRes.json<{ id: string }>();

    const res = await exports.default.fetch(`https://example.com/api/documents/${doc.id}/comments`);
    expect(res.status).toBe(200);
    const body = await res.json<{ document: { id: string; title: string }; comments: unknown[] }>();
    expect(body.document.id).toBe(doc.id);
    expect(body.document.title).toBe("Comments Test");
    expect(Array.isArray(body.comments)).toBe(true);
  });
});
