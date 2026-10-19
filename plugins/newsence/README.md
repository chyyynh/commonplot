# commonplot for Claude and ChatGPT

[commonplot](https://www.commonplot.co) keeps the articles, papers, posts and
videos you want to read, and the notebooks and documents you write from them.
This plugin connects your commonplot library to Claude or ChatGPT.

## What it does

- **Save what the assistant recommends.** Ask for reading on a topic and the
  assistant shows its picks as cards. Press **Save** on a card to keep it in
  your commonplot library and public profile. Nothing is saved until you press
  Save.
- **Ask about what you saved.** "What did I save this week?", "Find the RAG
  evaluation paper I saved and summarize it." The assistant searches and reads
  your saves and answers from their stored text.
- **Read your notebooks and documents**, once you allow it.
- **Write into a notebook when you ask.** "Put a summary of this chat in my
  research notebook" creates a new document there, and saved items can be
  added to a notebook as sources. The plugin only adds; it never edits or
  deletes anything in commonplot.

## What's inside

| Part | Purpose |
| --- | --- |
| `.mcp.json`, `mcp.json` | The commonplot MCP server at `https://www.commonplot.co/api/mcp` |
| `skills/recommend-reads` | When to show recommendations as save cards |
| `skills/my-saves` | How to find and answer from your saves, notebooks and documents |
| `skills/write-to-notebook` | When and how to write into a notebook |
| `.claude-plugin/plugin.json` | Claude manifest |
| `plugin.json` | ChatGPT manifest and listing |

The plugin runs no local code. It talks only to the commonplot MCP server
above, over HTTPS, signed in with OAuth.

## Connect

You need a commonplot account. When you first use the plugin, the assistant
asks you to sign in to commonplot and allow the connection. You choose
whether to also allow reading notebooks and documents, and adding to
notebooks; the assistant asks the first time it needs either.

Disconnect any time in commonplot under **Settings → Account → Connected
apps**, which ends access immediately.

## Data and privacy

What the assistant reads from commonplot, such as a save's text or a notebook,
is sent to that assistant's provider (Anthropic or OpenAI) to answer you, and
is governed by its privacy policy. commonplot does not log the URLs, user ids
or tokens of plugin requests. See the
[commonplot privacy policy](https://www.commonplot.co/privacy) and
[terms](https://www.commonplot.co/terms).

## Help

Guide: [docs.commonplot.co/user/chatgpt-and-claude](https://docs.commonplot.co/user/chatgpt-and-claude/)
· Contact: [hello@commonplot.co](mailto:hello@commonplot.co)
