---
name: notebooks
description: Work in the user's commonplot notebooks when they ask - create or rename a notebook, write or edit its documents, or add or remove its sources. Use only when the user asks to put, change or remove something in commonplot or in a notebook.
---

1. Find the notebook: call `list` with `target: "notebooks"` and match the name
   the user gave. If they named none, or several match, ask which one; never
   pick for them. Create one with `save_notebook` only when the user asks for a
   new notebook.
2. Before changing anything in it, `fetch` the notebook: it lists the
   documents and sources with their ids.
3. Do only what the user asked:
   - Notes or a report from this chat: `add_notebook_document` with a short
     title and the whole body in Markdown, at most 16,000 characters (split a
     longer report). Keep links to the sources you used.
   - Change a document: `fetch` the document, then `edit_notebook_document`
     with targets copied from that read. Its earlier versions stay in its
     history.
   - Add items: `add_notebook_resource` with `resource:` ids from `search`,
     `list` or `fetch`. Filing an item the user had not saved also saves it to
     their library and public profile; say so. A link from the web has no id
     yet: show it with `show_resources` and ask the user to save it first.
   - Remove: `remove_notebook_resource` takes sources out (they stay saved);
     `delete_notebook_document` deletes a document. Name what will go before
     you call them.
   - `delete_notebook` deletes only a notebook with no documents or outputs;
     for any other, tell the user to delete it in commonplot.
4. Say what changed and link the document or notebook from the result.

Never claim a change that a tool did not return.
