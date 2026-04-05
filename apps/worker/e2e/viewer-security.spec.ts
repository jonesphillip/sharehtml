import { expect, test } from "@playwright/test";
import {
  createDocument,
  deleteDocument,
  E2E_BASE_URL,
  getCommentCountText,
  openViewer,
  selectTextInIframe,
  updateDocument,
} from "./helpers";

test.describe("viewer security", () => {
  let createdDocIds: string[] = [];

  test.beforeEach(() => {
    createdDocIds = [];
  });

  test.afterEach(async ({ request }) => {
    await Promise.all(createdDocIds.map(async function cleanupDocument(docId) {
      await deleteDocument(request, docId);
    }));
  });

  test("ignores hostile iframe mutation messages", async ({ page, request }) => {
    const doc = await createDocument(request, {
      filename: "hostile.html",
      title: "Hostile",
      html: `<!doctype html>
        <html>
          <body>
            <p id="target">Cheddar cheese</p>
            <script>
              const spam = () => {
                parent.postMessage({
                  type: "comment:start",
                  text: "Cheddar",
                  content: "pwned",
                  pixelY: 12,
                  anchor: { selectors: [{ type: "TextQuoteSelector", exact: "Cheddar" }] }
                }, "*");
                parent.postMessage({
                  type: "reaction:add",
                  emoji: "🔥",
                  anchor: { selectors: [{ type: "TextQuoteSelector", exact: "Cheddar" }] }
                }, "*");
              };
              spam();
              setTimeout(spam, 150);
              setTimeout(spam, 300);
            </script>
          </body>
        </html>`,
    });
    createdDocIds.push(doc.id);

    await openViewer(page, doc.id);
    await expect(page.frameLocator("#doc-iframe").locator("#target")).toBeVisible();
    await page.waitForTimeout(700);

    await expect(page.locator(".comment-card")).toHaveCount(0);
    await expect(page.locator(".reaction-card")).toHaveCount(0);
    await expect.poll(() => getCommentCountText(page)).toContain("0 annotation");

    const commentsResponse = await request.get(`/api/documents/${doc.id}/comments`);
    expect(commentsResponse.ok()).toBeTruthy();
    const commentsBody = await commentsResponse.json();
    expect(typeof commentsBody).toBe("object");
    expect(commentsBody).not.toBeNull();
    const comments = commentsBody && typeof commentsBody === "object" && "comments" in commentsBody
      ? commentsBody.comments
      : null;
    expect(Array.isArray(comments)).toBe(true);
    expect(comments).toHaveLength(0);
  });

  test("creates a comment only through the parent-owned selection tooltip", async ({ page, request }) => {
    const doc = await createDocument(request, {
      filename: "basic.html",
      title: "Basic",
      html: `<!doctype html>
        <html>
          <body>
            <p id="target">Cheddar cheese</p>
          </body>
        </html>`,
    });
    createdDocIds.push(doc.id);

    const frame = await openViewer(page, doc.id);
    await expect(frame.locator("#target")).toBeVisible();
    await selectTextInIframe(frame, {
      selector: "#target",
      startOffset: 0,
      endOffset: 7,
    });

    const toolbar = page.locator(".selection-toolbar-overlay");
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole("button", { name: /comment/i }).click();

    const compose = page.locator(".compose-form");
    await expect(compose).toBeVisible();
    await page.locator(".compose-textarea").fill("Need to pick this up.");
    await page.getByRole("button", { name: /^comment$/ }).click();

    await expect(page.locator(".comment-card")).toHaveCount(1);
    await expect(page.locator(".comment-body")).toContainText("Need to pick this up.");

    await page.reload();
    await expect(page.locator("#name-modal")).toBeHidden();
    await expect(page.locator(".comment-body")).toContainText("Need to pick this up.");
  });

  test("hostile iframe cannot open its own privileged websocket", async ({ page, request }) => {
    const doc = await createDocument(request, {
      filename: "socket-hostile.html",
      title: "Socket Hostile",
      html: "<!doctype html><html><body><p>placeholder</p></body></html>",
    });
    createdDocIds.push(doc.id);

    await updateDocument(request, {
      docId: doc.id,
      filename: "socket-hostile.html",
      html: `<!doctype html>
        <html>
          <body data-ws-status="pending">
            <p id="target">Socket attempt</p>
            <script>
              const ws = new WebSocket("ws://localhost:5173/d/${doc.id}/ws");
              ws.addEventListener("open", () => {
                document.body.dataset.wsStatus = "open";
              });
              ws.addEventListener("error", () => {
                document.body.dataset.wsStatus = "error";
              });
              ws.addEventListener("close", () => {
                if (document.body.dataset.wsStatus === "pending") {
                  document.body.dataset.wsStatus = "closed";
                }
              });
              setTimeout(() => {
                if (document.body.dataset.wsStatus === "pending") {
                  document.body.dataset.wsStatus = "timeout";
                }
              }, 1000);
            </script>
          </body>
        </html>`,
    });

    const frame = await openViewer(page, doc.id);
    await expect(frame.locator("body")).toHaveAttribute("data-ws-status", /error|closed|timeout/);
    await expect(frame.locator("body")).not.toHaveAttribute("data-ws-status", "open");
  });

  test("hostile iframe cannot read multiple sensitive endpoints", async ({ page, request }) => {
    const victim = await createDocument(request, {
      filename: "victim.html",
      title: "Victim",
      html: "<!doctype html><html><body><p>victim</p></body></html>",
    });
    createdDocIds.push(victim.id);
    const attacker = await createDocument(request, {
      filename: "fetch-hostile.html",
      title: "Fetch Hostile",
      html: `<!doctype html>
        <html>
          <body data-probe-status="pending">
            <pre id="probe-results"></pre>
            <script>
              (async () => {
                const probes = [
                  { name: "meta", url: "${E2E_BASE_URL}/api/documents/${victim.id}" },
                  { name: "comments", url: "${E2E_BASE_URL}/api/documents/${victim.id}/comments" },
                  { name: "raw", url: "${E2E_BASE_URL}/api/documents/${victim.id}/raw" },
                  { name: "content", url: "${E2E_BASE_URL}/d/${victim.id}/content" }
                ];
                const results = [];
                for (const probe of probes) {
                  try {
                    const response = await fetch(probe.url, { credentials: "include" });
                    const text = await response.text();
                    results.push({
                      name: probe.name,
                      outcome: "readable",
                      status: response.status,
                      preview: text.slice(0, 40),
                    });
                  } catch (error) {
                    results.push({
                      name: probe.name,
                      outcome: "blocked",
                      message: error instanceof Error ? error.message : String(error),
                    });
                  }
                }
                document.getElementById("probe-results").textContent = JSON.stringify(results);
                document.body.dataset.probeStatus = "done";
              })();
            </script>
          </body>
        </html>`,
    });
    createdDocIds.push(attacker.id);

    const frame = await openViewer(page, attacker.id);
    await expect(frame.locator("body")).toHaveAttribute("data-probe-status", "done");
    const results: unknown = JSON.parse(await frame.locator("#probe-results").textContent() || "[]");
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(4);
    for (const result of results as unknown[]) {
      expect(result).toHaveProperty("outcome", "blocked");
      expect(result).not.toHaveProperty("status");
    }
  });

  test("hostile iframe cannot blind-write update delete or share mutations", async ({ page, request }) => {
    const victim = await createDocument(request, {
      filename: "victim-write.html",
      title: "Victim Original",
      html: "<!doctype html><html><body><p>original victim</p></body></html>",
    });
    createdDocIds.push(victim.id);
    const attacker = await createDocument(request, {
      filename: "write-hostile.html",
      title: "Write Hostile",
      html: "<!doctype html><html><body><p>placeholder</p></body></html>",
    });
    createdDocIds.push(attacker.id);

    await updateDocument(request, {
      docId: attacker.id,
      filename: "write-hostile.html",
      html: `<!doctype html>
        <html>
          <body data-mutation-status="pending">
            <pre id="mutation-results"></pre>
            <script>
              (async () => {
                const results = [];

                try {
                  const form = new FormData();
                  form.append("file", new File(["<h1>owned</h1>"], "owned.html", { type: "text/html" }));
                  form.append("title", "Owned");
                  await fetch("${E2E_BASE_URL}/api/documents/${victim.id}", {
                    method: "PUT",
                    body: form,
                    credentials: "include",
                  });
                  results.push({ name: "update", outcome: "resolved" });
                } catch (error) {
                  results.push({ name: "update", outcome: "blocked", message: String(error) });
                }

                try {
                  await fetch("${E2E_BASE_URL}/api/documents/${victim.id}", {
                    method: "DELETE",
                    credentials: "include",
                  });
                  results.push({ name: "delete", outcome: "resolved" });
                } catch (error) {
                  results.push({ name: "delete", outcome: "blocked", message: String(error) });
                }

                try {
                  await fetch("${E2E_BASE_URL}/api/documents/${victim.id}/share", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ mode: "private" }),
                    credentials: "include",
                  });
                  results.push({ name: "share", outcome: "resolved" });
                } catch (error) {
                  results.push({ name: "share", outcome: "blocked", message: String(error) });
                }

                document.getElementById("mutation-results").textContent = JSON.stringify(results);
                document.body.dataset.mutationStatus = "done";
              })();
            </script>
          </body>
        </html>`,
    });

    const frame = await openViewer(page, attacker.id);
    await expect(frame.locator("body")).toHaveAttribute("data-mutation-status", "done");
    const results: unknown = JSON.parse(await frame.locator("#mutation-results").textContent() || "[]");
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(3);
    for (const result of results as unknown[]) {
      expect(result).toHaveProperty("outcome", "blocked");
    }

    const metaResponse = await request.get(`/api/documents/${victim.id}`);
    expect(metaResponse.ok()).toBeTruthy();
    const metaBody = await metaResponse.json();
    expect(typeof metaBody).toBe("object");
    expect(metaBody).not.toBeNull();
    const document = metaBody && typeof metaBody === "object" && "document" in metaBody
      ? metaBody.document
      : null;
    expect(typeof document).toBe("object");
    expect(document).not.toBeNull();
    const title = document && typeof document === "object" && "title" in document
      ? document.title
      : null;
    expect(title).toBe("Victim Original");

    const rawResponse = await request.get(`/api/documents/${victim.id}/raw`);
    expect(rawResponse.ok()).toBeTruthy();
    expect(await rawResponse.text()).toContain("original victim");

    const shareResponse = await request.get(`/api/documents/${victim.id}/share`);
    expect(shareResponse.ok()).toBeTruthy();
    const shareBody = await shareResponse.json();
    expect(typeof shareBody).toBe("object");
    expect(shareBody).not.toBeNull();
    const mode = shareBody && typeof shareBody === "object" && "mode" in shareBody
      ? shareBody.mode
      : null;
    expect(mode).toBe("link");
  });

  test("direct content route remains attachment-only", async ({ request }) => {
    const doc = await createDocument(request, {
      filename: "content-route.html",
      title: "Content Route",
      html: "<!doctype html><html><body><p>content route</p></body></html>",
    });
    createdDocIds.push(doc.id);

    const response = await request.get(`/d/${doc.id}/content`);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()["content-type"]).toBe("application/octet-stream");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    expect(response.headers()["content-disposition"]).toContain("attachment;");
  });
});
