import hljs from "highlight.js";

const ANSI_RESET = "\x1b[0m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_FG_RESET = "\x1b[39m";
const ANSI_BG_RESET = "\x1b[49m";

// Muted colors aligned with the sharehtml web app palette
const ANSI_TEXT = "\x1b[38;2;245;245;245m";
const ANSI_TEXT_MUTED = "\x1b[38;2;140;140;140m";
const ANSI_TEXT_FAINT = "\x1b[38;2;100;100;100m";
const ANSI_RED = "\x1b[38;2;200;100;100m";
const ANSI_GREEN = "\x1b[38;2;100;170;100m";

// Row backgrounds
const ANSI_ROW_DELETE_BG = "\x1b[48;2;60;32;32m";
const ANSI_ROW_INSERT_BG = "\x1b[48;2;28;54;34m";
const ANSI_ROW_CHANGE_DELETE_BG = "\x1b[48;2;56;34;34m";
const ANSI_ROW_CHANGE_INSERT_BG = "\x1b[48;2;30;50;36m";

// Token-level highlights
const ANSI_TOKEN_DELETE_BG = "\x1b[48;2;90;46;46m";
const ANSI_TOKEN_INSERT_BG = "\x1b[48;2;46;90;54m";

const DEFAULT_CONTEXT_LINES = 3;
const LINE_NUMBER_WIDTH = 5;
// prefix: "  123 - " = line number + space + gutter + space
const GUTTER_WIDTH = 3; // " - " or " + " or " ~ " or "   "
const PREFIX_WIDTH = LINE_NUMBER_WIDTH + GUTTER_WIDTH;

const EMPTY_LINE_PLACEHOLDER = "\u00b7"; // middle dot for blank lines

type DiffRow =
  | { type: "context"; left: string; right: string }
  | { type: "delete"; left: string }
  | { type: "insert"; right: string }
  | { type: "change"; left: string; right: string };

export interface NumberedDiffRow {
  row: DiffRow;
  leftNumber: number | null;
  rightNumber: number | null;
}

export interface DiffHunk {
  startLeft: number;
  startRight: number;
  rows: NumberedDiffRow[];
}

export interface DiffStats {
  insertions: number;
  deletions: number;
  changes: number;
}

export interface StructuredDiff {
  stats: DiffStats;
  hunks: DiffHunk[];
}

type TokenKind = "plain" | "keyword" | "string" | "comment" | "number" | "type" | "meta";

interface StyledSegment {
  text: string;
  color: string;
}

interface TextRange {
  start: number;
  end: number;
}

interface HighlightPalette {
  plain: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  type: string;
  meta: string;
}

// Earthy tones matching sharehtml's web highlight.css (dark terminal equivalents)
const NORMAL_PALETTE: HighlightPalette = {
  plain: "\x1b[38;2;200;200;200m",
  keyword: "\x1b[38;2;160;130;180m",  // dusty purple (#6b4d7d lightened)
  string: "\x1b[38;2;130;170;110m",   // olive green (#4e6b3a lightened)
  comment: "\x1b[38;2;140;138;134m",  // warm gray (#918d88 lightened)
  number: "\x1b[38;2;180;150;100m",   // amber (#7a5530 lightened)
  type: "\x1b[38;2;110;150;190m",     // steel blue (#2e5580 lightened)
  meta: "\x1b[38;2;150;140;120m",     // warm neutral (#76695a lightened)
};

// Slightly brighter for changed lines so they read well on tinted backgrounds
const CHANGED_PALETTE: HighlightPalette = {
  plain: "\x1b[38;2;220;220;220m",
  keyword: "\x1b[38;2;180;150;200m",
  string: "\x1b[38;2;150;190;130m",
  comment: "\x1b[38;2;170;168;164m",
  number: "\x1b[38;2;200;170;120m",
  type: "\x1b[38;2;130;170;210m",
  meta: "\x1b[38;2;170;160;140m",
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

// Myers diff - O(nd) time where d is the edit distance, O(n+m) space per trace step.
function myersDiff(left: string[], right: string[]): Array<{ type: "equal" | "delete" | "insert"; value: string }> {
  const n = left.length;
  const m = right.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return right.map((value) => ({ type: "insert" as const, value }));
  if (m === 0) return left.map((value) => ({ type: "delete" as const, value }));

  const max = n + m;
  const size = 2 * max + 1;
  const v = new Int32Array(size);
  v[1 + max] = 0;
  const trace: Int32Array[] = [];

  outer:
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + max] < v[k + 1 + max])) {
        x = v[k + 1 + max];
      } else {
        x = v[k - 1 + max] + 1;
      }
      let y = x - k;
      while (x < n && y < m && left[x] === right[y]) {
        x += 1;
        y += 1;
      }
      v[k + max] = x;
      if (x === n && y === m) break outer;
    }
  }

  const edits: Array<{ type: "equal" | "delete" | "insert"; value: string }> = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const tv = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && tv[k - 1 + max] < tv[k + 1 + max])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = tv[prevK + max];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      edits.push({ type: "equal", value: left[x] });
    }

    if (d > 0) {
      if (prevK === k + 1) {
        y -= 1;
        edits.push({ type: "insert", value: right[y] });
      } else {
        x -= 1;
        edits.push({ type: "delete", value: left[x] });
      }
    }
  }

  edits.reverse();
  return edits;
}

