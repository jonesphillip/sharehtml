import { expect, type APIRequestContext, type FrameLocator, type Page } from "@playwright/test";

export const E2E_BASE_URL = "http://localhost:5173";

interface CreatedDocument {
  id: string;
  url: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCreatedDocument(value: unknown): CreatedDocument | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  if (typeof value.url !== "string") return null;
  if (typeof value.title !== "string") return null;
  return { id: value.id, url: value.url, title: value.title };
}

export async function createDocument(
  request: APIRequestContext,
  {
    filename,
    html,
    title,
  }: {
    filename: string;
    html: string;
    title?: string;
  },
) {
  const response = await request.post("/api/documents", {
    multipart: {
      file: {
        name: filename,
        mimeType: "text/html",
        buffer: Buffer.from(html, "utf8"),
      },
      ...(title ? { title } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
  const document = parseCreatedDocument(await response.json());
  expect(document).toBeTruthy();
  if (!document) {
    throw new Error("invalid create document response");
  }
  return document;
}

export async function updateDocument(
  request: APIRequestContext,
  {
    docId,
    filename,
    html,
    title,
  }: {
    docId: string;
    filename: string;
    html: string;
    title?: string;
  },
) {
  const response = await request.put(`/api/documents/${docId}`, {
    multipart: {
      file: {
        name: filename,
        mimeType: "text/html",
        buffer: Buffer.from(html, "utf8"),
      },
      ...(title ? { title } : {}),
    },
  });
  expect(response.ok()).toBeTruthy();
  const document = parseCreatedDocument(await response.json());
  expect(document).toBeTruthy();
  if (!document) {
    throw new Error("invalid update document response");
  }
  return document;
}

export async function deleteDocument(request: APIRequestContext, docId: string): Promise<void> {
  const response = await request.delete(`/api/documents/${docId}`);
  expect([200, 404]).toContain(response.status());
}

export async function openViewer(page: Page, docId: string) {
  await page.goto(`/d/${docId}`);
  await page.locator("#doc-iframe").waitFor();
  await page.locator("#name-input").fill("PJ");
  await page.locator("#name-submit").click();
  await expect(page.locator("#name-modal")).toBeHidden();
  return page.frameLocator("#doc-iframe");
}

export async function selectTextInIframe(
  frame: FrameLocator,
  {
    selector,
    startOffset = 0,
    endOffset,
    mobile = false,
  }: {
    selector: string;
    startOffset?: number;
    endOffset?: number;
    mobile?: boolean;
  },
) {
  await frame.locator(selector).evaluate(
    (element, payload) => {
      const textNode = element.firstChild;
      if (!(textNode instanceof Text)) {
        throw new Error("expected target element to have a text node");
      }
      const range = document.createRange();
      range.setStart(textNode, payload.startOffset);
      range.setEnd(textNode, payload.endOffset ?? textNode.textContent?.length ?? 0);
      const selection = window.getSelection();
      if (!selection) throw new Error("selection unavailable");
      selection.removeAllRanges();
      selection.addRange(range);
      if (payload.mobile) {
        document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
      } else {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      }
    },
    { startOffset, endOffset, mobile },
  );
}

export async function getCommentCountText(page: Page) {
  return page.locator("#comment-count").textContent();
}
