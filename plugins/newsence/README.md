# Newsence MCP app

An MCP host (ChatGPT, Claude, or any client with OAuth and MCP Apps support)
shows the reads it recommends as cards, and the user presses **Save** to keep
one in their own Newsence account. Saves land in the user's library and
**public profile**, the same as saving a link in Newsence. The model never
saves on its own.

## Connect

Add a remote MCP server with the URL `https://www.newsence.app/api/plugin/mcp`
and OAuth authentication. Discovery and dynamic client registration supply the
OAuth settings. Sign in to Newsence and allow the connection; disconnect at
`/auth/connections` (Settings → Account → Connected apps).

- **ChatGPT:** enable **Settings → Security and login → Developer mode**, then
  add the URL as an app.
- **Claude:** **Settings → Connectors → Add custom connector**.

After changing tools or the card, refresh the connection in the host and start
a new conversation; old messages keep the old card.

## Use

The model decides when to show cards, from the `show_reading` description and
the server instructions (Claude reads them; ChatGPT's support is undocumented).
Hosts call apps sparingly, so a general question may still get a plain answer.
For a dependable result, users can:

- mention the app: `@Newsence recommend reading on MCP Apps`, or
  `@Newsence save https://…`;
- pick Newsence from the composer's tools before asking;
- add a standing rule to ChatGPT custom instructions or a Claude project:
  "When you recommend articles or videos, show them with Newsence."

## How it works

| Endpoint | Purpose |
| --- | --- |
| `POST /api/plugin/mcp` | `show_reading` (model); `save_urls` and `get_save_status` (card only) |
| `/.well-known/oauth-protected-resource/api/plugin/mcp` | Resource discovery |
| `/.well-known/oauth-authorization-server/api/auth` | Authorization server discovery |
| `/api/auth/oauth2/*` | Registration, authorization (PKCE S256), token, refresh |
| `/auth/consent` | Consent page |

- `show_reading` takes 1–10 URLs with the model's title and one-line reason,
  and returns them with any earlier saves so those cards show as saved.
- `save_urls` takes 1–10 HTTP(S) URLs and saves them for the token's user; it
  never accepts a user id. `ready` is saved and readable; `accepted` is received
  and prepared in the background by Core.
- The card (`ui://newsence/reading-list-v4.html`) is a standard MCP Apps view:
  React, `@modelcontextprotocol/ext-apps` and `@openai/apps-sdk-ui`, in
  `web-tanstack/src/server/plugin/widget/`. The `newsence-widget` plugin in
  `vite.config.ts` bundles it into the resource HTML. Its layout follows the
  chat source cards. It polls `get_save_status` a few times while saves are
  pending. Change its URI when the UI contract changes.
- Every call requires OAuth, including `show_reading`: hosts such as Claude
  decide whether to connect with OAuth from the first 401, so anonymous access
  would leave Save unusable there.
- `openai/*` metadata keys are ChatGPT extensions; other hosts ignore them.
- Access tokens are five-minute JWTs for the `newsence:save` scope and the MCP
  URL audience; `offline_access` gives the host a refresh token. Every call also
  checks that the user's consent still exists, so disconnecting is immediate.
- Requests are limited per user and log only `NEWSENCE_PLUGIN_TIMING` durations,
  never URLs, user ids or tokens.

## Verify

From `web-tanstack/`, `pnpm test:plugin-auth` runs the real OAuth provider
in memory: registration, consent, separate accounts, audience/scope/signature
rejection, refresh, disconnect and code replay. It does not cover a real host,
the database or Core; check those against production with two accounts.
