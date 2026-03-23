import { Command } from "commander";
import {
  getDocumentComments,
  type DocumentComment,
} from "../api/client.js";

interface DisplayComment {
  id: string;
  authorName: string;
  content: string;
  quote: string | null;
  createdAt: string;
  replies: Array<{
    id: string;
    authorName: string;
    content: string;
    createdAt: string;
  }>;
}

function extractId(idOrUrl: string): string {
  const urlMatch = idOrUrl.match(/\/d\/([a-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  return idOrUrl;
}

function extractQuote(comment: DocumentComment): string | null {
  if (!comment.anchor) return null;

  for (const selector of comment.anchor.selectors) {
    if (selector.type === "TextQuoteSelector" && typeof selector.exact === "string" && selector.exact.length > 0) {
      return selector.exact.trim();
    }
  }

  return null;
}

function formatTimestamp(timestamp: string): string {
  const value = Date.parse(timestamp.includes("T") ? timestamp : `${timestamp.replace(" ", "T")}Z`);
  if (Number.isNaN(value)) return timestamp;

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function buildDisplayComments(comments: DocumentComment[]): DisplayComment[] {
  const repliesByParent = new Map<string, DisplayComment["replies"]>();

  for (const comment of comments) {
    if (!comment.parent_id) continue;

    const replies = repliesByParent.get(comment.parent_id) || [];
    replies.push({
      id: comment.id,
      authorName: comment.author_name,
      content: comment.content,
      createdAt: comment.created_at,
    });
    repliesByParent.set(comment.parent_id, replies);
  }

  return comments
    .filter((comment) => !comment.parent_id && !comment.resolved)
    .map((comment) => ({
      id: comment.id,
      authorName: comment.author_name,
      content: comment.content,
      quote: extractQuote(comment),
      createdAt: comment.created_at,
      replies: repliesByParent.get(comment.id) || [],
    }));
}

function renderPrettyComments(
  document: { filename: string },
  comments: DisplayComment[],
): string {
  if (comments.length === 0) {
    return `${document.filename} -> 0 unresolved comments`;
  }

  const lines = [`${document.filename} -> ${comments.length} unresolved comments`, ""];

  for (const comment of comments) {
    lines.push(`[${comment.id}] ${comment.authorName}  ${formatTimestamp(comment.createdAt)}`);
    if (comment.quote) {
      lines.push(`Quote: "${comment.quote}"`);
    }
    lines.push(comment.content);

    for (const reply of comment.replies) {
      lines.push("");
      lines.push(`  > [${reply.id}] ${reply.authorName}  ${formatTimestamp(reply.createdAt)}`);
      lines.push(`  ${reply.content}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function renderJsonComments(
  document: { id: string; title: string; filename: string },
  comments: DisplayComment[],
): string {
  return JSON.stringify({
    doc: {
      id: document.id,
      title: document.title,
      filename: document.filename,
    },
    unresolved: comments.map((comment) => ({
      id: comment.id,
      author: comment.authorName,
      created_at: comment.createdAt,
      quote: comment.quote,
      body: comment.content,
      replies: comment.replies.map((reply) => ({
        id: reply.id,
        author: reply.authorName,
        created_at: reply.createdAt,
        body: reply.content,
      })),
    })),
  });
}

export const commentsCmd = new Command("comments")
  .description("Show unresolved comments for a document")
  .argument("<id>", "Document ID or URL")
  .option("--json", "Output as JSON")
  .action(async (idOrUrl: string, opts: { json?: boolean }) => {
    try {
      const id = extractId(idOrUrl);

      const result = await getDocumentComments(id);
      const comments = buildDisplayComments(result.comments);

      const output = opts.json
        ? renderJsonComments(result.document, comments)
        : renderPrettyComments(result.document, comments);

      console.log(output);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });
