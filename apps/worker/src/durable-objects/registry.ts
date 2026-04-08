import { DurableObject } from "cloudflare:workers";
import type { DocumentRow, RecentViewRow, UserRow } from "../types.js";
import { normalizeEmail } from "../utils/email.js";

const USER_COLORS = [
  "#e11d48",
  "#db2777",
  "#c026d3",
  "#9333ea",
  "#7c3aed",
  "#4f46e5",
  "#2563eb",
  "#0284c7",
  "#0891b2",
  "#0d9488",
  "#059669",
  "#16a34a",
  "#65a30d",
  "#ca8a04",
  "#ea580c",
];

export class RegistryDO extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.initTables();
  }

  private initTables() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        owner_email TEXT NOT NULL,
        is_shared INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS views (
        user_email TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        last_viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_email, doc_id)
      )
    `);
    this.ensureDocumentSharingColumn();
    this.ensureDocumentArtifactColumns();
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS shared_emails (
        doc_id TEXT NOT NULL,
        email TEXT NOT NULL,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (doc_id, email)
      )
    `);
  }

  private ensureDocumentSharingColumn() {
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(documents)").toArray();
    const hasSharingColumn = columns.some((column) => column.name === "is_shared");
    if (hasSharingColumn) return;

    // Existing deployments treated every document as link-shareable.
    this.sql.exec("ALTER TABLE documents ADD COLUMN is_shared INTEGER NOT NULL DEFAULT 1");
  }

  private ensureDocumentArtifactColumns() {
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(documents)").toArray();
    const columnNames = new Set(columns.map((column) => column.name));

    if (!columnNames.has("rendered_filename")) {
      this.sql.exec("ALTER TABLE documents ADD COLUMN rendered_filename TEXT");
    }

    if (!columnNames.has("source_filename")) {
      this.sql.exec("ALTER TABLE documents ADD COLUMN source_filename TEXT");
    }

    if (!columnNames.has("source_kind")) {
      this.sql.exec("ALTER TABLE documents ADD COLUMN source_kind TEXT");
    }

    if (!columnNames.has("source_language")) {
      this.sql.exec("ALTER TABLE documents ADD COLUMN source_language TEXT");
    }
  }

  private pickColor(): string {
    return USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)];
  }

  async getUser(email: string): Promise<UserRow | null> {
    const normalizedEmail = normalizeEmail(email);
    const rows = this.sql
      .exec<UserRow>("SELECT email, display_name, color FROM users WHERE lower(email) = ?", normalizedEmail)
      .toArray();
    if (rows.length === 0) return null;
    return rows[0];
  }

  async setUser(email: string, displayName: string): Promise<UserRow> {
    const normalizedEmail = normalizeEmail(email);
    const existing = await this.getUser(email);
    if (existing) {
      this.sql.exec("UPDATE users SET display_name = ? WHERE email = ?", displayName, existing.email);
      return { ...existing, display_name: displayName };
    }
    const color = this.pickColor();
    this.sql.exec(
      "INSERT INTO users (email, display_name, color) VALUES (?, ?, ?)",
      normalizedEmail,
      displayName,
      color,
    );
    return { email: normalizedEmail, display_name: displayName, color };
  }

  async createDocument(doc: {
    id: string;
    title: string;
    filename: string;
    size: number;
    owner_email: string;
    is_shared: number;
    rendered_filename?: string | null;
    source_filename?: string | null;
    source_kind?: string | null;
    source_language?: string | null;
  }) {
    this.sql.exec(
      "INSERT INTO documents (id, title, filename, size, owner_email, is_shared, rendered_filename, source_filename, source_kind, source_language) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      doc.id,
      doc.title,
      doc.filename,
      doc.size,
      normalizeEmail(doc.owner_email),
      doc.is_shared,
      doc.rendered_filename ?? null,
      doc.source_filename ?? null,
      doc.source_kind ?? null,
      doc.source_language ?? null,
    );
  }

  async getDocument(id: string): Promise<DocumentRow | null> {
    const rows = this.sql.exec<DocumentRow>("SELECT * FROM documents WHERE id = ?", id).toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  async listDocuments(ownerEmail?: string): Promise<DocumentRow[]> {
    if (ownerEmail) {
      const normalizedOwnerEmail = normalizeEmail(ownerEmail);
      return this.sql
        .exec<DocumentRow>(
          "SELECT * FROM documents WHERE lower(owner_email) = ? ORDER BY created_at DESC LIMIT 500",
          normalizedOwnerEmail,
        )
        .toArray();
    }
    return this.sql.exec<DocumentRow>("SELECT * FROM documents ORDER BY created_at DESC LIMIT 500").toArray();
  }

  async listDocumentsPage(
    ownerEmail: string,
    options: { query?: string; limit: number; page: number },
  ): Promise<{ documents: DocumentRow[]; totalCount: number; page: number }> {
    const searchQuery = options.query?.trim() || "";
    const params: Array<string | number> = [normalizeEmail(ownerEmail)];
    let whereClause = "lower(owner_email) = ?";

    if (searchQuery) {
      whereClause += " AND (title LIKE ? ESCAPE '\\' OR filename LIKE ? ESCAPE '\\')";
      const escaped = searchQuery.replace(/[%_\\]/g, "\\$&");
      const likeQuery = `%${escaped}%`;
      params.push(likeQuery, likeQuery);
    }

    const countRows = this.sql
      .exec<{ count: number }>(
        `SELECT COUNT(*) as count FROM documents
         WHERE ${whereClause}`,
        ...params,
      )
      .toArray();
    const totalCount = Number(countRows[0]?.count || 0);
    const totalPages = Math.max(1, Math.ceil(totalCount / options.limit));
    const page = Math.min(Math.max(1, options.page), totalPages);
    const offset = (page - 1) * options.limit;

    const documents = this.sql
      .exec<DocumentRow>(
        `SELECT * FROM documents
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        ...params,
        options.limit,
        offset,
      )
      .toArray();

    return {
      documents,
      totalCount,
      page,
    };
  }

  async getDocumentByFilename(
    filename: string,
    ownerEmail: string,
    match: "source" | "rendered" | "any" = "any",
  ): Promise<DocumentRow | null> {
    let whereClause = "";
    const parameters: string[] = [normalizeEmail(ownerEmail)];

    if (match === "source") {
      whereClause = "source_filename = ? OR (source_filename IS NULL AND filename = ?)";
      parameters.push(filename, filename);
    } else if (match === "rendered") {
      whereClause = "rendered_filename = ? OR (rendered_filename IS NULL AND filename = ?)";
      parameters.push(filename, filename);
    } else {
      whereClause = "filename = ? OR rendered_filename = ? OR source_filename = ?";
      parameters.push(filename, filename, filename);
    }

    const rows = this.sql
      .exec<DocumentRow>(
        `SELECT * FROM documents
         WHERE lower(owner_email) = ?
           AND (${whereClause})
         LIMIT 1`,
        ...parameters,
      )
      .toArray();
    return rows.length > 0 ? rows[0] : null;
  }

  async updateDocument(id: string, updates: {
    title: string;
    filename: string;
    size: number;
    rendered_filename?: string | null;
    source_filename?: string | null;
    source_kind?: string | null;
    source_language?: string | null;
  }) {
    this.sql.exec(
      `UPDATE documents
       SET title = ?, filename = ?, size = ?, rendered_filename = ?, source_filename = ?, source_kind = ?, source_language = ?
       WHERE id = ?`,
      updates.title,
      updates.filename,
      updates.size,
      updates.rendered_filename ?? null,
      updates.source_filename ?? null,
      updates.source_kind ?? null,
      updates.source_language ?? null,
      id,
    );
  }

  async setDocumentShareMode(id: string, mode: number) {
    this.sql.exec("UPDATE documents SET is_shared = ? WHERE id = ?", mode, id);
    if (mode !== 2) {
      this.sql.exec("DELETE FROM shared_emails WHERE doc_id = ?", id);
    }
  }

  async setSharedEmails(docId: string, emails: string[]) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM shared_emails WHERE doc_id = ?", docId);
      for (const email of emails.slice(0, 100)) {
        this.sql.exec(
          "INSERT INTO shared_emails (doc_id, email) VALUES (?, ?)",
          docId,
          email.toLowerCase(),
        );
      }
    });
  }

  async getSharedEmails(docId: string): Promise<string[]> {
    return this.sql
      .exec<{ email: string }>("SELECT email FROM shared_emails WHERE doc_id = ? ORDER BY added_at ASC", docId)
      .toArray()
      .map((row) => row.email);
  }

  async recordView(userEmail: string, docId: string) {
    this.sql.exec(
      "INSERT INTO views (user_email, doc_id, last_viewed_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_email, doc_id) DO UPDATE SET last_viewed_at = datetime('now')",
      normalizeEmail(userEmail),
      docId,
    );
  }

  async getRecentViews(userEmail: string, limit = 20): Promise<RecentViewRow[]> {
    const normalizedUserEmail = normalizeEmail(userEmail);
    return this.sql
      .exec<RecentViewRow>(
        `SELECT d.id, d.title, d.filename, d.size, d.owner_email, d.created_at, v.last_viewed_at
       FROM views v JOIN documents d ON v.doc_id = d.id
       WHERE lower(v.user_email) = ?
       ORDER BY v.last_viewed_at DESC LIMIT ?`,
        normalizedUserEmail,
        limit,
      )
      .toArray();
  }

  async deleteDocument(id: string) {
    this.sql.exec("DELETE FROM shared_emails WHERE doc_id = ?", id);
    this.sql.exec("DELETE FROM documents WHERE id = ?", id);
  }
}
