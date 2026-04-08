import { shareModeFromInt, type AppBindings, type DocumentRow } from "../types.js";
import { emailsMatch, normalizeEmail } from "./email.js";
import { getRegistry } from "./registry.js";

export function canViewDocument(
  doc: Pick<DocumentRow, "owner_email" | "is_shared">,
  email: string,
  sharedEmails?: string[],
): boolean {
  const normalizedEmail = normalizeEmail(email);
  if (emailsMatch(doc.owner_email, normalizedEmail)) return true;

  switch (shareModeFromInt(doc.is_shared)) {
    case "link":
      return true;
    case "emails":
      return sharedEmails?.includes(normalizedEmail) ?? false;
    case "private":
    default:
      return false;
  }
}

export async function loadDocWithAccessCheck(
  env: AppBindings["Bindings"],
  id: string,
  email: string,
): Promise<{ doc: DocumentRow; registry: ReturnType<typeof getRegistry> } | null> {
  const registry = getRegistry(env);
  const doc = await registry.getDocument(id);
  if (!doc) return null;

  const sharedEmails = shareModeFromInt(doc.is_shared) === "emails"
    ? await registry.getSharedEmails(id)
    : undefined;
  if (!canViewDocument(doc, email, sharedEmails)) return null;

  return { doc, registry };
}
