export type AuthMode = Env["AUTH_MODE"];
export type ShareMode = "private" | "link" | "emails";

export function isShareMode(value: unknown): value is ShareMode {
  return value === "private" || value === "link" || value === "emails";
}

export function shareModeFromInt(n: number): ShareMode {
  switch (n) {
    case 1: return "link";
    case 2: return "emails";
    default: return "private";
  }
}

export function shareModeToInt(mode: ShareMode): number {
  switch (mode) {
    case "link": return 1;
    case "emails": return 2;
    default: return 0;
  }
}

export type DocumentRow = {
  id: string;
  title: string;
  filename: string;
  size: number;
  owner_email: string;
  is_shared: number;
  created_at: string;
};

export type RecentViewRow = {
  id: string;
  title: string;
  filename: string;
  size: number;
  owner_email: string;
  created_at: string;
  // is_shared omitted: the JOIN query doesn't select it, and views are read-only
  last_viewed_at: string;
};

export type UserRow = {
  email: string;
  display_name: string;
  color: string;
};

export type CommentRow = {
  id: string;
  author_email: string;
  author_name: string;
  author_color: string;
  content: string;
  anchor: string | null;
  parent_id: string | null;
  resolved: number;
  created_at: string;
  updated_at: string;
};

export type ReactionRow = {
  id: string;
  author_email: string;
  author_name: string;
  emoji: string;
  anchor: string;
  created_at: string;
};

export type DocumentSnapshot = {
  comments: import("@sharehtml/shared").Comment[];
  reactions: import("@sharehtml/shared").Reaction[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDocumentSnapshot(value: unknown): DocumentSnapshot | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.comments) || !Array.isArray(value.reactions)) return null;
  for (const c of value.comments) {
    if (!isRecord(c) || typeof c.id !== "string" || typeof c.content !== "string") return null;
  }
  for (const r of value.reactions) {
    if (!isRecord(r) || typeof r.id !== "string" || typeof r.emoji !== "string") return null;
  }
  return value as DocumentSnapshot;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    authUser: import("./utils/auth.js").AuthUser;
  };
};
