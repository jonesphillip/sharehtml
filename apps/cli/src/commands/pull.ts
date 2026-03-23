import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { downloadDocument } from "../api/client.js";

function extractId(idOrUrl: string): string {
  const urlMatch = idOrUrl.match(/\/d\/([a-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  return idOrUrl;
}

export const pullCmd = new Command("pull")
  .alias("dl")
  .description("Download a document to a local file")
  .argument("<id>", "Document ID or URL")
  .option("-o, --output <path>", "Output file path (defaults to original filename in current directory)")
  .action(async (idOrUrl: string, opts: { output?: string }) => {
    try {
      const id = extractId(idOrUrl);
      console.log(`Downloading ${id}...`);

      const { filename, content } = await downloadDocument(id);
      const outputPath = resolve(opts.output || filename);

      await writeFile(outputPath, content);
      console.log(`\nSaved to ${outputPath}`);
      console.log(`  size: ${(content.length / 1024).toFixed(1)}KB`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
