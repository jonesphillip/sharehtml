import { Command } from "commander";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  downloadDocument,
  downloadDocumentSource,
  findDocumentByFilename,
  getDocument,
} from "../api/client.js";
import { getDocumentMapping } from "../config/store.js";
import { getCodeLanguage, getSourceKind, renderedFilenameToHtml } from "../utils/document-render.js";
import {
  buildStructuredDiff,
  diffHasChanges,
  renderTerminalDiff,
  type DiffHunk,
  type NumberedDiffRow,
} from "../utils/terminal-diff.js";

function isSourceUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("source unavailable");
}

function canUseRenderedHtmlAsNativeDiff(filePath: string): boolean {
  return getSourceKind(basename(filePath)) === "html";
}

async function resolveRemoteDocument(filePath: string, explicitId?: string) {
  if (explicitId) {
    return getDocument(explicitId);
  }

  const mappedDocumentId = getDocumentMapping(filePath);
  if (mappedDocumentId) {
    try {
      return await getDocument(mappedDocumentId);
    } catch {
      // Fall back to filename lookup below.
    }
  }

  const filename = basename(filePath);
  const sourceMatch = await findDocumentByFilename(filename, "source");
  if (sourceMatch) {
    return sourceMatch;
  }

  const renderedFilename = renderedFilenameToHtml(filename);
  if (renderedFilename !== filename) {
    return findDocumentByFilename(renderedFilename, "rendered");
  }

  return null;
}

function splitPagerCommand(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean);
}

async function pageOutput(text: string): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stdout.write(`${text}\n`);
    return;
  }

  const pagerCommand = process.env.PAGER || "less -R -F -X -S";
  const pagerParts = splitPagerCommand(pagerCommand);
  const pagerBinary = pagerParts[0];
  const pagerArgs = pagerParts.slice(1);

  await new Promise<void>((resolvePromise) => {
    const pager = spawn(pagerBinary, pagerArgs, {
      stdio: ["pipe", "inherit", "inherit"],
    });

    pager.on("error", () => {
      process.stdout.write(`${text}\n`);
      resolvePromise();
    });

    pager.on("close", () => {
      resolvePromise();
    });

    pager.stdin.write(text);
    pager.stdin.end();
  });
}

function getDiffLanguage(filePath: string): string | undefined {
  const filename = basename(filePath);
  const sourceKind = getSourceKind(filename);

  if (sourceKind === "code") {
    return getCodeLanguage(filename) || undefined;
  }

  if (sourceKind === "markdown") {
    return "markdown";
  }

  return "html";
}

type CompactDiffRow =
  | ["=", number, string]
  | ["-", number, string]
  | ["+", number, string]
  | ["~", number, number, string, string];

interface CompactDiffHunk {
  at: [leftStart: number, rightStart: number];
  rows: CompactDiffRow[];
}

function toCompactRow(row: NumberedDiffRow): CompactDiffRow {
  if (row.row.type === "context") {
    return ["=", row.leftNumber || 0, row.row.left];
  }

  if (row.row.type === "delete") {
    return ["-", row.leftNumber || 0, row.row.left];
  }

  if (row.row.type === "insert") {
    return ["+", row.rightNumber || 0, row.row.right];
  }

  return ["~", row.leftNumber || 0, row.rightNumber || 0, row.row.left, row.row.right];
}

function toCompactHunk(hunk: DiffHunk): CompactDiffHunk {
  return {
    at: [hunk.startLeft, hunk.startRight],
    rows: hunk.rows.map(toCompactRow),
  };
}

export const diffCmd = new Command("diff")
  .description("Show a local vs remote diff for a document")
  .argument("<file>", "Path to the local source file")
  .option("--id <id>", "Explicit remote document id")
  .option("--json", "Output as JSON instead of terminal diff")
  .option("--no-pager", "Print directly instead of opening a pager")
  .action(async (file: string, opts: {
    id?: string;
    json?: boolean;
    pager?: boolean;
  }) => {
    const filePath = resolve(file);

    try {
      const stats = await stat(filePath);
      if (!stats.isFile()) {
        throw new Error(`${file} is not a file`);
      }

      const remoteDocument = await resolveRemoteDocument(filePath, opts.id);
      if (!remoteDocument) {
        console.error(`Error: no matching remote document found for ${basename(filePath)}`);
        console.log(`\n  deploy it first:  sharehtml deploy ${file}`);
        console.log(`  or specify an id: sharehtml diff ${file} --id <document-id>`);
        process.exit(1);
      }

      const localText = await readFile(filePath, "utf-8");
      const localLabel = `local: ${basename(filePath)}`;
      let remoteText: string;
      let remoteLabel = `remote: ${remoteDocument.filename}`;
      const language = getDiffLanguage(filePath);

      try {
        const remoteSource = await downloadDocumentSource(remoteDocument.id);
        remoteText = new TextDecoder().decode(remoteSource.content);
        remoteLabel = `remote: ${remoteSource.filename}`;
      } catch (error) {
        if (isSourceUnavailableError(error)) {
          if (canUseRenderedHtmlAsNativeDiff(filePath)) {
            const remoteRendered = await downloadDocument(remoteDocument.id, "rendered");
            remoteText = new TextDecoder().decode(remoteRendered.content);
          } else {
            console.error(`Error: source diff unavailable because this document was deployed without storing the original source`);
            console.log(`\n  run \`sharehtml deploy ${file}\` to re-deploy with source tracking enabled`);
            process.exit(1);
          }
        } else {
          throw error;
        }
      }

      if (!diffHasChanges(localText, remoteText)) {
        console.log("No changes.");
        return;
      }

      if (opts.json) {
        const structured = buildStructuredDiff(remoteText, localText);
        process.stdout.write(
          `${JSON.stringify({
            o: "remote_to_local",
            r: remoteLabel,
            l: localLabel,
            s: [structured.stats.insertions, structured.stats.deletions, structured.stats.changes],
            h: structured.hunks.map(toCompactHunk),
          })}\n`,
        );
        return;
      }

      const renderedDiff = renderTerminalDiff(remoteText, localText, remoteLabel, localLabel, language);
      if (opts.pager === false) {
        process.stdout.write(`${renderedDiff}\n`);
        return;
      }

      await pageOutput(renderedDiff);
    } catch (error) {
      console.error(`Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });
