import { basename } from "node:path";
import {
  findDocumentByFilename,
  listDocuments,
  setDocumentSharing,
} from "../api/client.js";
import { renderedFilenameToHtml } from "../utils/document-render.js";

interface ResolvedDocument {
  id: string;
  title: string;
  filename: string;
  isShared: boolean;
}

function getLookupFilename(reference: string): string {
  const filename = basename(reference);
  return renderedFilenameToHtml(filename);
}

export async function resolveDocumentReference(reference: string): Promise<ResolvedDocument | null> {
  const { documents } = await listDocuments();
  const byId = documents.find((document) => document.id === reference);
  if (byId) {
    return {
      id: byId.id,
      title: byId.title,
      filename: byId.filename,
      isShared: Boolean(byId.is_shared),
    };
  }

  const document = await findDocumentByFilename(getLookupFilename(reference));
  if (!document) {
    return null;
  }

  return {
    id: document.id,
    title: document.title,
    filename: document.filename,
    isShared: Boolean(document.is_shared),
  };
}

export async function updateDocumentSharing(reference: string, isShared: boolean): Promise<ResolvedDocument> {
  const document = await resolveDocumentReference(reference);
  if (!document) {
    throw new Error(`Document not found: ${reference}`);
  }

  const nextShared = await setDocumentSharing(document.id, isShared);
  return {
    ...document,
    isShared: nextShared,
  };
}
