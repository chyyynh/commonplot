# commonplot MCP app

An MCP host (ChatGPT, Claude, or any client with OAuth and MCP Apps support)
connects to the user's commonplot library. It shows the reads it recommends as
cards, and the user presses **Save** to keep one; saves land in the user's
library and **public profile**, the same as saving a link in commonplot. The
model never saves on its own. It can also list the user's saves and read them
to answer from them.

## Package

This folder is one plugin package for both hosts:

| File | Read by |
| --- | --- |
| `plugin.json`, `mcp.json` | ChatGPT (Agent Plugins format; `extensions.com.openai` holds the listing and starter prompts) |
| `.claude-plugin/plugin.json`, `.mcp.json` | Claude |
| `skills/recommend-reads`, `skills/my-saves` | Both: when to show cards, and how to answer from saves |
| `assets/icon.png` | ChatGPT composer icon and logo |

Zip the folder's contents for upload: ChatGPT at platform.openai.com/plugins,
Claude at **Customize → Plugins → Add → Upload plugin**. Raise `version` in
both manifests on every release. Run `claude plugin validate ./newsence` from
`plugins/` before uploading. Tool and card changes need no new package: the
host rescans the MCP server.

## Connect

Add a remote MCP server with the URL `https://www.newsence.app/api/mcp`
and OAuth authentication. ChatGPT and Claude identify themselves with a Client
ID Metadata Document on their own domain; there is no dynamic client
registration, so other hosts cannot connect. Sign in to commonplot and allow the connection; disconnect in
Settings → Account → Connected apps.

- **ChatGPT:** enable **Settings → Security and login → Developer mode**, then
  add the URL as an app.
- **Claude:** **Settings → Connectors → Add custom connector**.

After changing tools or the card, refresh the connection in the host and start
a new conversation; old messages keep the old card.

## Use

The model decides when to show cards from the skills, the `recommend_reads`
description and the server instructions (ChatGPT documents that it reads their
first 512 characters).
Hosts call apps sparingly, so a general question may still get a plain answer.
For a dependable result, users can:

- mention the app: `@commonplot recommend reading on MCP Apps`, or
  `@commonplot save https://…`;
- pick commonplot from the composer's tools before asking;
- add a standing rule to ChatGPT custom instructions or a Claude project:
  "When you recommend articles or videos, show them with commonplot."

Library questions such as "find the RAG evaluation paper I saved" or "what did
I save this week?" use `list` (target `library`) and then `fetch`. Notebook and
document questions use `list` (target `notebooks`) and `fetch` on a notebook or document id,
which first ask the user for the `newsence:documents` scope.

## How it works

| Endpoint | Purpose |
| --- | --- |
| `POST /api/mcp` | `recommend_reads`, `search`, `fetch`, `list` (model); `save_urls`, `get_save_status` and `open_reader` (card only); `open_newsence` (ChatGPT sidebar) |
| `/.well-known/oauth-protected-resource/api/mcp` | Resource discovery |
| `/.well-known/oauth-authorization-server/api/auth` | Authorization server discovery |
| `/api/auth/oauth2/*` | Authorization (PKCE S256), token, refresh |
| `/auth/consent` | Consent page |
| `/api/embed` | Open embedded website mode; creates no login session |

- `recommend_reads` takes 1–10 URLs with the model's title and one-line reason,
  and returns them with any earlier saves so those cards show as saved.
- `search` and `fetch` follow OpenAI's search/fetch contract: `search`
  searches the curated public corpus, and `fetch` takes one id
  (`resource:`, `document:` or `notebook:<uuid>`) and returns
  `{ id, title, text, url, metadata }`. `list` pages through the user's library
  or notebooks. Think calls the same
  tools through Domain RPC.
  Tool schemas and limits are in `web-tanstack/src/server/mcp/`.
- `save_urls` takes 1–10 HTTP(S) URLs and saves them for the token's user; it
  never accepts a user id. `ready` is saved and readable; `accepted` is received
  and prepared in the background by Core.
