import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types.js";
import type { ClientMessage, ServerMessage } from "@sharehtml/shared";
import type { Anchor, Comment, Reaction, UserPresence } from "@sharehtml/shared";
import { getRegistry } from "../utils/registry.js";
import { findAnchorRangeInText, rebuildAnchor } from "../utils/anchors.js";
import { diffText, mapRangeThroughDiff } from "../utils/text-diff.js";

interface WsAttachment {
  email: string;
  name: string;
  color: string;
  verifiedEmail?: string;
}

interface DocumentSnapshot {
  comments: Comment[];
  reactions: Reaction[];
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

  private rowToComment(row: Record<string, SqlStorageValue>): Comment {
    return {
      id: row.id as string,
      document_id: "",
      author_email: row.author_email as string,
      author_name: row.author_name as string,
      author_color: row.author_color as string,
      content: row.content as string,
      anchor: row.anchor ? JSON.parse(row.anchor as string) : null,
      parent_id: (row.parent_id as string) || null,
      resolved: Boolean(row.resolved),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }

  private getComments(): Comment[] {
    return this.sql
      .exec("SELECT * FROM comments ORDER BY created_at ASC")
      .toArray()
      .map((row: Record<string, SqlStorageValue>) => this.rowToComment(row));
  }

  private getReactions(): Reaction[] {
    return this.sql
      .exec("SELECT * FROM reactions ORDER BY created_at ASC")
      .toArray()
      .map((row: Record<string, SqlStorageValue>) => ({
        id: row.id as string,
        document_id: "",
        author_email: row.author_email as string,
        author_name: row.author_name as string,
        emoji: row.emoji as string,
        anchor: JSON.parse(row.anchor as string),
        created_at: row.created_at as string,
      }));
  }

  private getSnapshot(): DocumentSnapshot {
    return {
      comments: this.getComments(),
      reactions: this.getReactions(),
    };
  }

  private rowToReaction(row: Record<string, SqlStorageValue>): Reaction {
    return {
      id: row.id as string,
      document_id: "",
      author_email: row.author_email as string,
      author_name: row.author_name as string,
      emoji: row.emoji as string,
      anchor: JSON.parse(row.anchor as string),
      created_at: row.created_at as string,
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
        const attachment = ws.deserializeAttachment() as WsAttachment | null;
        if (attachment?.email) {
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
    return ws.deserializeAttachment() as WsAttachment | null;
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
        pair[1].serializeAttachment({ verifiedEmail } as Partial<WsAttachment>);
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
      const body = await request.json<{ oldText?: string; newText?: string }>();
      if (typeof body.oldText !== "string" || typeof body.newText !== "string") {
        return Response.json({ error: "oldText and newText are required" }, { status: 400 });
      }

      const summary = this.migrateAnchors(body.oldText, body.newText);
      return Response.json(summary);
    }

    if (url.pathname.endsWith("/restore-snapshot") && request.method === "POST") {
      const snapshot = await request.json<DocumentSnapshot>();
      this.restoreSnapshot(snapshot);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    let msg: ClientMessage & { type: string };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === "ping") {
      ws.send("pong");
      return;
    }

    switch (msg.type) {
      case "user:join":
        return this.handleUserJoin(ws, msg);
      case "user:set_name":
        return this.handleUserSetName(ws, msg);
      case "presence:update":
        return this.handlePresenceUpdate(ws, msg);
      case "comment:create":
        return this.handleCommentCreate(ws, msg);
      case "comment:update":
        return this.handleCommentUpdate(ws, msg);
      case "comment:delete":
        return this.handleCommentDelete(ws, msg);
      case "comment:resolve":
        return this.handleCommentResolve(ws, msg);
      case "reaction:add":
        return this.handleReactionAdd(ws, msg);
      case "reaction:remove":
        return this.handleReactionRemove(ws, msg);
    }
  }

  private async handleUserJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: "user:join" }>) {
    // Use verified email from Access JWT if available, ignore client-claimed email
    const existing = ws.deserializeAttachment() as Partial<WsAttachment> | null;
    const email = existing?.verifiedEmail || msg.email;

    const registry = getRegistry(this.env);
    const attachment: WsAttachment = {
      email,
      name: msg.name,
      color: "",
      verifiedEmail: existing?.verifiedEmail,
    };

    const user = await registry.getUser(email);
    if (user) {
      attachment.color = user.color;
      attachment.name = user.display_name;
    } else {
      const created = await registry.setUser(email, msg.name);
      attachment.color = created.color;
    }

    ws.serializeAttachment(attachment);

    this.presence.set(email, {
      email,
      name: attachment.name || msg.name,
      color: attachment.color,
      last_seen: Date.now(),
    });

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
        user: this.presence.get(email)!,
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

    const registry = getRegistry(this.env);
    await registry.setUser(attachment.email, msg.name);

    attachment.name = msg.name;
    ws.serializeAttachment(attachment);

    const pres = this.presence.get(attachment.email);
    if (pres) {
      pres.name = msg.name;
      this.presence.set(attachment.email, pres);
    }

    this.broadcast({
      type: "user:name_set",
      email: attachment.email,
      name: msg.name,
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

    const anchorJson = msg.anchor ? JSON.stringify(msg.anchor) : null;
    this.sql.exec(
      `INSERT INTO comments (id, author_email, author_name, author_color, content, anchor, parent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      msg.id,
      attachment.email,
      attachment.name,
      attachment.color,
      msg.content,
      anchorJson,
      msg.parent_id,
    );

    const comment: Comment = {
      id: msg.id,
      document_id: "",
      author_email: attachment.email,
      author_name: attachment.name,
      author_color: attachment.color,
      content: msg.content,
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

    this.sql.exec(
      "UPDATE comments SET content = ?, updated_at = datetime('now') WHERE id = ? AND author_email = ?",
      msg.content,
      msg.id,
      attachment.email,
    );

    const rows = this.sql.exec("SELECT * FROM comments WHERE id = ?", msg.id).toArray();
    if (rows.length > 0) {
      const comment = this.rowToComment(rows[0] as Record<string, SqlStorageValue>);
      this.broadcast({ type: "comment:updated", comment });
    }
  }

  private handleCommentDelete(
    ws: WebSocket,
    msg: Extract<ClientMessage, { type: "comment:delete" }>,
  ) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const rows = this.sql.exec(
      "SELECT id, author_email FROM comments WHERE id = ?",
      msg.id,
    ).toArray();
    if (rows.length === 0) return;

    const comment = rows[0] as { id: string; author_email: string };
    if (comment.author_email !== attachment.email) return;

    const idsToDelete = new Set<string>([msg.id]);
    const queue = [msg.id];

    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const childRows = this.sql
        .exec("SELECT id FROM comments WHERE parent_id = ?", parentId)
        .toArray() as Array<{ id: string }>;

      for (const child of childRows) {
        if (idsToDelete.has(child.id)) continue;
        idsToDelete.add(child.id);
        queue.push(child.id);
      }
    }

    for (const id of idsToDelete) {
      this.sql.exec(
        "DELETE FROM comments WHERE id = ?",
        id,
      );
    }

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

  private migrateAnchors(oldText: string, newText: string) {
    let updatedComments = 0;
    let resolvedComments = 0;
    let reactionsChanged = false;
    const textDiff = diffText(oldText, newText);

    const commentRows = this.sql.exec("SELECT * FROM comments ORDER BY created_at ASC").toArray();
    for (const row of commentRows) {
      const comment = this.rowToComment(row as Record<string, SqlStorageValue>);
      if (!comment.anchor) continue;

      const nextAnchor = this.remapAnchor(comment.anchor, oldText, newText, textDiff);
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

      const updatedRows = this.sql.exec("SELECT * FROM comments WHERE id = ?", comment.id).toArray();
      if (updatedRows.length > 0) {
        this.broadcast({
          type: "comment:updated",
          comment: this.rowToComment(updatedRows[0] as Record<string, SqlStorageValue>),
        });
      }
    }

    const reactionRows = this.sql.exec("SELECT * FROM reactions ORDER BY created_at ASC").toArray();
    for (const row of reactionRows) {
      const reaction = this.rowToReaction(row as Record<string, SqlStorageValue>);
      const nextAnchor = this.remapAnchor(reaction.anchor, oldText, newText, textDiff);

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
  ): Anchor | "resolve" | null {
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

    this.sql.exec(
      "DELETE FROM reactions WHERE id = ? AND author_email = ?",
      msg.id,
      attachment.email,
    );
    this.broadcast({ type: "reaction:removed", id: msg.id });
  }

  private handleDisconnect(ws: WebSocket) {
    const attachment = ws.deserializeAttachment() as WsAttachment | null;
    if (attachment?.email) {
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
