import { Command } from "commander";
import { listDocuments } from "../api/client.js";

export const listCmd = new Command("list")
  .alias("ls")
  .description("List all documents")
  .action(async () => {
    try {
      const { documents } = await listDocuments();

      if (documents.length === 0) {
        console.log("No documents found.");
        return;
      }

      console.log(`${documents.length} document(s):\n`);
      for (const doc of documents) {
        const size = (doc.size / 1024).toFixed(1);
        const visibility = doc.is_shared ? "shareable" : "private";
        console.log(`  ${doc.id}  ${doc.title}  (${size}KB)  ${visibility}  ${doc.created_at}`);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
