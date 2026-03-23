import type { DocumentRow } from "../types.js";

export function getLegacyDocumentKey(id: string, filename: string): string {
  return `${id}/${filename}`;
}

export function getRenderedDocumentKey(id: string, filename: string): string {
  return `${id}/rendered/${filename}`;
}

export function getSourceDocumentKey(id: string, filename: string): string {
  return `${id}/source/${filename}`;
}

export async function getRenderedObject(
  bucket: R2Bucket,
  id: string,
  doc: Pick<DocumentRow, "filename" | "rendered_filename">,
): Promise<R2ObjectBody | null> {
  const renderedFilename = doc.rendered_filename || doc.filename;
  const preferredKey = doc.rendered_filename
    ? getRenderedDocumentKey(id, renderedFilename)
    : getLegacyDocumentKey(id, renderedFilename);

  const preferredObject = await bucket.get(preferredKey);
  if (preferredObject) {
    return preferredObject;
  }

  if (preferredKey !== getLegacyDocumentKey(id, renderedFilename)) {
    return bucket.get(getLegacyDocumentKey(id, renderedFilename));
  }

  return null;
}

export async function getSourceObject(
  bucket: R2Bucket,
  id: string,
  doc: Pick<DocumentRow, "source_filename">,
): Promise<R2ObjectBody | null> {
  if (!doc.source_filename) {
    return null;
  }

  return bucket.get(getSourceDocumentKey(id, doc.source_filename));
}
