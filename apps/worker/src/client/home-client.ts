import "./home.css";

import { BROWSER_CAPABILITY_HEADER } from "../utils/security-constants.js";
import { isRecord } from "../types.js";
import {
  buildHomePath,
  formatDocumentSize,
  formatDocumentsResultsLabel,
  formatRelativeTime,
} from "../utils/home-view.js";

interface HomeDocumentSummary {
  id: string;
  title: string;
  filename: string;
  size: number;
  created_at: string;
}

interface HomeDocumentsResponse {
  documents?: HomeDocumentSummary[];
  totalCount?: number;
  page?: number;
  query?: string;
}

interface HomeClientConfig {
  page: number;
  pageSize: number;
  homeCapabilityToken: string;
}

interface HomeClientElements {
  form: HTMLFormElement;
  input: HTMLInputElement;
  list: HTMLDivElement;
  pagination: HTMLDivElement;
  meta: HTMLDivElement;
  setupTemplate: HTMLTemplateElement;
}

function parseHomeDocumentSummary(value: unknown): HomeDocumentSummary | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  if (typeof value.title !== "string") return null;
  if (typeof value.filename !== "string") return null;
  if (typeof value.size !== "number" || !Number.isFinite(value.size)) return null;
  if (typeof value.created_at !== "string") return null;

  return {
    id: value.id,
    title: value.title,
    filename: value.filename,
    size: value.size,
    created_at: value.created_at,
  };
}

function parseHomeDocumentsResponse(value: unknown): HomeDocumentsResponse | null {
  if (!isRecord(value)) return null;
  if ("page" in value && value.page !== undefined && typeof value.page !== "number") return null;
  if (
    "totalCount" in value && value.totalCount !== undefined &&
    typeof value.totalCount !== "number"
  ) {
    return null;
  }
  if ("query" in value && value.query !== undefined && typeof value.query !== "string") return null;
  if ("documents" in value && value.documents !== undefined && !Array.isArray(value.documents)) return null;

  const documents: HomeDocumentSummary[] = [];
  if (Array.isArray(value.documents)) {
    for (const document of value.documents) {
      const parsed = parseHomeDocumentSummary(document);
      if (!parsed) return null;
      documents.push(parsed);
    }
  }

  return {
    documents,
    totalCount: typeof value.totalCount === "number" ? value.totalCount : undefined,
    page: typeof value.page === "number" ? value.page : undefined,
    query: typeof value.query === "string" ? value.query : undefined,
  };
}

function getHomeClientConfig(): HomeClientConfig | null {
  const config = Reflect.get(window, "__HOME_CONFIG__");
  if (!isRecord(config)) return null;
  if (typeof config.page !== "number" || !Number.isFinite(config.page)) return null;
  if (typeof config.pageSize !== "number" || !Number.isFinite(config.pageSize)) return null;
  if (typeof config.homeCapabilityToken !== "string" || config.homeCapabilityToken.length === 0) {
    return null;
  }

  return {
    page: config.page,
    pageSize: config.pageSize,
    homeCapabilityToken: config.homeCapabilityToken,
  };
}