function buildDiffRows(leftText: string, rightText: string): DiffRow[] {
  const leftLines = splitLines(leftText);
  const rightLines = splitLines(rightText);
  const edits = myersDiff(leftLines, rightLines);

  const rawRows: Array<{ type: "context" | "delete" | "insert"; value: string }> = [];
  for (const edit of edits) {
    if (edit.type === "equal") {
      rawRows.push({ type: "context", value: edit.value });
    } else if (edit.type === "delete") {
      rawRows.push({ type: "delete", value: edit.value });
    } else {
      rawRows.push({ type: "insert", value: edit.value });
    }
  }

  const rows: DiffRow[] = [];
  let cursor = 0;

  while (cursor < rawRows.length) {
    if (rawRows[cursor].type === "context") {
      rows.push({
        type: "context",
        left: rawRows[cursor].value,
        right: rawRows[cursor].value,
      });
      cursor += 1;
      continue;
    }

    const deletes: string[] = [];
    const inserts: string[] = [];

    while (cursor < rawRows.length && rawRows[cursor].type !== "context") {
      if (rawRows[cursor].type === "delete") {
        deletes.push(rawRows[cursor].value);
      } else {
        inserts.push(rawRows[cursor].value);
      }
      cursor += 1;
    }

    const pairCount = Math.max(deletes.length, inserts.length);
    for (let index = 0; index < pairCount; index += 1) {
      const leftValue = deletes[index];
      const rightValue = inserts[index];

      if (leftValue !== undefined && rightValue !== undefined) {
        rows.push({ type: "change", left: leftValue, right: rightValue });
      } else if (leftValue !== undefined) {
        rows.push({ type: "delete", left: leftValue });
      } else if (rightValue !== undefined) {
        rows.push({ type: "insert", right: rightValue });
      }
    }
  }

  return rows;
}

function addLineNumbers(rows: DiffRow[]): NumberedDiffRow[] {
  const numberedRows: NumberedDiffRow[] = [];
  let leftNumber = 1;
  let rightNumber = 1;

  for (const row of rows) {
    if (row.type === "context") {
      numberedRows.push({ row, leftNumber, rightNumber });
      leftNumber += 1;
      rightNumber += 1;
      continue;
    }

    if (row.type === "delete") {
      numberedRows.push({ row, leftNumber, rightNumber: null });
      leftNumber += 1;
      continue;
    }

    if (row.type === "insert") {
      numberedRows.push({ row, leftNumber: null, rightNumber });
      rightNumber += 1;
      continue;
    }

    numberedRows.push({ row, leftNumber, rightNumber });
    leftNumber += 1;
    rightNumber += 1;
  }

  return numberedRows;
}

