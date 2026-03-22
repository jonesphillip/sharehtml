# sharehtml

I've been using coding agents to write in markdown, make slides, and build interactive data analysis as static HTML files. Sending those files around still gets messy fast: you can't update them after sharing, and there's no way to get feedback inline. This is the reason I built sharehtml.

This package is the Bun CLI for deploying documents to a sharehtml worker.

## What is sharehtml?

Deploy a local document, get a link where others can view it and collaborate with comments, reactions, and live presence. Re-deploy to update the content at the same URL. Markdown and common code files are converted to styled HTML automatically.

- **CLI deploys** — `sharehtml deploy report.html` → `https://sharehtml.yourteam.workers.dev/d/9brkzbe67ntm`
- **Collaborative** — comments, threaded replies, emoji reactions, text anchoring
- **Live presence** — see who's viewing and their selections
- **Home page** — your documents and recently viewed docs shared with you
- **Self-hosted** — runs on your own Cloudflare account

## Prerequisites

- [Bun](https://bun.sh/) (required runtime for the CLI)
- A deployed sharehtml worker URL

If your team already has a sharehtml worker deployed, this package is probably all you need.

## Install

```bash
# with Bun
bun install -g sharehtml

# or with npm (Bun still needs to be installed for the CLI runtime)
npm install -g sharehtml
```

## Quick Start

Set your team URL:

```bash
sharehtml config set-url https://sharehtml.yourteam.workers.dev
```

If your deployment uses Cloudflare Access, log in:

```bash
sharehtml login
```

Then deploy a document:

```bash
sharehtml deploy report.html
```

You can also deploy Markdown and common code files:

```bash
sharehtml deploy notes.md
sharehtml deploy metrics.json
sharehtml deploy app.ts
```

If a document with the same filename exists, the CLI will prompt to update it. Use `-u` to skip the prompt.

## Common Commands

| Command | Description |
|---------|-------------|
| `sharehtml deploy <file>` | Deploy an HTML, Markdown, or code file |
| `sharehtml list` | List your documents |
| `sharehtml open <id>` | Open a document in the browser |
| `sharehtml pull <id>` | Download a document locally |
| `sharehtml delete <id>` | Delete a document |
| `sharehtml share <document>` | Share by link, or `--add`/`--remove` emails |
| `sharehtml unshare <document>` | Make a document private |
| `sharehtml login` | Log in through Cloudflare Access |
| `sharehtml config set-url <url>` | Set the sharehtml URL |
| `sharehtml config show` | Show current configuration |

## Need to deploy your own sharehtml worker?

See the main repository for setup instructions:

https://github.com/jonesphillip/sharehtml
