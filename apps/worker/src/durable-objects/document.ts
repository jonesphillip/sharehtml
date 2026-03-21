import { DurableObject } from "cloudflare:workers";
import { isRecord, parseDocumentSnapshot } from "../types.js";
import type { CommentRow, ReactionRow, DocumentSnapshot } from "../types.js";
import type { ClientMessage, ServerMessage } from "@sharehtml/shared";
import type { Anchor, Comment, Reaction, UserPresence } from "@sharehtml/shared";
import { getRegistry } from "../utils/registry.js";
import { findAnchorRangeInText, getElementSelector, rebuildAnchor } from "../utils/anchors.js";
import { collectAnnotatableElementsFromHtml, remapElementAnchor } from "../utils/document-elements.js";
import { diffText, mapRangeThroughDiff } from "../utils/text-diff.js";

const clientMessageTypes = new Set<string>([
  "user:join", "user:set_name", "presence:update",
  "comment:create", "comment:update", "comment:delete", "comment:resolve",
  "reaction:add", "reaction:remove",
]);

function isClientMessage(value: unknown): value is ClientMessage {
  return isRecord(value) && typeof value.type === "string" && clientMessageTypes.has(value.type);
}

interface WsAttachment {
  email: string;
  name: string;
  color: string;
  verifiedEmail?: string;
}

function parseAttachment(raw: unknown): WsAttachment | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.email !== "string" || typeof raw.name !== "string" || typeof raw.color !== "string") {
    return null;
  }
  return {
    email: raw.email,
    name: raw.name,
    color: raw.color,
    verifiedEmail: typeof raw.verifiedEmail === "string" ? raw.verifiedEmail : undefined,
  };
}

// At WebSocket accept time, only { verifiedEmail } is stored — the full
// attachment (email, name, color) isn't set until handleUserJoin, so
// parseAttachment would return null. This extracts just the verified email.
function parseVerifiedEmail(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  return typeof raw.verifiedEmail === "string" ? raw.verifiedEmail : undefined;
}

