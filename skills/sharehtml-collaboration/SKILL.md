---
name: sharehtml-collaboration
description: Use when a user wants to deploy, update, diff, pull, or review feedback on documents managed with the sharehtml CLI. This skill covers safe deploy workflows, reviewing unresolved comments, finding documents by name with `sharehtml list`, and presenting diffs in human language before overwriting. Keep documents private by default and only make them shareable if the user explicitly asks.
---

## When to use

Use this skill whenever the task involves a document managed with `sharehtml`, including:

- deploying or updating a local document
- sharing or unsharing a document
- pulling a remote document locally
- comparing local changes against the deployed document
- reviewing unresolved comments and addressing feedback

`sharehtml` can deploy supported source files directly, including `.html`, `.md`, `.markdown`, `.json`, and common code files such as `.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.rb`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.css`, and `.sh`.

Do not wrap code or Markdown in HTML unless the user explicitly asks for that.
If the file is binary or not a supported text/source format, do not try to deploy it directly.

## Default behavior

- Keep documents private by default.
- Never run `sharehtml share ...` unless the user explicitly asks to make a document shareable.
- If a deploy would overwrite an existing document, do not blindly confirm it.
- Before overwriting, run `sharehtml diff <file>`, summarize the changes in plain language, and ask the user to confirm.
- When a command needs a document id and the user only knows the document name, use `sharehtml list` to find candidates. If multiple matches are plausible, ask the user to choose.

## Workflows

### Deploy or update a document

1. Verify the file is a supported format.
2. Run `sharehtml deploy <file>`.
3. If the CLI indicates the document already exists and would be updated:
   - run `sharehtml diff <file>`
   - summarize the proposed changes in human language
   - ask the user whether to proceed with the overwrite
4. Only make the document shareable if the user explicitly asks.

### Review and address feedback

1. Resolve the document id or URL.
   - If only a name is given, use `sharehtml list`.
2. Run `sharehtml comments <id> --json`.
3. Pull the document locally if needed with `sharehtml pull <id>`.
4. Make the requested local changes.
5. Run `sharehtml diff <file>`.
6. Summarize the changes in human language and ask for approval before deploying.
7. Run `sharehtml deploy <file>` once approved.

## Key commands

- `sharehtml deploy <file>` -- deploy or update a local document
- `sharehtml diff <file>` -- compare local content against the deployed document
- `sharehtml pull <id>` -- download the remote file
- `sharehtml comments <id>` -- read unresolved comments (`--json` for machine-readable output)
- `sharehtml list` -- find documents by title or filename
- `sharehtml open <id>` -- open a document in the browser
- `sharehtml share <document>` -- make a document shareable
- `sharehtml unshare <document>` -- make a document private

## Resolving a document

Prefer:

1. document URL
2. document id
3. `sharehtml list` lookup by filename/title

If `sharehtml list` returns multiple plausible matches, show the candidates and ask the user which one they mean.

## Safety rules

- Treat `sharehtml share` as opt-in only.
- If a user says "share this", that permits making the document shareable.
- If a user only says "deploy this" or "upload this", do not make the document shareable.
- Do not paste raw diff output unless the user asks for it.
