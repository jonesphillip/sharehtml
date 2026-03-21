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
});