- The card (`ui://newsence/reading-list-v7.html`) is a standard MCP Apps view:
  React, `@modelcontextprotocol/ext-apps` and `@openai/apps-sdk-ui`, in
  `web-tanstack/src/server/plugin/widget/`. The `newsence-widget` plugin in
  `vite.config.ts` bundles it into the resource HTML. Its layout follows the
  chat source cards. It polls `get_save_status` a few times while saves are
  pending. If those checks run out, **Check again** fetches the latest status
  without submitting another save. Change its URI when the UI contract changes.
- **Read** on a saved card opens a full-screen reader in hosts that allow it
  (others open the commonplot page). `open_reader` returns the same resource
  projection as `/p/{id}`, and the view renders it with the app's
  `ResourceBody`; the widget build swaps the app's video player for a native
  one. The reader tells the model which item is open, so "summarize this"
  works. Images and math fonts from other origins stay blocked by the card's
  CSP and are hidden.
- Below the cards, **Summarize**, **Compare** and **Find related** send a
  prepared message listing the cards, in hosts that accept view messages.
- `open_newsence` is a ChatGPT global entrypoint (`openai/ui.entrypoints`):
  the sidebar and the plugin's **Open plugin** button open
  `ui://newsence/app-v2.html` full screen. That view frames
  `https://www.newsence.app` (`csp.frameDomains`). The tool returns only the
  public `/api/embed` entry URL, which sets a UI-mode cookie and redirects to
  the app. It never exchanges OAuth access for a website login. The user signs
  in independently with an email code inside the frame; Google sign-in is
  available on the standalone website. Embedded auth uses the separate
  `newsence-embedded` cookie prefix with `SameSite=None; Secure; HttpOnly;
  Partitioned` on both session and session-cache cookies, including deletion.
  The account menu shows the signed-in identity and provides sign-out.
  Disconnecting the plugin revokes MCP access; this independently established
  website login is ended with the website's **Sign out** action.
  A `newsence_embed` cookie switches the app to embedded mode: no AI rail or
  chat, onboarding or upgrade links. The reader posts the open resource to the view, which passes it to
  the model with `updateModelContext`; host deep links
  (`openai/deepLink`) navigate the frame. HTML responses allow framing only
  by the app and ChatGPT (`frame-ancestors`). Submission must justify the
  iframe: it embeds commonplot's own app for the signed-in user.
- Every call requires OAuth, including `recommend_reads`: hosts such as Claude
  decide whether to connect with OAuth from the first 401, so anonymous access
  would leave Save unusable there.
- `openai/*` metadata keys are ChatGPT extensions; other hosts ignore them.
- Access tokens are hour-long JWTs for the `newsence:save` and `newsence:read`
  scopes (plus `newsence:documents` once the user allows notebooks and
  documents) and the MCP URL audience; `offline_access` gives the host a refresh token. Every call also
  checks that the user's consent still exists, so disconnecting is immediate.
- Requests are limited per user and log only `NEWSENCE_PLUGIN_TIMING` durations,
  never URLs, user ids or tokens.

## Manual verification

Deploy the updated Web to the HTTPS environment configured in the plugin,
refresh the host connection, and start a new conversation before checking:

1. Connect with account A, ask for reading recommendations, and confirm nothing
   is saved before pressing **Save**. Save one card and find it in A's library.
2. Ask what you saved and summarize the saved item; compare with its stored text.
3. Keep the standalone website signed in. With the embedded website signed out,
   **Open plugin** must still require its own email-code sign-in. Sign in, open a
   saved item, and confirm the account menu identifies the intended account.
4. Sign out inside the frame and reopen it: private pages must require sign-in,
   while the standalone website stays signed in.
5. Sign in inside the frame again, then disconnect the plugin in commonplot's
   **Connected apps**. A fresh library tool call must require authorization;
   the independently signed-in website remains usable until signed out.
6. Reconnect the plugin with account B. Fresh library calls must show B's saves,
   without A's private data. The embedded website retains its own login.
7. If processing outlasts automatic polling, press **Check again**. It must
   update the status without saving again; **Read** must open the ready item.
