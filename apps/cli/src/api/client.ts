import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getAuthHeaders } from "../auth/access.js";
import { getConfig, isConfigured } from "../config/store.js";
import {
  defaultDocumentTitleFromFilename,
  isCodeFile,
  isMarkdownFile,
  renderCodeToHtml,
  renderedFilenameToHtml,
  renderMarkdownToHtml,
} from "../utils/document-render.js";

interface DeployResult {
  id: string;
  url: string;
  title: string;
  filename: string;
  size: number;
  isShared: boolean;
}

interface DocumentMeta {
  id: string;
  title: string;
  filename: string;
  size: number;
  owner_email: string;
  is_shared?: number;
  created_at: string;
}

interface AuthContext {
  canLogin: boolean;
  headers: Record<string, string>;
}

interface RequestOptions extends RequestInit {
  path: string;
}

function getClient(): { workerUrl: string } {
  if (!isConfigured()) {
    throw new Error("Not configured. Run: sharehtml config set-url <url>");
  }
  return getConfig();
}

async function prepareUpload(
  filePath: string,
  title?: string,
): Promise<{ blob: Blob; filename: string }> {
  const fileBuffer = await readFile(filePath);
  let filename = basename(filePath);

  let blob: Blob;
  if (isMarkdownFile(filename)) {
    const mdText = fileBuffer.toString("utf-8");
    const mdTitle = title || defaultDocumentTitleFromFilename(filename);
    const html = renderMarkdownToHtml(mdText, mdTitle, filePath);
    blob = new Blob([html], { type: "text/html" });
    filename = renderedFilenameToHtml(filename);
  } else if (isCodeFile(filename)) {
    const codeText = fileBuffer.toString("utf-8");
    const codeTitle = title || defaultDocumentTitleFromFilename(filename);
    const html = renderCodeToHtml(codeText, codeTitle, filename);
    blob = new Blob([html], { type: "text/html" });
    filename = renderedFilenameToHtml(filename);
  } else {
    blob = new Blob([fileBuffer], { type: "text/html" });
  }

  return { blob, filename };
}

function getLoginErrorMessage(canLogin: boolean): string {
  if (canLogin) {
    return "Authentication required. Run: sharehtml login";
  }
  return "Authentication required. Install cloudflared and run: sharehtml login";
}

async function checkResponse(
  resp: Response,
  action: string,
  authContext: AuthContext,
): Promise<void> {
  const location = resp.headers.get("location") || "";
  if (resp.status >= 300 && resp.status < 400) {
    if (location.includes("cloudflareaccess.com") || location.includes("/cdn-cgi/access/login")) {
      throw new Error(getLoginErrorMessage(authContext.canLogin));
    }
  }

  if (resp.ok) return;

  if (resp.status === 401 || resp.status === 403) {
    const body = await resp.text().catch(() => "");
    const contentType = resp.headers.get("content-type") || "";
    const lowerBody = body.toLowerCase();

    if (
      contentType.includes("text/html") ||
      lowerBody.includes("cloudflareaccess.com") ||
      lowerBody.includes("cf-access") ||
      lowerBody.includes("unauthorized")
    ) {
      throw new Error(getLoginErrorMessage(authContext.canLogin));
    }

    throw new Error(`${action} failed (${resp.status}): ${body || "Authentication required"}`);
  }

  const body = await resp.text();
  throw new Error(`${action} failed (${resp.status}): ${body}`);
}

async function parseJson<T>(resp: Response, action: string): Promise<T> {
  const text = await resp.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${action}: unexpected response: ${text.slice(0, 200)}`);
  }
}

async function requestWithAccess(
  action: string,
  options: RequestOptions,
): Promise<Response> {
  const { workerUrl } = getClient();
  const auth = await getAuthHeaders(workerUrl);
  const resp = await fetch(`${workerUrl}${options.path}`, {
    ...options,
    headers: auth.headers,
    redirect: "manual",
  });

  await checkResponse(resp, action, auth);
  return resp;
}

export async function deployDocument(
  filePath: string,
  title?: string,
): Promise<DeployResult> {
  const { blob, filename } = await prepareUpload(filePath, title);

  const formData = new FormData();
  formData.append("file", blob, filename);
  if (title) formData.append("title", title);

  const resp = await requestWithAccess("Upload", {
    path: "/api/documents",
    method: "POST",
    body: formData,
  });
  return parseJson<DeployResult>(resp, "Upload");
}

export async function findDocumentByFilename(filename: string): Promise<DocumentMeta | null> {
  const resp = await requestWithAccess("Lookup", {
    path: `/api/documents/by-filename?filename=${encodeURIComponent(filename)}`,
  });
  const data = await parseJson<{ document: DocumentMeta | null }>(resp, "Lookup");
  return data.document;
}

export async function updateDocument(
  id: string,
  filePath: string,
  title?: string,
): Promise<DeployResult> {
  const { blob, filename } = await prepareUpload(filePath, title);

  const formData = new FormData();
  formData.append("file", blob, filename);
  if (title) formData.append("title", title);

  const resp = await requestWithAccess("Update", {
    path: `/api/documents/${id}`,
    method: "PUT",
    body: formData,
  });
  return parseJson<DeployResult>(resp, "Update");
}

export async function listDocuments(): Promise<{ documents: DocumentMeta[] }> {
  const resp = await requestWithAccess("List", {
    path: "/api/documents",
  });
  return parseJson<{ documents: DocumentMeta[] }>(resp, "List");
}

export async function deleteDocument(id: string): Promise<void> {
  await requestWithAccess("Delete", {
    path: `/api/documents/${id}`,
    method: "DELETE",
  });
}

type ShareMode = "private" | "link" | "emails";
type ShareOptions = { mode: "private" } | { mode: "link" } | { mode: "emails"; emails: string[] };
type ShareState = { mode: ShareMode; emails: string[] };

export async function setDocumentSharing(id: string, options: ShareOptions): Promise<ShareState> {
  const resp = await requestWithAccess("Update sharing", {
    path: `/api/documents/${id}/share`,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  return parseJson<ShareState>(resp, "Update sharing");
}

export async function getDocumentSharing(id: string): Promise<ShareState> {
  const resp = await requestWithAccess("Get sharing", {
    path: `/api/documents/${id}/share`,
  });
  return parseJson<ShareState>(resp, "Get sharing");
}

export async function downloadDocument(id: string): Promise<{ filename: string; content: Uint8Array }> {
  const resp = await requestWithAccess("Download", {
    path: `/api/documents/${id}/raw`,
  });

  const disposition = resp.headers.get("Content-Disposition") || "";
  const filenameMatch = disposition.match(/filename="(.+)"/);
  const filename = filenameMatch?.[1] || `${id}.html`;
  const content = new Uint8Array(await resp.arrayBuffer());

  return { filename, content };
}

export function getDocumentUrl(id: string): string {
  const { workerUrl } = getClient();
  return `${workerUrl}/d/${id}`;
}
