---
name: my-saves
description: Answer from what the user saved to Newsence. Use when the user mentions something they saved, read or bookmarked, asks what they saved recently, or wants a summary, comparison or quote from their saves.
---

1. Call `list_saves`. Pass `days` for a time window ("this week" is 7). It
   returns 50 saves per page, newest first; pick the matching items by title,
   source and kind yourself. Pass `nextCursor` back as `cursor` only when the
   item is not on the page and older saves could hold it.
2. Call `read_resource` with each chosen item's `id`. Long text comes in
   chunks: repeat with the returned `continuation` until it is null.
3. Answer from the text you read and name the item it came from. If
   `contentAvailable` is false, say the text is not stored; do not invent it.
4. To show saves to the user, pass their URLs to `show_reading`; the cards
   mark them as already saved. Do not list them as text.

If nothing matches, say so and offer to look further back instead of guessing.
