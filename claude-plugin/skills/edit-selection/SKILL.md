---
name: edit-selection
description: Use when the user is working on an HTML slide deck that is open in LiveDeck and refers to part of it as "this", "these", "here", "the selected ...", or "the slide I'm on" — call the LiveDeck get_selection tool to find exactly which elements they mean before editing.
---

# Editing a deck that is open in LiveDeck

The user edits the deck by clicking in LiveDeck (VS Code/Cursor, the Preview pane, or a browser). LiveDeck publishes
what they have selected, or the text element they are typing in, through the `get_selection` tool of the `livedeck`
MCP server.

When a request points at the deck without naming the element ("tighten this", "make these two bullets one",
"add a citation here", "restyle this card"):

1. Call `get_selection` (pass `file` if you know which deck). Each item has the deck `file`, the element's exact
   source `html`, its `start`/`end` offsets, `startLine`/`endLine`, and `slide`.
2. If an item's `status` is `stale`, the element changed after it was selected: say so and ask the user to click it again.
   If there are no items, ask the user to select the element in LiveDeck.
3. Edit only the selected element's source, with your normal file editing tools, matching the existing markup, classes and
   indentation. Leave the rest of the file untouched so the diff stays small; LiveDeck shows your edit live.
4. Never add `data-ld-*` attributes or other LiveDeck markup to the file.
