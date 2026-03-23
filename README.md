# sharehtml

I've been using coding agents to write in markdown, make slides, and build interactive data analysis as static HTML files. Sending those files around still gets messy fast: you can't update them after sharing, and there's no way to get feedback inline. This is the reason I built sharehtml.

![sharehtml screenshot](assets/screenshot.png)

## What is sharehtml?

Deploy a local document, get a link where others can view it and collaborate with comments, reactions, and live presence. Re-deploy to update the content at the same URL. Markdown and common code files are converted to styled HTML automatically.

- **CLI deploys** — `sharehtml deploy report.html` → `https://sharehtml.yourteam.workers.dev/d/9brkzbe67ntm`
- **Collaborative** — comments, threaded replies, emoji reactions, text anchoring
- **Live presence** — see who's viewing and their selections
- **Home page** — your documents and recently viewed docs shared with you
- **Self-hosted** — runs on your own Cloudflare account

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ and [pnpm](https://pnpm.io/)
- [Bun](https://bun.sh/) (for the CLI and setup script)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) with [R2 enabled](https://developers.cloudflare.com/r2/pricing/#free-tier) (free tier available)

## Quick Start

```bash
git clone https://github.com/jonesphillip/sharehtml.git
cd sharehtml
pnpm install
npx wrangler login
pnpm run setup
```

The interactive setup script walks you through everything: deploying the worker, installing the CLI, and configuring authentication. Cloudflare Access is optional — the setup script asks if you want authentication. Without it, anyone with a link can view and comment.

To install the CLI directly:

```bash
# with Bun
bun install -g sharehtml

# or with npm (Bun still needs to be installed for the CLI runtime)
npm install -g sharehtml
```

If your team already has a sharehtml worker deployed, this is probably all you need — install the CLI, run `sharehtml config set-url <your-team-url>`, then `sharehtml login`.

If you enable Cloudflare Access, you'll need a [Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) with these permissions:
- **Account > Access: Apps and Policies > Edit**
- **Account > Access: Organization, Identity Providers, and Groups > Read**
- **Account > Workers Scripts > Read** (to resolve your workers.dev subdomain)

When it's done, try deploying one of the included examples:

```bash
sharehtml deploy example/coffee-report.html
# or try the markdown example:
sharehtml deploy example/sample.md
# or the interactive slideshow example:
sharehtml deploy example/nba-slideshow.html
# or deploy a code file:
sharehtml deploy apps/cli/src/index.ts
```

If a document with the same filename exists, the CLI will prompt to update it. Use `-u` to skip the prompt.

### Manual deploy

If you've already run setup and just need to redeploy:

```bash
pnpm run deploy
```

### Local development

```bash
pnpm dev
```

Starts the Vite dev server with Wrangler at http://localhost:5173. Local dev uses the default environment — `AUTH_MODE` is `"none"`, no login required.

To use the CLI locally:

```bash
sharehtml config set-url http://localhost:5173
sharehtml deploy my-report.html
```

## Architecture

```
CLI ──► Worker ──► R2 (HTML storage)
         │
Browser ◄┘──► Durable Objects
               ├── RegistryDO (users, documents, views)
               └── DocumentDO (per-doc comments, reactions, presence via WebSocket)
```

| Component | Purpose |
|-----------|---------|
| **[Worker](https://developers.cloudflare.com/workers/)** | HTTP routing, auth, serves viewer shell and home page |
| **RegistryDO** | Global [Durable Object](https://developers.cloudflare.com/durable-objects/) — users, document metadata, view history (SQLite) |
| **DocumentDO** | Per-document Durable Object — comments, reactions, real-time presence over WebSocket |
| **[R2](https://developers.cloudflare.com/r2/)** | Stores the actual HTML files |
| **CLI** | Bun-based command-line tool for deploying and managing documents |

## CLI Commands

| Command | Description |
|---------|-------------|
| `sharehtml deploy <file>` | Deploy an HTML, Markdown, or code file (creates or updates) |
| `sharehtml list` | List your documents |
| `sharehtml open <id>` | Open a document in the browser |
| `sharehtml pull <id>` | Download a document locally |
| `sharehtml diff <file>` | Compare local file against the deployed version |
| `sharehtml comments <id>` | Show unresolved comments for a document |
| `sharehtml delete <id>` | Delete a document |
| `sharehtml share <document>` | Share by link, or `--add`/`--remove` emails |
| `sharehtml unshare <document>` | Make a document private |
| `sharehtml login` | Log in through Cloudflare Access |
| `sharehtml config set-url <url>` | Set the sharehtml URL |
| `sharehtml config show` | Show current configuration |

## Configuration

Auth config lives in `wrangler.jsonc` under `env.production.vars`, set by `pnpm run setup`:

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_MODE` | Yes | `"none"` disables auth, `"access"` enables Cloudflare Access JWT verification |
| `ACCESS_AUD` | When `AUTH_MODE=access` | Cloudflare Access Application Audience tag |
| `ACCESS_TEAM` | When `AUTH_MODE=access` | Cloudflare Access team name |

## Project Structure

```
apps/
├── worker/
│   ├── src/
│   │   ├── index.ts                  # Hono app, routing
│   │   ├── routes/
│   │   │   ├── api.ts                # REST API (CRUD documents)
│   │   │   ├── viewer.ts             # Document viewer + WebSocket proxy
│   │   ├── durable-objects/
│   │   │   ├── registry.ts           # RegistryDO — users, docs, views
│   │   │   └── document.ts           # DocumentDO — comments, reactions, presence
│   │   ├── frontend/
│   │   │   ├── home.tsx              # Home page (document list)
│   │   │   ├── shell.tsx             # Document viewer shell
│   │   ├── client/
│   │   │   ├── shell-client.ts       # Viewer shell JS (presence, sidebar)
│   │   │   ├── collab-client.ts      # In-iframe collaboration (comments, reactions)
│   │   │   └── styles.css            # Shared styles
│   │   └── utils/
│   │       ├── auth.ts               # CF Access JWT verification
│   │       ├── registry.ts           # getRegistry() helper
│   │       ├── crypto.ts             # sha256 utility
│   │       ├── assets.ts             # Vite asset URL resolution
│   │       └── ids.ts                # nanoid generator
│   ├── scripts/
│   │   └── setup.ts                  # Interactive production setup script
│   └── wrangler.jsonc                # Cloudflare Workers config
├── cli/
│   └── src/
│       ├── index.ts                  # CLI entry point (commander)
│       ├── commands/                 # deploy, list, open, delete, config
│       ├── api/                      # HTTP client for worker API
│       └── config/                   # Local config store (~/.config/sharehtml)
└── packages/
    └── shared/                       # Shared types (messages, comments, reactions)
```

## License

Apache-2.0
