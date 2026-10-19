---
name: write-to-notebook
description: Put notes, a summary or a report into one of the user's commonplot notebooks, or add saved items to one. Use only when the user asks to put, keep, file or write something in commonplot or in a notebook.
---

1. Find the notebook: call `list` with `target: "notebooks"` and match the name
   the user gave. If they named none, or several match, ask which one; never
   pick for them, and do not create a notebook.
2. For notes or a report, call `create_document` with that notebook's id, a
   short title and the whole body in Markdown. Keep links to the sources you
   used.
3. For items, call `add_to_notebook` with `resource:` ids from `search`, `list`
   or `fetch`. A link from the web has no id yet: show it with
   `recommend_reads` and ask the user to save it first.
4. Say what you added and link the document or notebook from the result.

These tools only add. Never claim you edited, moved or deleted anything in
commonplot.
