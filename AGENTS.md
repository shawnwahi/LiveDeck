# LiveDeck — notes for agents

VS Code/Cursor extension (plus a standalone `livedeck` CLI for browsers, the
Claude desktop Preview pane and Codex): inline WYSIWYG editing of HTML slide
decks with surgical write-back to the source file. Read `docs/ARCHITECTURE.md`
before touching the edit protocol. `CLAUDE.md` only imports this file; edit here.

## Commands

- `npm run build` — bundle to `dist/extension.js` (esbuild, parse5 bundled in)
- `npm run typecheck` — tsc, no emit
- `npm test` — unit tests (node:test): `sourceMap`, `structOps`, `resources`,
  `aiEdit`, the standalone server (`fileDocument`, `serve`), `selection`/MCP
- `npm run serve -- examples/demo.html` — build, then run the editor in a browser
  (`dist/livedeck.js` is the `livedeck` CLI: `serve`, `init-claude`, `mcp`)
- `npm run package` — build + `vsce package` → installable `.vsix`
- `media/shell.js` / `media/bridge.js` are plain JS (no build step); check with `node --check`
- `claude plugin validate . && claude plugin validate ./claude-plugin` — check the
  Claude Code plugin (`claude-plugin/`) and its marketplace entry

## Invariants — do not break

1. The user's HTML file must never contain `data-ld-id` or any other
   instrumentation. Ids live only in the rendered copy and the in-memory map.
2. Every write to the document is one contiguous, verified source range:
   an element's inner/outer range (`handleEdit`) or a structural op planned
   from source slices (`handleStruct` / `structOps.ts`). Never serialize
   and write the whole document; structural ops never serialize DOM.
3. The DFS element order in `sourceMap.ts` must match the browser's
   `querySelectorAll('*')` order — that's why parser-implied elements
   (`tbody`) get map entries and `<template>` contents are skipped.
4. When the mapping can't be verified (`rebuildAfterEdit` returns null, stale
   `mapVersion`, region count mismatch), fall back to a full re-render.
   Correctness beats caret preservation.
5. Webview ops run strictly serially (`pending`/`opQueue`); payloads are
   serialized at send time. In a browser, `bridge.js` keeps POSTs in order.
6. `deckSession.ts` never imports `vscode`. Anything a feature needs from the
   editor goes through `HostAdapter` and is implemented in both
   `vscodeAdapter.ts` and `server/serve.ts`.