function getDiffStats(rows: NumberedDiffRow[]): DiffStats {
  let insertions = 0;
  let deletions = 0;
  let changes = 0;

  for (const row of rows) {
    if (row.row.type === "insert") {
      insertions += 1;
    } else if (row.row.type === "delete") {
      deletions += 1;
    } else if (row.row.type === "change") {
      deletions += 1;
      insertions += 1;
      changes += 1;
    }
  }

  return { insertions, deletions, changes };
}

function isChangedRow(row: NumberedDiffRow): boolean {
  return row.row.type !== "context";
}

function buildHunks(rows: NumberedDiffRow[], contextLines: number): DiffHunk[] {
  const changeIndexes = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => isChangedRow(row))
    .map(({ index }) => index);

  if (changeIndexes.length === 0) {
    return [];
  }

  const hunks: DiffHunk[] = [];
  let currentStart = Math.max(0, changeIndexes[0] - contextLines);
  let currentEnd = Math.min(rows.length - 1, changeIndexes[0] + contextLines);

  for (let index = 1; index < changeIndexes.length; index += 1) {
    const changeIndex = changeIndexes[index];
    const nextStart = Math.max(0, changeIndex - contextLines);
    const nextEnd = Math.min(rows.length - 1, changeIndex + contextLines);

    if (nextStart <= currentEnd + 1) {
      currentEnd = Math.max(currentEnd, nextEnd);
      continue;
    }

    const hunkRows = rows.slice(currentStart, currentEnd + 1);
    hunks.push({
      startLeft: hunkRows.find((row) => row.leftNumber !== null)?.leftNumber || 0,
      startRight: hunkRows.find((row) => row.rightNumber !== null)?.rightNumber || 0,
      rows: hunkRows,
    });

    currentStart = nextStart;
    currentEnd = nextEnd;
  }

  const lastRows = rows.slice(currentStart, currentEnd + 1);
  hunks.push({
    startLeft: lastRows.find((row) => row.leftNumber !== null)?.leftNumber || 0,
    startRight: lastRows.find((row) => row.rightNumber !== null)?.rightNumber || 0,
    rows: lastRows,
  });

  return hunks;
}

function tokenizeWords(text: string): string[] {
  return text.match(/\s+|[A-Za-z0-9_]+|./g) || [];
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
  if (ranges.length === 0) {
    return [];
  }

  const merged: TextRange[] = [{ ...ranges[0] }];
  for (let index = 1; index < ranges.length; index += 1) {
    const current = ranges[index];
    const previous = merged[merged.length - 1];
    if (current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

function buildChangedRanges(leftText: string, rightText: string): { left: TextRange[]; right: TextRange[] } {
  const leftTokens = tokenizeWords(leftText);
  const rightTokens = tokenizeWords(rightText);
  const edits = myersDiff(leftTokens, rightTokens);

  const leftRanges: TextRange[] = [];
  const rightRanges: TextRange[] = [];
  let leftOffset = 0;
  let rightOffset = 0;

  for (const edit of edits) {
    if (edit.type === "equal") {
      leftOffset += edit.value.length;
      rightOffset += edit.value.length;
    } else if (edit.type === "delete") {
      leftRanges.push({ start: leftOffset, end: leftOffset + edit.value.length });
      leftOffset += edit.value.length;
    } else {
      rightRanges.push({ start: rightOffset, end: rightOffset + edit.value.length });
      rightOffset += edit.value.length;
    }
  }

  return {
    left: mergeRanges(leftRanges),
    right: mergeRanges(rightRanges),
  };
}

function getTokenKind(className: string): TokenKind {
  if (
    className.includes("hljs-keyword") ||
    className.includes("hljs-selector-tag") ||
    className.includes("hljs-built_in")
  ) {
    return "keyword";
  }

  if (className.includes("hljs-string") || className.includes("hljs-attr")) {
    return "string";
  }

  if (className.includes("hljs-comment") || className.includes("hljs-quote")) {
    return "comment";
  }

  if (
    className.includes("hljs-number") ||
    className.includes("hljs-literal") ||
    className.includes("hljs-variable.constant_")
  ) {
    return "number";
  }

  if (
    className.includes("hljs-type") ||
    className.includes("hljs-title") ||
    className.includes("hljs-title.class_") ||
    className.includes("hljs-title.function_")
  ) {
    return "type";
  }

  if (className.includes("hljs-meta") || className.includes("hljs-tag")) {
    return "meta";
  }

  return "plain";
}

function segmentsFromHighlightedHtml(html: string, palette: HighlightPalette): StyledSegment[] {
  const pattern = /<span class="([^"]+)">|<\/span>/g;
  const segments: StyledSegment[] = [];
  const colorStack: string[] = [palette.plain];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const text = decodeHtmlEntities(html.slice(lastIndex, match.index));
    if (text.length > 0) {
      segments.push({ text, color: colorStack[colorStack.length - 1] });
    }
    lastIndex = pattern.lastIndex;

    if (match[0] === "</span>") {
      if (colorStack.length > 1) {
        colorStack.pop();
      }
    } else {
      colorStack.push(palette[getTokenKind(match[1])]);
    }
  }

  const trailingText = decodeHtmlEntities(html.slice(lastIndex));
  if (trailingText.length > 0) {
    segments.push({ text: trailingText, color: colorStack[colorStack.length - 1] });
  }

  if (segments.length === 0) {
    return [{ text: "", color: palette.plain }];
  }

  return segments;
}

