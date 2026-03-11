import { Command } from "commander";
import { getDocumentUrl } from "../api/client.js";
import { deploymentRequiresLogin } from "../auth/capabilities.js";
import { updateDocumentSharing } from "./share-utils.js";

export const unshareCmd = new Command("unshare")
  .description("Make a document private again")
  .argument("<document>", "Document id or filename")
  .action(async (document: string) => {
    try {
      if (!(await deploymentRequiresLogin())) {
        throw new Error("Private documents require Cloudflare Access on this deployment.");
      }

      const updated = await updateDocumentSharing(document, false);
      console.log(`Private: ${updated.title}`);
      console.log(`  id:    ${updated.id}`);
      console.log(`  url:   ${getDocumentUrl(updated.id)}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
