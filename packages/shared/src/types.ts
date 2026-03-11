export interface Document {
  id: string;
  title: string;
  filename: string;
  size: number;
  owner_email: string;
  created_at: string;
}

export interface TextQuoteSelector {
  type: "TextQuoteSelector";
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TextPositionSelector {
  type: "TextPositionSelector";
  start: number;
  end: number;
}

export interface CssSelector {
  type: "CssSelector";
  value: string;
}

export interface RegionSelector {
  type: "RegionSelector";
  cssSelector: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Selector = TextQuoteSelector | TextPositionSelector | CssSelector | RegionSelector;

export interface Anchor {
  selectors: Selector[];
}

export interface Comment {
  id: string;
  document_id: string;
  author_email: string;
  author_name: string;
  author_color: string;
  content: string;
  anchor: Anchor | null;
  parent_id: string | null;
  resolved: boolean;
  created_at: string;
  updated_at: string;
}

export interface Reaction {
  id: string;
  document_id: string;
  author_email: string;
  author_name: string;
  emoji: string;
  anchor: Anchor;
  created_at: string;
}

export interface UserPresence {
  email: string;
  name: string;
  color: string;
  selection?: {
    anchor: Anchor;
    text: string;
  };
  last_seen: number;
}

export interface UserProfile {
  email: string;
  display_name: string;
  color: string;
  created_at: string;
}