function highlightModeForLine(line: string, language?: string): string | null {
  if (!language) {
    return null;
  }

  if (language === "html") {
    const trimmed = line.trim();
    if (trimmed.startsWith("<") || trimmed.startsWith("<!--")) {
      return "xml";
    }

    const detected = hljs.highlightAuto(line, ["javascript", "typescript", "css", "xml"]);
    return detected.language || "xml";
  }

  if (hljs.getLanguage(language)) {
    return language;
  }

  return null;
}

function highlightSegments(line: string, language: string | undefined, palette: HighlightPalette): StyledSegment[] {
  const mode = highlightModeForLine(line, language);
  if (!mode) {
    return [{ text: line, color: palette.plain }];
  }

  const highlighted = hljs.highlight(line, { language: mode }).value;
  return segmentsFromHighlightedHtml(highlighted, palette);
}

function renderSegments(segments: StyledSegment[]): string {
  let output = "";
  let currentColor = "";

  for (const segment of segments) {
    if (segment.color !== currentColor) {
      output += segment.color;
      currentColor = segment.color;
    }
    output += segment.text;
  }

  return `${output}${ANSI_FG_RESET}`;
}

function renderSegmentsWithHighlights(
  segments: StyledSegment[],
  ranges: TextRange[],
  rowBackground: string,
  tokenBackground: string,
): string {
  if (ranges.length === 0) {
    return renderSegments(segments);
  }

  let output = "";
  let offset = 0;
  let activeColor = "";

  for (const segment of segments) {
    const segmentStart = offset;
    const segmentEnd = offset + segment.text.length;
    let cursor = 0;

    for (const range of ranges) {
      if (range.end <= segmentStart || range.start >= segmentEnd) {
        continue;
      }

      const overlapStart = Math.max(range.start, segmentStart) - segmentStart;
      const overlapEnd = Math.min(range.end, segmentEnd) - segmentStart;

      if (cursor < overlapStart) {
        if (segment.color !== activeColor) {
          output += segment.color;
          activeColor = segment.color;
        }
        output += segment.text.slice(cursor, overlapStart);
      }

      output += `${tokenBackground}${segment.color}`;
      activeColor = segment.color;
      output += segment.text.slice(overlapStart, overlapEnd);
      output += `${ANSI_BG_RESET}${rowBackground}${segment.color}`;

      cursor = overlapEnd;
    }

    if (cursor < segment.text.length) {
      if (segment.color !== activeColor) {
        output += segment.color;
        activeColor = segment.color;
      }
      output += segment.text.slice(cursor);
    }

    offset = segmentEnd;
  }

  return `${output}${ANSI_FG_RESET}`;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;

function visibleWidth(text: string): number {
  ANSI_ESCAPE_RE.lastIndex = 0;
  return text.replace(ANSI_ESCAPE_RE, "").length;
}

function padAnsi(text: string, width: number): string {
  const padding = Math.max(0, width - visibleWidth(text));
  return `${text}${" ".repeat(padding)}`;
}

const ANSI_AT_POS_RE = /\x1b\[[0-9;]*m/y;

function wrapAnsiLine(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  let currentLine = "";
  let currentVisible = 0;
  let index = 0;
  let activeEscapes = "";

  while (index < text.length) {
    if (text[index] === "\x1b") {
      ANSI_AT_POS_RE.lastIndex = index;
      const match = ANSI_AT_POS_RE.exec(text);
      if (match) {
        currentLine += match[0];
        activeEscapes += match[0];
        index += match[0].length;
        continue;
      }
    }

    if (currentVisible >= maxWidth) {
      lines.push(currentLine);
      currentLine = activeEscapes;
      currentVisible = 0;
    }

    currentLine += text[index];
    currentVisible += 1;
    index += 1;
  }

  if (currentLine.length > 0 || lines.length === 0) {
    lines.push(currentLine);
  }

  return lines;
}

function formatLineNumber(lineNumber: number | null): string {
  if (lineNumber === null) {
    return " ".repeat(LINE_NUMBER_WIDTH);
  }

  return String(lineNumber).padStart(LINE_NUMBER_WIDTH, " ");
}

function makePrefix(lineNumber: number | null, gutter: string): string {
  return `${ANSI_TEXT_FAINT}${formatLineNumber(lineNumber)} ${gutter}${ANSI_FG_RESET} `;
}

function makeContinuationPrefix(background: string | null): string {
  const wrapChar = background ? `${ANSI_TEXT_FAINT}\\${ANSI_FG_RESET}` : " ";
  return `${ANSI_TEXT_FAINT}${" ".repeat(LINE_NUMBER_WIDTH)} ${wrapChar}${ANSI_FG_RESET} `;
}

function renderHeader(remoteLabel: string, localLabel: string, stats: DiffStats): string {
  const parts = [
    `${ANSI_BOLD}${ANSI_TEXT}diff${ANSI_RESET}`,
    `${ANSI_TEXT_MUTED}${remoteLabel} -> ${localLabel}${ANSI_FG_RESET}`,
  ];

  if (stats.insertions > 0) {
    parts.push(`${ANSI_GREEN}+${stats.insertions}${ANSI_FG_RESET}`);
  }
  if (stats.deletions > 0) {
    parts.push(`${ANSI_RED}-${stats.deletions}${ANSI_FG_RESET}`);
  }

  return parts.join("  ");
}

function renderCollapsedSection(hiddenLines: number): string {
  return `${ANSI_TEXT_FAINT}${" ".repeat(LINE_NUMBER_WIDTH)}   ... ${hiddenLines} unchanged ...${ANSI_FG_RESET}`;
}

function applyLineBackground(text: string, background: string): string {
  return `${background}${text}${ANSI_BG_RESET}`;
}

function renderContentLines(
  lineNumber: number | null,
  gutter: string,
  content: string,
  contentWidth: number,
  background: string | null,
): string[] {
  // Show a placeholder for empty lines so they're visible
  const displayContent = visibleWidth(content) === 0 && background
    ? `${ANSI_TEXT_FAINT}${EMPTY_LINE_PLACEHOLDER}${ANSI_FG_RESET}`
    : content;

  const wrapped = wrapAnsiLine(displayContent, contentWidth);
  const result: string[] = [];

  for (let i = 0; i < wrapped.length; i += 1) {
    const prefix = i === 0
      ? makePrefix(lineNumber, gutter)
      : makeContinuationPrefix(background);
    const line = padAnsi(`${prefix}${wrapped[i]}`, contentWidth + PREFIX_WIDTH);
    result.push(background ? applyLineBackground(line, background) : line);
  }

  return result;
}

function renderPrettyDiff(
  hunks: DiffHunk[],
  stats: DiffStats,
  remoteLabel: string,
  localLabel: string,
  terminalWidth: number,
  language?: string,
): string {
  const output = [renderHeader(remoteLabel, localLabel, stats)];

  const contentWidth = Math.max(20, terminalWidth - PREFIX_WIDTH - 1);
  let previousHunkEnd = 0;

  for (const hunk of hunks) {
    if (previousHunkEnd > 0) {
      const nextStart = Math.min(
        ...hunk.rows.flatMap((row) => [
          row.leftNumber || Number.MAX_SAFE_INTEGER,
          row.rightNumber || Number.MAX_SAFE_INTEGER,
        ]),
      );
      const hiddenLines = Math.max(0, nextStart - previousHunkEnd - 1);
      if (hiddenLines > 0) {
        output.push(renderCollapsedSection(hiddenLines));
      }
    }

    output.push(`${ANSI_TEXT_FAINT}${" ".repeat(LINE_NUMBER_WIDTH)}   @@ -${hunk.startLeft} +${hunk.startRight} @@${ANSI_FG_RESET}`);

    for (const numberedRow of hunk.rows) {
      if (numberedRow.row.type === "context") {
        const content = renderSegments(
          highlightSegments(numberedRow.row.left, language, NORMAL_PALETTE),
        );
        output.push(...renderContentLines(numberedRow.leftNumber, " ", content, contentWidth, null));
      } else if (numberedRow.row.type === "delete") {
        const content = renderSegments(
          highlightSegments(numberedRow.row.left, language, CHANGED_PALETTE),
        );
        output.push(...renderContentLines(numberedRow.leftNumber, "-", content, contentWidth, ANSI_ROW_DELETE_BG));
      } else if (numberedRow.row.type === "insert") {
        const content = renderSegments(
          highlightSegments(numberedRow.row.right, language, CHANGED_PALETTE),
        );
        output.push(...renderContentLines(numberedRow.rightNumber, "+", content, contentWidth, ANSI_ROW_INSERT_BG));
      } else {
        const ranges = buildChangedRanges(numberedRow.row.left, numberedRow.row.right);
        const leftContent = renderSegmentsWithHighlights(
          highlightSegments(numberedRow.row.left, language, CHANGED_PALETTE),
          ranges.left,
          ANSI_ROW_CHANGE_DELETE_BG,
          ANSI_TOKEN_DELETE_BG,
        );
        const rightContent = renderSegmentsWithHighlights(
          highlightSegments(numberedRow.row.right, language, CHANGED_PALETTE),
          ranges.right,
          ANSI_ROW_CHANGE_INSERT_BG,
          ANSI_TOKEN_INSERT_BG,
        );

        output.push(...renderContentLines(numberedRow.leftNumber, "~", leftContent, contentWidth, ANSI_ROW_CHANGE_DELETE_BG));
        output.push(...renderContentLines(numberedRow.rightNumber, "~", rightContent, contentWidth, ANSI_ROW_CHANGE_INSERT_BG));
      }
    }

    const lastRow = hunk.rows[hunk.rows.length - 1];
    previousHunkEnd = Math.max(lastRow.leftNumber || 0, lastRow.rightNumber || 0);
  }

  return output.join("\n");
}

export function buildStructuredDiff(remoteText: string, localText: string, contextLines = DEFAULT_CONTEXT_LINES): StructuredDiff {
  const rows = addLineNumbers(buildDiffRows(remoteText, localText));
  return {
    stats: getDiffStats(rows),
    hunks: buildHunks(rows, contextLines),
  };
}

export function renderTerminalDiff(
  remoteText: string,
  localText: string,
  remoteLabel: string,
  localLabel: string,
  language?: string,
): string {
  const diff = buildStructuredDiff(remoteText, localText);
  const terminalWidth = process.stdout.columns || 120;
  return renderPrettyDiff(diff.hunks, diff.stats, remoteLabel, localLabel, terminalWidth, language);
}

export function diffHasChanges(localText: string, remoteText: string): boolean {
  return localText.replace(/\r\n/g, "\n") !== remoteText.replace(/\r\n/g, "\n");
}
