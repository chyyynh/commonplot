# Newsence — search, then read later

Demo flow: ask ChatGPT to find reading material, choose links, and save them to your own Newsence account. Other people sign in to their own accounts and grant their own permission. Search uses ChatGPT's web search; Newsence acquires the selected URLs through its existing Core pipeline.

**This is source code for a demo. Deploy the server and run its database migration before connecting ChatGPT.** The package URL targets `www.newsence.app`, matching the production auth origin; change it when testing a different deployment.

## Try it in ChatGPT

After deployment:

1. Enable **Settings → Security and login → Developer mode**, if available for your account/workspace.
2. Open [ChatGPT Plugins](https://chatgpt.com/plugins), select **+**, and add **Newsence** using the MCP URL `https://www.newsence.app/api/plugin/mcp` and OAuth authentication. Discovery and dynamic client registration supply the OAuth settings; do not paste a shared API key.
3. Sign in to Newsence with email OTP or Google and approve the connection.
4. Enable the connection and web search in a new conversation. Try the prompts below.
5. Manage or revoke access in **Newsence settings → Account → Connected apps**, or `/auth/connections`.

The portable `plugin.json` and `mcp.json` files also describe this MCP plugin for supported plugin hosts. Saving renders an inline reading card in MCP Apps hosts such as ChatGPT. No model API key or separate search API is required. Connecting a demo does not publish it to the public plugin directory.

## Reading card

`save_urls` renders `ui://newsence/reading-list-v2.html` using the standard MCP Apps bridge. It shows canonical article titles, sources, save states, original links and **Read in Newsence** buttons. ChatGPT should use a short natural-language acknowledgement instead of repeating technical results. Refresh the plugin's tools in ChatGPT after deploying this update, then start a fresh conversation; old messages do not gain the new UI retroactively.

The model finishes immediately after `save_urls` returns. A new URL receives a durable import receipt before any background acquisition; receipt does not promise that content is already readable. The card counts received links separately from per-item content readiness.

The card calls the app-only, read-only `get_save_status` through the host using the existing OAuth grant. Pending saves refresh at most six times, with backoff and a pause while the document is hidden. Users can also refresh manually. Failed calls stop automatic retries and show a recovery message. Only `ready` records expose a Newsence reading button; a completed progress record without current ownership is not proof of a save. The card cannot call the write tool.

The view is self-contained: no external scripts, fonts, images, direct API requests, cookies, or access tokens. Titles render as text, source links allow only HTTP(S), and Newsence links allow only the configured application origin. English and Traditional Chinese copy comes from Paraglide. The card supports light/dark mode, narrow layouts, keyboard access and reduced motion. Source lives in `web-tanstack/src/server/plugin/widget/` with its resource wrapper in `widget.server.ts`. Change the resource URI when changing the UI contract so hosts do not reuse an incompatible cached template.

[OpenAI connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) · [OAuth guide](https://developers.openai.com/plugins/build/auth) · [Package format](https://developers.openai.com/plugins/build/plugins)

## Demo prompts

> 幫我找三篇適合入門 RAG 的文章，先列出來源和推薦理由。

Expected: web search and linked recommendations; no save call yet.

> 把第 1 和第 3 篇存到 Newsence，讓我晚點讀。

Expected: `save_urls` with those exact two source URLs and an inline reading card. A `ready` result is saved and readable. An `accepted` result means the link was durably received: acknowledge it immediately (for example, “連結已收下，內容會在背景整理。”). The model must not wait for content preparation or make a follow-up status call. The card checks progress independently. Hosts without UI acknowledge receipt and link to Newsence without waiting.

Click **更新狀態** in the card to check background preparation. `get_save_status` is visible only to the app so the model cannot add it to the save flow. `not_saved` can also mean that a past processing record is no longer retained.

> 幫我找兩篇介紹 local-first software 的文章，然後存到 Newsence。

Expected: web search, then a save because the user requested both actions. The host may present its own write confirmation.

**Visibility:** This demo reuses Newsence's existing profile-save behavior. Saved links appear on the user's **public profile**. The authorization page and tool descriptions explain this. It is not a private inbox.

## Server setup

From `web-tanstack/`, use `pnpm install --frozen-lockfile`. The migration `20261001000000_newsence_plugin_oauth` adds OAuth clients, consents, tokens, resources and signing keys. It does not alter existing resource or save records.

Apply migrations in the chosen deployment environment with an explicit `DIRECT_DATABASE_URL`:

```sh
pnpm db:migrate:deploy
pnpm deploy
```

Set `DIRECT_DATABASE_URL` securely in the shell/operator environment before the migration command. Do not put credentials in this package. Web deployment itself does not run migrations.

Keep `VITE_APP_URL` equal to the public HTTPS origin used by ChatGPT; it determines the issuer, resource audience, callback routing and returned links. Preserve the existing `BETTER_AUTH_SECRET`, trusted origins, Google/OTP configuration, Core service binding and ResourceProgress binding. All users connect through the same server but tokens select their individual Newsence user.

For a local or isolated preview, use a disposable migrated database plus the existing Web/Core/ResourceProgress runtime, and provide a reachable HTTPS endpoint. Do not point the preview at a shared database merely to test OAuth.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/plugin/mcp` | Authenticated `save_urls` and `get_save_status` |
| `/.well-known/oauth-protected-resource/api/plugin/mcp` | Resource discovery |
| `/.well-known/oauth-authorization-server/api/auth` | Authorization server discovery |
| `/api/auth/oauth2/register` | OAuth client registration; grants no user access |
| `/api/auth/oauth2/authorize` | Login and consent flow with PKCE S256 |
| `/api/auth/oauth2/token` | Code exchange and refresh |
| `/api/auth/jwks` | Public verification keys |
| `/auth/consent` | Localized authorization page |
| `/auth/connections` | User-owned connection management |

`/api/mcp` remains the separate anonymous, read-only public search endpoint.

The save endpoint accepts 1–10 HTTP(S) URLs, rejects unknown arguments such as a caller-supplied user ID, and uses the authenticated subject. Core handles URL acquisition and canonical persistence; Web adds the user's profile save after processing. The status endpoint only reports whether those requested URLs belong to that user's saved profile.

Tokens require `newsence:save`, the exact resource audience and a live user consent. JWTs carry the consent ID, so disconnecting prevents subsequent requests and reconnecting cannot revive old tokens. An already accepted asynchronous import can still finish after disconnecting. `offline_access` allows refresh tokens. Account deletion and disabled clients are rejected at the MCP boundary.

## Verification

From `web-tanstack/`:

```sh
pnpm test:plugin-auth
pnpm check
pnpm run typecheck
pnpm build
```

The protocol test uses Better Auth's real OAuth provider, OTP flow, in-memory adapter and an ephemeral loopback HTTP server for JWKS. It exercises discovery, registration, consent denial, signed-query tampering, separate accounts, signature/audience/scope rejection, refresh, disconnect, reconnect and authorization-code replay. It sends no email and touches no external database.

This test does not replace deployment verification: test actual PostgreSQL persistence, Google login, ChatGPT tool discovery and Core's save completion against the chosen preview before inviting others. Use two separate Newsence accounts; verify each profile gets only its requested saves, and that revoking one account leaves the other connected.

MCP requests and tool execution emit `NEWSENCE_PLUGIN_TIMING` with durations, tool name and success/status only. They do not log URLs, user IDs or tokens. Use these timings to distinguish server work from host/model latency; ChatGPT’s overall turn duration is not the server duration.
