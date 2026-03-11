import { Command } from "commander";
import { getDocumentUrl } from "../api/client.js";
import { deploymentRequiresLogin } from "../auth/capabilities.js";
import { updateDocumentSharing } from "./share-utils.js";

export const shareCmd = new Command("share")
  .description("Make a document shareable")
  .argument("<document>", "Document id or filename")
  .action(async (document: string) => {
    try {
      if (!(await deploymentRequiresLogin())) {
        throw new Error("This deployment already allows link access to all documents.");
      }

      const updated = await updateDocumentSharing(document, true);
      console.log(`Shared: ${updated.title}`);
      console.log(`  id:    ${updated.id}`);
      console.log(`  url:   ${getDocumentUrl(updated.id)}`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