export class DocumentDO extends DurableObject<Env> {
  sql: SqlStorage;
  presence: Map<string, UserPresence> = new Map();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initTables();
    // Rebuild presence after hibernation wake — WebSockets survive but the Map doesn't
    this.rebuildPresence();
  }

  private initTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS reactions (
        id TEXT PRIMARY KEY,
        author_email TEXT NOT NULL,
        author_name TEXT NOT NULL,
        emoji TEXT NOT NULL,
        anchor TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(author_email, emoji, anchor)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        author_email TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_color TEXT NOT NULL,
        content TEXT NOT NULL,
        anchor TEXT,
        parent_id TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  }

  private rowToComment(row: CommentRow): Comment {
    return {
      id: row.id,
      document_id: "",
      author_email: row.author_email,
      author_name: row.author_name,
      author_color: row.author_color,
      content: row.content,
      anchor: row.anchor ? JSON.parse(row.anchor) : null,
      parent_id: row.parent_id || null,
      resolved: Boolean(row.resolved),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private getComments(): Comment[] {
    return this.sql
      .exec<CommentRow>("SELECT * FROM comments ORDER BY created_at ASC")
      .toArray()
      .map((row) => this.rowToComment(row));
  }

  private getReactions(): Reaction[] {
    return this.sql
      .exec<ReactionRow>("SELECT * FROM reactions ORDER BY created_at ASC")
      .toArray()
      .map((row) => this.rowToReaction(row));
  }

  private getSnapshot(): DocumentSnapshot {
    return {
      comments: this.getComments(),
      reactions: this.getReactions(),
    };
  }

  private rowToReaction(row: ReactionRow): Reaction {
    return {
      id: row.id,
      document_id: "",
      author_email: row.author_email,
      author_name: row.author_name,
      emoji: row.emoji,
      anchor: JSON.parse(row.anchor),
      created_at: row.created_at,
    };
  }

  private broadcast(msg: ServerMessage, exclude?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== exclude) {
        try {
          ws.send(data);
        } catch {
          /* closed */
        }
      }
    }
  }

  private rebuildPresence() {
    this.presence.clear();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const attachment = parseAttachment(ws.deserializeAttachment());
        if (attachment) {
          this.presence.set(attachment.email, {
            email: attachment.email,
            name: attachment.name,
            color: attachment.color,
            last_seen: Date.now(),
          });
        }
      } catch {
        /* no attachment yet */
      }
    }
  }

  private getAttachment(ws: WebSocket): WsAttachment | null {
    return parseAttachment(ws.deserializeAttachment());
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      const upgradeHeader = request.headers.get("Upgrade");
      if (upgradeHeader !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const verifiedEmail = request.headers.get("X-Verified-Email") || undefined;
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      // Store verified email from Access JWT so handleUserJoin can enforce it
      if (verifiedEmail) {
        pair[1].serializeAttachment({ verifiedEmail });
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname.endsWith("/comments") && request.method === "GET") {
      return Response.json({ comments: this.getComments() });
    }

    if (url.pathname.endsWith("/snapshot") && request.method === "GET") {
      return Response.json(this.getSnapshot());
    }

    if (url.pathname.endsWith("/migrate-anchors") && request.method === "POST") {
      const body: unknown = await request.json();
      if (
        !isRecord(body) ||
        typeof body.newHtml !== "string" ||
        typeof body.oldText !== "string" ||
        typeof body.newText !== "string"
      ) {
        return Response.json(
          { error: "newHtml, oldText, and newText are required" },
          { status: 400 },
        );
      }

      const summary = await this.migrateAnchors(body.newHtml, body.oldText, body.newText);
      return Response.json(summary);
    }

    if (url.pathname.endsWith("/restore-snapshot") && request.method === "POST") {
      const snapshot = parseDocumentSnapshot(await request.json());
      if (!snapshot) {
        return Response.json({ error: "invalid snapshot" }, { status: 400 });
      }
      this.restoreSnapshot(snapshot);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  private static readonly MAX_MESSAGE_SIZE = 64 * 1024;
  private static readonly MAX_NAME_LENGTH = 100;
  private static readonly MAX_COMMENT_LENGTH = 10_000;

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;
    if (message.length > DocumentDO.MAX_MESSAGE_SIZE) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    if (isRecord(parsed) && parsed.type === "ping") {
      ws.send("pong");
      return;
    }

    if (!isClientMessage(parsed)) return;

    switch (parsed.type) {
      case "user:join":
        return this.handleUserJoin(ws, parsed);
      case "user:set_name":
        return this.handleUserSetName(ws, parsed);
      case "presence:update":
        return this.handlePresenceUpdate(ws, parsed);
      case "comment:create":
        return this.handleCommentCreate(ws, parsed);
      case "comment:update":
        return this.handleCommentUpdate(ws, parsed);
      case "comment:delete":
        return this.handleCommentDelete(ws, parsed);
      case "comment:resolve":
        return this.handleCommentResolve(ws, parsed);
      case "reaction:add":
        return this.handleReactionAdd(ws, parsed);
      case "reaction:remove":
        return this.handleReactionRemove(ws, parsed);
    }
  }

  private async handleUserJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: "user:join" }>) {
    // Use verified email from Access JWT if available, ignore client-claimed email
    const verifiedEmail = parseVerifiedEmail(ws.deserializeAttachment());
    const email = verifiedEmail || msg.email;
    const name = msg.name.slice(0, DocumentDO.MAX_NAME_LENGTH);

    const registry = getRegistry(this.env);
    const attachment: WsAttachment = {
      email,
      name,
      color: "",
      verifiedEmail,
    };

    const user = await registry.getUser(email);
    if (user) {
      attachment.color = user.color;
      attachment.name = user.display_name;
    } else {
      const created = await registry.setUser(email, name);
      attachment.color = created.color;
    }

    ws.serializeAttachment(attachment);

    const userPresence: UserPresence = {
      email,
      name: attachment.name || name,
      color: attachment.color,
      last_seen: Date.now(),
    };
    this.presence.set(email, userPresence);

    const comments = this.getComments();
    const reactions = this.getReactions();
    ws.send(
      JSON.stringify({
        type: "comments:list",
        comments,
      } satisfies ServerMessage),
    );
    ws.send(
      JSON.stringify({
        type: "reactions:list",
        reactions,
      } satisfies ServerMessage),
    );
    ws.send(
      JSON.stringify({
        type: "users:list",
        users: Array.from(this.presence.values()),
      } satisfies ServerMessage),
    );

    this.broadcast(
      {
        type: "user:joined",
        user: userPresence,
      },
      ws,
    );
  }

  private async handleUserSetName(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "user:set_name" }>,
  ) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const name = msg.name.slice(0, DocumentDO.MAX_NAME_LENGTH);
    const registry = getRegistry(this.env);
    await registry.setUser(attachment.email, name);

    attachment.name = name;
    ws.serializeAttachment(attachment);

    const pres = this.presence.get(attachment.email);
    if (pres) {
      pres.name = name;
      this.presence.set(attachment.email, pres);
    }

    this.broadcast({
      type: "user:name_set",
      email: attachment.email,
      name,
    });
  }

  private handlePresenceUpdate(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "presence:update" }>,
  ) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const pres = this.presence.get(attachment.email);
    if (pres) {
      pres.selection = msg.selection;
      pres.last_seen = Date.now();
    }

    this.broadcast(
      {
        type: "presence:updated",
        email: attachment.email,
        selection: msg.selection,
      },
      ws,
    );
  }

  private handleCommentCreate(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "comment:create" }>,
  ) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const content = msg.content.slice(0, DocumentDO.MAX_COMMENT_LENGTH);
    const anchorJson = msg.anchor ? JSON.stringify(msg.anchor) : null;
    this.sql.exec(
      `INSERT INTO comments (id, author_email, author_name, author_color, content, anchor, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      msg.id,
      attachment.email,
      attachment.name,
      attachment.color,
      content,
      anchorJson,
      msg.parent_id,
    );

    const comment: Comment = {
      id: msg.id,
      document_id: "",
      author_email: attachment.email,
      author_name: attachment.name,
      author_color: attachment.color,
      content,
      anchor: msg.anchor,
      parent_id: msg.parent_id,
      resolved: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.broadcast({ type: "comment:created", comment });
  }

  private handleCommentUpdate(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "comment:update" }>,
  ) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const content = msg.content.slice(0, DocumentDO.MAX_COMMENT_LENGTH);
    this.sql.exec(
      "UPDATE comments SET content = ?, updated_at = datetime('now') WHERE id = ? AND author_email = ?",
      content,
      msg.id,
      attachment.email,
    );

    const rows = this.sql.exec<CommentRow>("SELECT * FROM comments WHERE id = ?", msg.id).toArray();
    if (rows.length > 0) {
      const comment = this.rowToComment(rows[0]);
      this.broadcast({ type: "comment:updated", comment });
    }
  }

  private handleCommentDelete(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "comment:delete" }>,
  ) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const rows = this.sql.exec<{ id: string; author_email: string }>(
      "SELECT id, author_email FROM comments WHERE id = ?",
      msg.id,
    ).toArray();
    if (rows.length === 0) return;

    const comment = rows[0];
    if (comment.author_email !== attachment.email) return;

    const idsToDelete = new Set<string>([msg.id]);
    const queue = [msg.id];

    for (let parentId = queue.pop(); parentId !== undefined; parentId = queue.pop()) {
      const childRows = this.sql
        .exec<{ id: string }>("SELECT id FROM comments WHERE parent_id = ?", parentId)
        .toArray();

      for (const child of childRows) {
        if (idsToDelete.has(child.id)) continue;
        idsToDelete.add(child.id);
        queue.push(child.id);
      }
    }

    const placeholders = [...idsToDelete].map(() => "?").join(",");
    this.sql.exec(`DELETE FROM comments WHERE id IN (${placeholders})`, ...idsToDelete);

    this.broadcast({ type: "comment:deleted", id: msg.id });
  }

  private handleCommentResolve(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "comment:resolve" }>,
  ) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    this.sql.exec(
      "UPDATE comments SET resolved = ?, updated_at = datetime('now') WHERE id = ?",
      msg.resolved ? 1 : 0,
      msg.id,
    );
    this.broadcast({
      type: "comment:resolved",
      id: msg.id,
      resolved: msg.resolved,
    });
  }

  private handleReactionAdd(ws: WebSocket, msg: Extract<ClientMessage, { type: "reaction:add" }>) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const anchorJson = JSON.stringify(msg.anchor);
    const result = this.sql.exec(
      "INSERT OR IGNORE INTO reactions (id, author_email, author_name, emoji, anchor) VALUES (?, ?, ?, ?, ?)",
      msg.id,
      attachment.email,
      attachment.name,
      msg.emoji,
      anchorJson,
    );
    if (!result.rowsWritten) return;

    const reaction: Reaction = {
      id: msg.id,
      document_id: "",
      author_email: attachment.email,
      author_name: attachment.name,
      emoji: msg.emoji,
      anchor: msg.anchor,
      created_at: new Date().toISOString(),
    };

    this.broadcast({ type: "reaction:added", reaction });
  }

  private async migrateAnchors(newHtml: string, oldText: string, newText: string) {
    let updatedComments = 0;
    let resolvedComments = 0;
    let reactionsChanged = false;
    const textDiff = diffText(oldText, newText);
    const nextElements = await collectAnnotatableElementsFromHtml(newHtml);

    const commentRows = this.sql.exec<CommentRow>("SELECT * FROM comments ORDER BY created_at ASC").toArray();
    for (const row of commentRows) {
      const comment = this.rowToComment(row);
      if (!comment.anchor) continue;

      const nextAnchor = this.remapAnchor(comment.anchor, oldText, newText, textDiff, nextElements);
      if (nextAnchor === "resolve") {
        if (comment.resolved) continue;
        this.sql.exec(
          "UPDATE comments SET resolved = 1, updated_at = datetime('now') WHERE id = ?",
          comment.id,
        );
        resolvedComments++;
        this.broadcast({
          type: "comment:resolved",
          id: comment.id,
          resolved: true,
        });
        continue;
      }

      if (!nextAnchor) continue;

      this.sql.exec(
        "UPDATE comments SET anchor = ?, updated_at = datetime('now') WHERE id = ?",
        JSON.stringify(nextAnchor),
        comment.id,
      );
      updatedComments++;

      this.broadcast({
        type: "comment:updated",
        comment: { ...comment, anchor: nextAnchor },
      });
    }

    const reactionRows = this.sql.exec<ReactionRow>("SELECT * FROM reactions ORDER BY created_at ASC").toArray();
    for (const row of reactionRows) {
      const reaction = this.rowToReaction(row);
      const nextAnchor = this.remapAnchor(reaction.anchor, oldText, newText, textDiff, nextElements);

      if (nextAnchor === "resolve") {
        this.sql.exec("DELETE FROM reactions WHERE id = ?", reaction.id);
        reactionsChanged = true;
        continue;
      }

      if (!nextAnchor) continue;

      this.sql.exec(
        "UPDATE reactions SET anchor = ? WHERE id = ?",
        JSON.stringify(nextAnchor),
        reaction.id,
      );
      reactionsChanged = true;
    }

    if (reactionsChanged) {
      this.broadcast({
        type: "reactions:list",
        reactions: this.getReactions(),
      });
    }

    return { updatedComments, resolvedComments, reactionsChanged };
  }

  private restoreSnapshot(snapshot: DocumentSnapshot): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM comments");
      this.sql.exec("DELETE FROM reactions");

      for (const comment of snapshot.comments) {
        this.sql.exec(
          `INSERT INTO comments
            (id, author_email, author_name, author_color, content, anchor, parent_id, resolved, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          comment.id,
          comment.author_email,
          comment.author_name,
          comment.author_color,
          comment.content,
          comment.anchor ? JSON.stringify(comment.anchor) : null,
          comment.parent_id,
          comment.resolved ? 1 : 0,
          comment.created_at,
          comment.updated_at,
        );
      }

      for (const reaction of snapshot.reactions) {
        this.sql.exec(
          `INSERT INTO reactions
            (id, author_email, author_name, emoji, anchor, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          reaction.id,
          reaction.author_email,
          reaction.author_name,
          reaction.emoji,
          JSON.stringify(reaction.anchor),
          reaction.created_at,
        );
      }
    });

    this.broadcast({
      type: "comments:list",
      comments: this.getComments(),
    });
    this.broadcast({
      type: "reactions:list",
      reactions: this.getReactions(),
    });
  }

  private remapAnchor(
    anchor: Anchor,
    oldText: string,
    newText: string,
    textDiff: ReturnType<typeof diffText>,
    nextElements: Awaited<ReturnType<typeof collectAnnotatableElementsFromHtml>>,
  ): Anchor | "resolve" | null {
    if (getElementSelector(anchor)) {
      return remapElementAnchor(anchor, nextElements);
    }

    const previousRange = findAnchorRangeInText(oldText, anchor);
    if (!previousRange) {
      return "resolve";
    }

    const migratedRange = mapRangeThroughDiff(previousRange, textDiff);
    if (!migratedRange) {
      return "resolve";
    }

    if (newText.slice(migratedRange.start, migratedRange.end) !== oldText.slice(previousRange.start, previousRange.end)) {
      return "resolve";
    }

    const rebuiltAnchor = rebuildAnchor(anchor, newText, migratedRange.start, migratedRange.end);
    if (JSON.stringify(rebuiltAnchor) === JSON.stringify(anchor)) {
      return null;
    }

    return rebuiltAnchor;
  }

  private handleReactionRemove(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "reaction:remove" }>,
  ) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const result = this.sql.exec(
      "DELETE FROM reactions WHERE id = ? AND author_email = ?",
      msg.id,
      attachment.email,
    );
    if (!result.rowsWritten) return;
    this.broadcast({ type: "reaction:removed", id: msg.id });
  }

  private handleDisconnect(ws: WebSocket) {
    const attachment = parseAttachment(ws.deserializeAttachment());
    if (attachment) {
      this.presence.delete(attachment.email);
      this.broadcast({ type: "user:left", email: attachment.email });
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown) {
    this.handleDisconnect(ws);
  }
}
