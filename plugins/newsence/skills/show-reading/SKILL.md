---
name: show-reading
description: Show reads as Newsence cards the user can save. Use when recommending or finding articles, papers, blog posts or videos, when the user shares links to read later, or asks to bookmark or save a link.
---

The user keeps reads in Newsence. Show links as cards, not as a plain-text list.

1. Gather the links first: search, browse, or call `list_saves` /
   `list_latest_resources`. Use only URLs you actually found; never guess one.
2. Call `show_reading` once with the final 1–10 URLs. For each, give a short
   title and a one-line reason it fits the request, in the user's language.
3. After the card appears, add at most a sentence or two of context. Do not
   repeat the titles or links the card already shows.
4. Saving happens only when the user presses **Save** on a card. Never say a
   link was saved, and never try to save it yourself.

If the user asks for more, call `show_reading` again with new links only.
