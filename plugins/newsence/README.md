# Newsence ChatGPT app

ChatGPT saves links the user asks for to their own Newsence account. Saves
land in the user's library and **public profile**, the same as saving a link
in Newsence.

## Connect

1. In ChatGPT, enable **Settings → Security and login → Developer mode**.
2. Add an app with the MCP URL `https://www.newsence.app/api/plugin/mcp` and
   OAuth authentication. Discovery and dynamic client registration supply the
   OAuth settings.
3. Sign in to Newsence and allow the connection. Disconnect at
   `/auth/connections` (Settings → Account → Connected apps).

After changing tools or the card, refresh the app in ChatGPT and start a new
conversation; old messages keep the old card.

## How it works

| Endpoint | Purpose |
| --- | --- |
| `POST /api/plugin/mcp` | `save_urls` (model) and `get_save_status` (card only) |
| `/.well-known/oauth-protected-resource/api/plugin/mcp` | Resource discovery |
| `/.well-known/oauth-authorization-server/api/auth` | Authorization server discovery |
| `/api/auth/oauth2/*` | Registration, authorization (PKCE S256), token, refresh |
| `/auth/consent` | Consent page |

- `save_urls` takes 1–10 HTTP(S) URLs and saves them for the token's user; it
  never accepts a user id. `ready` is saved and readable; `accepted` is received
  and prepared in the background by Core.
- The card (`ui://newsence/reading-list-v2.html`, source in
  `web-tanstack/src/server/plugin/widget/`) polls `get_save_status` a few times
  while items are pending. Change its URI when the UI contract changes.
- Access tokens are five-minute JWTs for the `newsence:save` scope and the MCP
  URL audience; `offline_access` gives ChatGPT a refresh token. Every call also
  checks that the user's consent still exists, so disconnecting is immediate.
- Requests are limited per user and log only `NEWSENCE_PLUGIN_TIMING` durations,
  never URLs, user ids or tokens.

## Verify

From `web-tanstack/`, `pnpm test:plugin-auth` runs the real OAuth provider
in memory: registration, consent, separate accounts, audience/scope/signature
rejection, refresh, disconnect and code replay. It does not cover ChatGPT, the
database or Core; check those against production with two accounts.
