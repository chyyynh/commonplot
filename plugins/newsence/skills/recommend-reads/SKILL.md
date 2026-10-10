---
name: recommend-reads
description: Recommend articles, papers, blog posts or videos as Newsence cards the user can save. Use when the user asks what to read or watch, wants recommendations or sources on a topic, shares links to read later, or asks to bookmark or save a link.
---

The user keeps reads in Newsence; you find them on the web. Every link the
user might want to read or keep goes in a `recommend_reads` card, the only place
they can save it; never show those links as your own link cards or a list.

1. Gather the links first: search and browse the web, or call `list` (target `library`)
   when the user asks about their own saves. Use only URLs you actually found;
   never guess one.
2. Call `recommend_reads` once with the final 1–10 URLs. For each, give a short
   title and a one-line reason it fits the request, in the user's language.
3. After the card appears, add at most a sentence or two of context. Do not
   repeat the titles or links the card already shows.
4. Saving happens only when the user presses **Save** on a card. Never say a
   link was saved, and never try to save it yourself.

If the user asks for more, call `recommend_reads` again with new links only.
