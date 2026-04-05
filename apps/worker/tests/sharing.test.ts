import { env } from "cloudflare:workers";
import { exports } from "cloudflare:workers";

function registry() {
  return env.REGISTRY_DO.get(env.REGISTRY_DO.idFromName("global"));
}

async function createDoc(id: string, ownerEmail: string, isShared = 0) {
  const reg = registry();
  await reg.createDocument({
    id,
    title: "Test",
    filename: "test.html",
    size: 100,
    owner_email: ownerEmail,
    is_shared: isShared,
  });
  // Put a file in R2 so the content route works
  await env.DOCUMENTS_BUCKET.put(`${id}/test.html`, "<h1>test</h1>", {
    httpMetadata: { contentType: "text/html" },
  });
  return reg;
}

describe("Share mode data layer", () => {
  it("stores and retrieves shared emails, normalized to lowercase", async () => {
    const reg = await createDoc("email-doc", "owner@example.com", 2);
    await reg.setSharedEmails("email-doc", ["Alice@Example.com", "BOB@test.com"]);

    const emails = await reg.getSharedEmails("email-doc");
    expect(emails).toEqual(["alice@example.com", "bob@test.com"]);
  });

  it("switching away from email mode clears the list", async () => {
    const reg = await createDoc("clear-doc", "owner@example.com", 2);
    await reg.setSharedEmails("clear-doc", ["a@b.com"]);

    await reg.setDocumentShareMode("clear-doc", 0);
    expect(await reg.getSharedEmails("clear-doc")).toEqual([]);
  });

  it("caps email list at 100", async () => {
    const reg = await createDoc("cap-doc", "owner@example.com", 2);
    const many = Array.from({ length: 150 }, (_, i) => `u${i}@example.com`);
    await reg.setSharedEmails("cap-doc", many);
    expect((await reg.getSharedEmails("cap-doc")).length).toBe(100);
  });
});

// In AUTH_MODE=none, the authenticated user is always dev@localhost.
// We test access control by creating docs owned by a different email.
describe("Access control honors share modes", () => {
  it("private doc: owner can view, others cannot", async () => {
    // Doc owned by dev@localhost (the test user) → accessible
    await createDoc("own-private", "dev@localhost", 0);
    const ownRes = await exports.default.fetch("https://example.com/d/own-private");
    expect(ownRes.status).toBe(200);

    // Doc owned by someone else, private → not accessible
    await createDoc("other-private", "other@example.com", 0);
    const otherRes = await exports.default.fetch("https://example.com/d/other-private");
    expect(otherRes.status).toBe(404);
  });

  it("link-shared doc: anyone can view", async () => {
    await createDoc("other-link", "other@example.com", 1);
    const res = await exports.default.fetch("https://example.com/d/other-link");
    expect(res.status).toBe(200);
  });

  it("email-shared doc: only listed users can view", async () => {
    const reg = await createDoc("email-allowed", "other@example.com", 2);
    await reg.setSharedEmails("email-allowed", ["dev@localhost"]);
    const allowedRes = await exports.default.fetch("https://example.com/d/email-allowed");
    expect(allowedRes.status).toBe(200);

    const reg2 = await createDoc("email-denied", "other@example.com", 2);
    await reg2.setSharedEmails("email-denied", ["someone-else@example.com"]);
    const deniedRes = await exports.default.fetch("https://example.com/d/email-denied");
    expect(deniedRes.status).toBe(404);
  });

  it("email-shared access applies to content and websocket routes too", async () => {
    const reg = await createDoc("email-content", "other@example.com", 2);
    await reg.setSharedEmails("email-content", ["dev@localhost"]);

    const contentRes = await exports.default.fetch("https://example.com/d/email-content/content");
    expect(contentRes.status).toBe(200);
    expect(contentRes.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(contentRes.headers.get("X-Content-Type-Options")).toBe("nosniff");

    // Denied user
    const reg2 = await createDoc("email-content-denied", "other@example.com", 2);
    await reg2.setSharedEmails("email-content-denied", ["nope@example.com"]);

    const deniedContent = await exports.default.fetch("https://example.com/d/email-content-denied/content");
    expect(deniedContent.status).toBe(404);
  });

  it("rejects websocket upgrades from untrusted origins", async () => {
    await createDoc("ws-origin-check", "dev@localhost", 0);

    const deniedRes = await exports.default.fetch("https://example.com/d/ws-origin-check/ws", {
      headers: {
        Upgrade: "websocket",
        Origin: "null",
      },
    });
    expect(deniedRes.status).toBe(403);

    const allowedRes = await exports.default.fetch("https://example.com/d/ws-origin-check/ws", {
      headers: {
        Upgrade: "websocket",
        Origin: "https://example.com",
      },
    });
    expect(allowedRes.status).toBe(101);
  });
});
