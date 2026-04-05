function sanitizeDownloadFilename(filename: string): string {
  return filename
    .replace(/[\r\n"]/g, "_")
    .replace(/[\\/]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
}

export function createAttachmentHeaders(
  filename: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${sanitizeDownloadFilename(filename)}"`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...extraHeaders,
  };
}
