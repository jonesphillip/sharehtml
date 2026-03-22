import { createInterface } from "node:readline";
import { Command } from "commander";
import { getDocumentSharing, getDocumentUrl, setDocumentSharing } from "../api/client.js";
import { deploymentRequiresLogin } from "../auth/capabilities.js";
import { resolveDocumentReference } from "./share-utils.js";

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) =>
    rl.question(question + " (y/N) ", (a) => {
      rl.close();
      r(a.trim().toLowerCase() === "y");
    }),
  );
}

export const shareCmd = new Command("share")
  .description("Make a document shareable")
  .argument("<document>", "Document id or filename")
  .option("--link", "Share with anyone who has the link (skip prompt)")
  .option("--add <email>", "Add an email to the share list")
  .option("--remove <email>", "Remove an email from the share list")
  .action(async (document: string, opts: { link?: boolean; add?: string; remove?: string }) => {
    try {
      if (!(await deploymentRequiresLogin())) {
        throw new Error("This deployment already allows link access to all documents.");
      }

      const doc = await resolveDocumentReference(document);
      if (!doc) throw new Error(`Document not found: ${document}`);

      if (opts.add) {
        const addEmail = opts.add.toLowerCase().trim();
        const state = await getDocumentSharing(doc.id);
        const emails = [...new Set([...state.emails, addEmail])];
        const result = await setDocumentSharing(doc.id, { mode: "emails", emails });
        if (!result.emails.includes(addEmail)) {
          console.log(`${addEmail} already has access as the owner`);
        } else {
          console.log(`Added ${addEmail}: ${doc.title}`);
        }
        if (result.emails.length > 0) {
          console.log(`  shared with: ${result.emails.join(", ")}`);
        }
        return;
      }

      if (opts.remove) {
        const removeEmail = opts.remove.toLowerCase().trim();
        const state = await getDocumentSharing(doc.id);
        const emails = state.emails.filter((e) => e !== removeEmail);
        const result = await setDocumentSharing(doc.id, { mode: "emails", emails });
        console.log(`Removed ${removeEmail}: ${doc.title}`);
        if (result.emails.length > 0) {
          console.log(`  shared with: ${result.emails.join(", ")}`);
        }
        return;
      }

      // Default: link-share. Prompt if switching away from email mode.
      if (!opts.link) {
        const state = await getDocumentSharing(doc.id);
        if (state.mode === "emails" && state.emails.length > 0) {
          console.log(`This document is shared with ${state.emails.length} ${state.emails.length === 1 ? "person" : "people"}:`);
          for (const email of state.emails) {
            console.log(`  - ${email}`);
          }
          const yes = await confirm("Switch to link sharing? This will remove the email list.");
          if (!yes) {
            console.log("Cancelled.");
            return;
          }
        }
      }

      await setDocumentSharing(doc.id, { mode: "link" });
      console.log(`Shared: ${doc.title}`);
      console.log(`  id:  ${doc.id}`);
      console.log(`  url: ${getDocumentUrl(doc.id)}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
