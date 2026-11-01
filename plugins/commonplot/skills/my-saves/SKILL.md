---
name: my-saves
description: Answer from what the user saved or wrote in commonplot. Use when the user mentions something they saved, read or bookmarked, asks what they saved recently, asks about a notebook or document of theirs, or wants a summary, comparison or quote from them.
---

1. To find a save by topic, call `search` with `scope: "saves"` and a few
   words from it. For what the user saved over a period, call `list` with
   `target: "library"`; pass `days` for a time window ("this week" is 7). For a notebook or document, call `list` with
   `target: "notebooks"`, then `fetch` the notebook's id to see its documents
   and sources. Each page holds 50 entries; pick the matching ones by title,
   source and kind yourself. Pass `nextCursor` (or a notebook's
   `metadata.continuation`) back only when the item is not on the page and
   later pages could hold it.
2. Call `fetch` with each chosen entry's `id`. Long text comes in chunks:
   repeat with the returned `metadata.continuation` until it is null.
3. Answer from the text you read and name the item it came from. When the
   user asks what else connects to it, use `metadata.connections` and
   `metadata.savedBy` from the first chunk, and fetch a connection's id to
   read it. If
   `metadata.contentAvailable` is false, say the text is not stored; do not
   invent it.
4. To show saves to the user, pass their URLs to `show_resources`; the cards
   mark them as already saved. Do not list them as text.

If nothing matches, say so and offer to look further back instead of guessing.
