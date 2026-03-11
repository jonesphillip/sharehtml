import { Command } from "commander";
import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  deployDocument,
  findDocumentByFilename,
  getDocumentUrl,
  updateDocument,
} from "../api/client.js";
import { deploymentRequiresLogin } from "../auth/capabilities.js";
import { updateDocumentSharing } from "./share-utils.js";
import { renderedFilenameToHtml } from "../utils/document-render.js";

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) =>
    rl.question(question + " (y/n) ", (a) => {
      rl.close();
      r(a.trim().toLowerCase() === "y");
    }),
  );
}

export const deployCmd = new Command("deploy")
  .description("Deploy an HTML, Markdown, or code file and get a shareable link")
  .argument("<file>", "Path to HTML, Markdown, or code file")
  .option("-t, --title <title>", "Document title (defaults to filename)")
  .option("-u, --update", "Update existing document without prompting")
  .option("--share", "Make the document shareable after deploy")
  .option("--private", "Keep the document private after deploy")
  .action(async (file: string, opts: { title?: string; update?: boolean; share?: boolean; private?: boolean }) => {
    const filePath = resolve(file);

    if (opts.share && opts.private) {
      console.error("Error: choose either --share or --private, not both");
      process.exit(1);
    }

    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) {
        console.error(`Error: ${file} is not a file`);
        process.exit(1);
      }
    } catch {
      console.error(`Error: ${file} not found`);
      process.exit(1);
    }

    try {
      const supportsPrivateDocuments = await deploymentRequiresLogin();
      if (opts.private && !supportsPrivateDocuments) {
        throw new Error("Private documents require Cloudflare Access on this deployment.");
      }

      const filename = basename(filePath);
      const lookupFilename = renderedFilenameToHtml(filename);
      const existing = await findDocumentByFilename(lookupFilename);

      if (existing) {
        const existingUrl = getDocumentUrl(existing.id);

        if (!opts.update) {
          const yes = await confirm(
            `Document '${filename}' already exists at ${existingUrl}. Update it?`,
          );
          if (!yes) {
            console.log("Aborted.");
            return;
          }
        }

        console.log(`Updating ${file}...`);
        const result = await updateDocument(existing.id, filePath, opts.title);
        let isShared = result.isShared;
        if ((opts.share || opts.private) && supportsPrivateDocuments) {
          const updated = await updateDocumentSharing(existing.id, Boolean(opts.share));
          isShared = updated.isShared;
        }
        console.log(`\nUpdated! ${result.url}`);
        console.log(`  id:    ${result.id}`);
        console.log(`  title: ${result.title}`);
        console.log(`  size:  ${(result.size / 1024).toFixed(1)}KB`);
        console.log(`  share: ${isShared ? "shareable" : "private"}`);
      } else {
        console.log(`Deploying ${file}...`);
        const result = await deployDocument(filePath, opts.title);
        let isShared = result.isShared;
        if ((opts.share || opts.private) && supportsPrivateDocuments) {
          const updated = await updateDocumentSharing(result.id, Boolean(opts.share));
          isShared = updated.isShared;
        }
        console.log(`\nDeployed! ${result.url}`);
        console.log(`  id:    ${result.id}`);
        console.log(`  title: ${result.title}`);
        console.log(`  size:  ${(result.size / 1024).toFixed(1)}KB`);
        console.log(`  share: ${isShared ? "shareable" : "private"}`);
        if (!opts.share && !opts.private && !isShared) {
          console.log(`  next:  run 'sharehtml share ${lookupFilename}' to make it shareable`);
        }
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
