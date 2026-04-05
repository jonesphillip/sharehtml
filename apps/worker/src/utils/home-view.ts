export function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr + "Z").getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatDocumentSize(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

export function buildHomePath(query: string, page: number): string {
  const params = new URLSearchParams();
  if (query) {
    params.set("q", query);
  }
  if (page > 1) {
    params.set("page", String(page));
  }

  const search = params.toString();
  if (!search) {
    return "/";
  }

  return `/?${search}`;
}

export function formatDocumentsResultsLabel(totalCount: number, query: string): string {
  if (query) {
    return `${totalCount} match${totalCount === 1 ? "" : "es"}`;
  }

  return `${totalCount} document${totalCount === 1 ? "" : "s"}`;
}
