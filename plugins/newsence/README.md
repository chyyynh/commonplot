# Newsence MCP app

An MCP host (ChatGPT, Claude, or any client with OAuth and MCP Apps support)
connects to the user's Newsence library. It shows the reads it recommends as
cards, and the user presses **Save** to keep one; saves land in the user's
library and **public profile**, the same as saving a link in Newsence. The
model never saves on its own. It can also list the user's saves and read them
to answer from them.

## Package

This folder is one plugin package for both hosts:

| File | Read by |
| --- | --- |
| `plugin.json`, `mcp.json` | ChatGPT (Agent Plugins format; `extensions.com.openai` holds the listing and starter prompts) |
| `.claude-plugin/plugin.json`, `.mcp.json` | Claude |
| `skills/show-reading`, `skills/my-saves` | Both: when to show cards, and how to answer from saves |
| `assets/icon.png` | ChatGPT composer icon and logo |

Zip the folder's contents for upload: ChatGPT at platform.openai.com/plugins,
Claude at **Customize → Plugins → Add → Upload plugin**. Raise `version` in
both manifests on every release. Run `claude plugin validate ./newsence` from
`plugins/` before uploading. Tool and card changes need no new package: the
host rescans the MCP server.

## Connect

Add a remote MCP server with the URL `https://www.newsence.app/api/mcp`
and OAuth authentication. Discovery and dynamic client registration supply the
OAuth settings. Sign in to Newsence and allow the connection; disconnect at
`/auth/connections` (Settings → Account → Connected apps).

- **ChatGPT:** enable **Settings → Security and login → Developer mode**, then
  add the URL as an app.
- **Claude:** **Settings → Connectors → Add custom connector**.

After changing tools or the card, refresh the connection in the host and start
a new conversation; old messages keep the old card.

## Use

The model decides when to show cards from the skills, the `show_reading`
description and the server instructions (ChatGPT documents that it reads their
first 512 characters).
Hosts call apps sparingly, so a general question may still get a plain answer.
For a dependable result, users can:

- mention the app: `@Newsence recommend reading on MCP Apps`, or
  `@Newsence save https://…`;
- pick Newsence from the composer's tools before asking;
- add a standing rule to ChatGPT custom instructions or a Claude project:
  "When you recommend articles or videos, show them with Newsence."

Library questions such as "find the RAG evaluation paper I saved" or "what did
I save this week?" use `list_saves` and then `read_resource`.

## How it works

| Endpoint | Purpose |
| --- | --- |
| `POST /api/mcp` | `show_reading`, `list_saves`, `read_resource`, `list_latest_resources` (model); `save_urls`, `get_save_status` and `open_reader` (card only); `open_newsence` (ChatGPT sidebar) |
| `/.well-known/oauth-protected-resource/api/mcp` | Resource discovery |
| `/.well-known/oauth-authorization-server/api/auth` | Authorization server discovery |
| `/api/auth/oauth2/*` | Registration, authorization (PKCE S256), token, refresh |
| `/auth/consent` | Consent page |

- `show_reading` takes 1–10 URLs with the model's title and one-line reason,
  and returns them with any earlier saves so those cards show as saved.
- `list_saves` lists the user's profile saves in compact pages for the model;
  `read_resource` reads a save or public resource by id.
  Tool schemas and limits are in the developer docs (`mcp.md`).
- `save_urls` takes 1–10 HTTP(S) URLs and saves them for the token's user; it
  never accepts a user id. `ready` is saved and readable; `accepted` is received
  and prepared in the background by Core.
- The card (`ui://newsence/reading-list-v6.html`) is a standard MCP Apps view:
  React, `@modelcontextprotocol/ext-apps` and `@openai/apps-sdk-ui`, in
  `web-tanstack/src/server/plugin/widget/`. The `newsence-widget` plugin in
  `vite.config.ts` bundles it into the resource HTML. Its layout follows the
  chat source cards. It polls `get_save_status` a few times while saves are
  pending. Change its URI when the UI contract changes.
- **Read** on a saved card opens a full-screen reader in hosts that allow it
  (others open the Newsence page). `open_reader` returns the same resource
  projection as `/p/{id}`, and the view renders it with the app's
  `ResourceBody`; the widget build swaps the app's video player for a native
  one. The reader tells the model which item is open, so "summarize this"
  works. Images and math fonts from other origins stay blocked by the card's
  CSP and are hidden.
- Below the cards, **Summarize**, **Compare** and **Find related** send a
  prepared message listing the cards, in hosts that accept view messages.
- `open_newsence` is a ChatGPT global entrypoint (`openai/ui.entrypoints`):
  the sidebar and the plugin's **Open plugin** button open
  `ui://newsence/app-v1.html` full screen. That view frames
  `https://www.newsence.app` (`csp.frameDomains`); both views declare
  `ui.domain`. The model can call it (hosts render views only for those), but
  its result's `_meta`, which the model never sees, carries a
  one-time ticket (`verification` row, two minutes); `/api/auth/embed`
  consumes it and sets a session cookie with `SameSite=None; Partitioned`, so
  it exists only inside ChatGPT and the user's own newsence.app cookie is
  never sent to the frame. A `newsence_embed` cookie switches the app to
  embedded mode: no AI rail or chat, account menu, onboarding or upgrade
  links. The reader posts the open resource to the view, which passes it to
  the model with `updateModelContext`; host deep links
  (`openai/deepLink`) navigate the frame. HTML responses allow framing only
  by the app and ChatGPT (`frame-ancestors`). Submission must justify the
  iframe: it embeds Newsence's own app for the signed-in user.
- Every call requires OAuth, including `show_reading` and the public feed: hosts such as Claude
  decide whether to connect with OAuth from the first 401, so anonymous access
  would leave Save unusable there.
- `openai/*` metadata keys are ChatGPT extensions; other hosts ignore them.
- Access tokens are hour-long JWTs for the `newsence:save` and `newsence:read`
  scopes and the MCP URL audience; `offline_access` gives the host a refresh token. Every call also
  checks that the user's consent still exists, so disconnecting is immediate.
- Requests are limited per user and log only `NEWSENCE_PLUGIN_TIMING` durations,
  never URLs, user ids or tokens.

## Verify

From `web-tanstack/`, `pnpm test:plugin-auth` runs the real OAuth provider
in memory: registration, consent, separate accounts, audience/scope/signature
rejection, refresh, disconnect and code replay. It does not cover a real host,
the database or Core; check those against production with two accounts.
