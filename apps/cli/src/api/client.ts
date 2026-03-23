import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { getAuthHeaders } from "../auth/access.js";
import { getConfig, isConfigured } from "../config/store.js";
import {
  defaultDocumentTitleFromFilename,
  getCodeLanguage,
  getSourceKind,
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
  rendered_filename?: string | null;
  source_filename?: string | null;
  source_kind?: string | null;
  source_language?: string | null;
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

export async function prepareDocumentUpload(
  filePath: string,
  title?: string,
): Promise<{
  renderedBlob: Blob;
  renderedFilename: string;
  sourceBlob: Blob;
  sourceFilename: string;
  sourceKind: string;
  sourceLanguage?: string;
}> {
  const fileBuffer = await readFile(filePath);
  const sourceFilename = basename(filePath);
  const sourceKind = getSourceKind(sourceFilename);
  const sourceLanguage = isCodeFile(sourceFilename) ? getCodeLanguage(sourceFilename) || undefined : undefined;
  const sourceMimeType = sourceKind === "html"
    ? "text/html"
    : sourceKind === "markdown"
    ? "text/markdown"
    : "text/plain";
  const sourceBlob = new Blob([fileBuffer], { type: sourceMimeType });

  let renderedFilename = sourceFilename;
  let renderedBlob: Blob;
  if (isMarkdownFile(sourceFilename)) {
    const mdText = fileBuffer.toString("utf-8");
    const mdTitle = title || defaultDocumentTitleFromFilename(sourceFilename);
    const html = renderMarkdownToHtml(mdText, mdTitle, filePath);
    renderedBlob = new Blob([html], { type: "text/html" });
    renderedFilename = renderedFilenameToHtml(sourceFilename);
  } else if (isCodeFile(sourceFilename)) {
    const codeText = fileBuffer.toString("utf-8");
    const codeTitle = title || defaultDocumentTitleFromFilename(sourceFilename);
    const html = renderCodeToHtml(codeText, codeTitle, sourceFilename);
    renderedBlob = new Blob([html], { type: "text/html" });
    renderedFilename = renderedFilenameToHtml(sourceFilename);
  } else {
    renderedBlob = new Blob([fileBuffer], { type: "text/html" });
  }

  return {
    renderedBlob,
    renderedFilename,
    sourceBlob,
    sourceFilename,
    sourceKind,
    sourceLanguage,
  };
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

function buildUploadFormData(
  prepared: Awaited<ReturnType<typeof prepareDocumentUpload>>,
  title?: string,
): FormData {
  const formData = new FormData();
  formData.append("file", prepared.renderedBlob, prepared.renderedFilename);
  formData.append("source", prepared.sourceBlob, prepared.sourceFilename);
  formData.append("sourceKind", prepared.sourceKind);
  if (prepared.sourceLanguage) {
    formData.append("sourceLanguage", prepared.sourceLanguage);
  }
  if (title) formData.append("title", title);
  return formData;
}

export async function deployDocument(
  filePath: string,
  title?: string,
): Promise<DeployResult> {
  const prepared = await prepareDocumentUpload(filePath, title);
  const resp = await requestWithAccess("Upload", {
    path: "/api/documents",
    method: "POST",
    body: buildUploadFormData(prepared, title),
  });
  return parseJson<DeployResult>(resp, "Upload");
}

export async function findDocumentByFilename(
  filename: string,
  match: "source" | "rendered" | "any" = "any",
): Promise<DocumentMeta | null> {
  const resp = await requestWithAccess("Lookup", {
    path:
      `/api/documents/by-filename?filename=${encodeURIComponent(filename)}&match=${encodeURIComponent(match)}`,
  });
  const data = await parseJson<{ document: DocumentMeta | null }>(resp, "Lookup");
  return data.document;
}

export async function getDocument(id: string): Promise<DocumentMeta> {
  const resp = await requestWithAccess("Fetch document", {
    path: `/api/documents/${id}`,
  });
  const data = await parseJson<{ document: DocumentMeta }>(resp, "Fetch document");
  return data.document;
}

export async function updateDocument(
  id: string,
  filePath: string,
  title?: string,
): Promise<DeployResult> {
  const prepared = await prepareDocumentUpload(filePath, title);
  const resp = await requestWithAccess("Update", {
    path: `/api/documents/${id}`,
    method: "PUT",
    body: buildUploadFormData(prepared, title),
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

function parseDownloadFilename(resp: Response, fallback: string): string {
  const disposition = resp.headers.get("Content-Disposition") || "";
  const match = disposition.match(/filename="(.+)"/);
  return match?.[1] || fallback;
}

export async function downloadDocument(
  id: string,
  format: "default" | "source" | "rendered" = "default",
): Promise<{ filename: string; content: Uint8Array }> {
  const path = format === "source"
    ? `/api/documents/${id}/source`
    : format === "rendered"
    ? `/api/documents/${id}/rendered`
    : `/api/documents/${id}/raw`;
  let resp: Response;
  try {
    resp = await requestWithAccess("Download", { path });
  } catch (error) {
    if (
      format === "source" &&
      error instanceof Error &&
      error.message.includes("source unavailable")
    ) {
      throw new Error(
        "Original source is not available for this document. Redeploy it once with a newer sharehtml CLI to enable source downloads.",
      );
    }
    throw error;
  }

  const filename = parseDownloadFilename(resp, `${id}.html`);
  const content = new Uint8Array(await resp.arrayBuffer());

  return { filename, content };
}

export async function downloadDocumentSource(id: string): Promise<{
  filename: string;
  content: Uint8Array;
  sourceKind: string;
  sourceLanguage: string;
}> {
  let resp: Response;
  try {
    resp = await requestWithAccess("Download source", {
      path: `/api/documents/${id}/source`,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("source unavailable")) {
      throw new Error("source unavailable");
    }
    throw error;
  }

  const filename = parseDownloadFilename(resp, `${id}.txt`);
  const content = new Uint8Array(await resp.arrayBuffer());
  const sourceKind = resp.headers.get("X-ShareHTML-Source-Kind") || "html";
  const sourceLanguage = resp.headers.get("X-ShareHTML-Source-Language") || "";

  return { filename, content, sourceKind, sourceLanguage };
}

export function getDocumentUrl(id: string): string {
  const { workerUrl } = getClient();
  return `${workerUrl}/d/${id}`;
}