function getHomeClientElements(): HomeClientElements | null {
  const form = document.querySelector(".docs-search-form");
  const input = document.querySelector(".docs-search-input");
  const list = document.getElementById("documents-list");
  const pagination = document.getElementById("documents-pagination");
  const meta = document.getElementById("documents-meta");
  const setupTemplate = document.getElementById("documents-setup-template");

  if (!(form instanceof HTMLFormElement)) return null;
  if (!(input instanceof HTMLInputElement)) return null;
  if (!(list instanceof HTMLDivElement)) return null;
  if (!(pagination instanceof HTMLDivElement)) return null;
  if (!(meta instanceof HTMLDivElement)) return null;
  if (!(setupTemplate instanceof HTMLTemplateElement)) return null;

  return { form, input, list, pagination, meta, setupTemplate };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHomeDocumentsList(
  list: HTMLDivElement,
  setupTemplate: HTMLTemplateElement,
  documents: HomeDocumentSummary[],
  query: string,
): void {
  if (documents.length > 0) {
    list.innerHTML = documents.map((doc) => `
      <a class="doc-card" href="/d/${escapeHtml(doc.id)}">
        <div class="doc-card-top">
          <span class="doc-card-title">${escapeHtml(doc.title)}</span>
          <span class="doc-card-filename">${escapeHtml(doc.filename)}</span>
        </div>
        <div class="doc-card-bottom">
          <span class="doc-card-meta">${formatDocumentSize(doc.size)}</span>
          <span class="doc-card-meta">${formatRelativeTime(doc.created_at)}</span>
        </div>
      </a>
    `).join("");
    return;
  }

  if (query) {
    list.innerHTML = `<div class="section-empty">no documents match "${escapeHtml(query)}"</div>`;
    return;
  }

  list.innerHTML = setupTemplate.innerHTML;
}

function renderHomePagination(
  pagination: HTMLDivElement,
  pageSize: number,
  totalCount: number,
  page: number,
  query: string,
): void {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (totalCount === 0 || totalPages <= 1) {
    pagination.innerHTML = "";
    return;
  }

  let previous = '<div class="docs-pagination-spacer"></div>';
  if (page > 1) {
    previous =
      `<a class="docs-pagination-link" href="${buildHomePath(query, page - 1)}" data-page="${page - 1}">previous</a>`;
  }

  let next = '<div class="docs-pagination-spacer"></div>';
  if (page < totalPages) {
    next =
      `<a class="docs-pagination-link" href="${buildHomePath(query, page + 1)}" data-page="${page + 1}">next</a>`;
  }

  pagination.innerHTML = `
    ${previous}
    <div class="docs-pagination-status">page ${page} of ${totalPages}</div>
    ${next}
  `;
}

function renderHomeMeta(meta: HTMLDivElement, totalCount: number, query: string): void {
  meta.textContent = formatDocumentsResultsLabel(totalCount, query);
}

function updateHomeUrl(query: string, page: number): void {
  window.history.replaceState({}, "", buildHomePath(query, page));
}

function initHomeClient(): void {
  const config = getHomeClientConfig();
  if (!config) return;

  const elements = getHomeClientElements();
  if (!elements) return;

  const { form, input, list, pagination, meta, setupTemplate } = elements;

  let timer = 0;
  let requestId = 0;
  let currentQuery = input.value.trim();

  async function loadDocuments(query: string, page: number): Promise<void> {
    const nextRequestId = ++requestId;
    const searchParams = new URLSearchParams();
    if (query) searchParams.set("q", query);
    searchParams.set("page", String(page));
    searchParams.set("limit", String(config.pageSize));

    const response = await fetch(`/api/documents?${searchParams.toString()}`, {
      headers: {
        Accept: "application/json",
        [BROWSER_CAPABILITY_HEADER]: config.homeCapabilityToken,
      },
    });
    if (!response.ok) return;

    const data = parseHomeDocumentsResponse(await response.json());
    if (!data) return;
    if (nextRequestId !== requestId) return;

    currentQuery = data.query || "";
    const nextPage = data.page || 1;
    renderHomeDocumentsList(list, setupTemplate, data.documents || [], currentQuery);
    renderHomePagination(pagination, config.pageSize, data.totalCount || 0, nextPage, currentQuery);
    renderHomeMeta(meta, data.totalCount || 0, currentQuery);
    updateHomeUrl(currentQuery, nextPage);
  }

  function submitSearch(): void {
    const nextValue = input.value.trim();
    if (nextValue === currentQuery) return;
    void loadDocuments(nextValue, 1);
  }

  function handleSearchInput(): void {
    window.clearTimeout(timer);
    timer = window.setTimeout(submitSearch, 120);
  }

  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter") return;
    event.preventDefault();
    window.clearTimeout(timer);
    submitSearch();
  }

  function handleSearchSubmit(event: Event): void {
    event.preventDefault();
    window.clearTimeout(timer);
    submitSearch();
  }

  function handlePaginationClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    const link = target.closest("[data-page]");
    if (!(link instanceof HTMLAnchorElement)) return;

    const page = Number.parseInt(link.dataset.page || "", 10);
    if (!Number.isFinite(page) || page < 1) return;

    event.preventDefault();
    void loadDocuments(currentQuery, page);
  }

  input.addEventListener("input", handleSearchInput);
  input.addEventListener("keydown", handleSearchKeydown);
  form.addEventListener("submit", handleSearchSubmit);
  pagination.addEventListener("click", handlePaginationClick);
}

initHomeClient();
