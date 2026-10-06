---
description: Open an HTML slide deck in the LiveDeck editor (Preview pane or browser)
argument-hint: <deck.html>
allowed-tools: Bash(livedeck:*), Bash(command -v livedeck)
---

Open the HTML deck `$ARGUMENTS` in LiveDeck so the user can edit it by clicking, while you keep editing the same file.

1. Check the CLI is installed: `command -v livedeck`. If it is missing, stop and tell the user to install it with
   `npm install -g github:shawnwahi/LiveDeck` (then restart this session so the LiveDeck MCP server starts).
2. If no deck path was given, look for `.html` files that look like slide decks in the project and ask which one.
3. Run `livedeck init-claude <deck.html>` from the project root. It adds a "LiveDeck" entry to `.claude/launch.json`.
4. Tell the user, in one or two lines: in the Claude desktop app, start **LiveDeck** from the Preview menu to open the
   editor beside this chat; elsewhere, run `livedeck serve <deck.html> --open`. Edits they make are written to the file
   immediately, and edits you make show up in the editor live.
