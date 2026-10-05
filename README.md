# LiveDeck

**Inline, PowerPoint-style editing for HTML slide decks — inside VS Code / Cursor.**

Asking an LLM to "fix the wording on slide 4" sometimes rewrites half the file. LiveDeck closes that loop: use Claude for the big structural changes, then open the deck in LiveDeck and make the small ones by hand — click into any text, type, format, done. Every edit is written back to the HTML file as a **minimal edit scoped to the single element you touched**. The rest of the file is byte-for-byte untouched, so diffs stay tiny and the deck's structure and theme survive.

## Features

- **True WYSIWYG** — the deck renders in its own iframe with its real CSS, images, SVGs, fonts, and scripts (charts drawn at load time work). What you see is what the browser shows.
- **Click-to-edit** — hover highlights editable text blocks (headings, paragraphs, bullets, table cells); click to place the caret and type. Escape or click elsewhere to finish.
- **Formatting** — bold / italic / underline / strikethrough (⌘B/⌘I/⌘U), inline `code`, links (⌘K), clear formatting, left/center/right alignment.
- **Bullets like PowerPoint** — Enter adds a bullet, Enter on an empty bullet exits the list, Tab/Shift+Tab indent/outdent, Alt+↑/↓ reorder, and the toolbar converts paragraphs ⇄ bulleted/numbered lists.
- **Delete whole elements** — Escape while editing selects the element (PowerPoint-style), or ⌥+click selects anything directly, including images and SVG figures; Backspace/Delete removes it from the file (whole line, no blank residue), ⌘Z brings it back.
- **Right-click menu** — right-click any element for *AI this element…*, Duplicate, Delete, Move up/down, Reset position/size, Select parent, Insert image, and Reveal in source.
- **Move things** — drag a selected element (text box, image, rule, figure) to reposition it; Shift locks the axis, arrow keys nudge 1px (Shift: 10px). Written as a CSS `translate` on that one element, so the surrounding layout doesn't shift. ⌘-drag instead *reorders* it among its siblings (cards, columns, bullets, slides), with a drop indicator.
- **Select several elements** — Shift-click to add/remove elements, or drag across empty slide space to draw a selection band (Shift+drag adds to the selection). Move, nudge, duplicate (⌘D) or delete (⌫) them together; right-click a member for the group menu.
- **Resize text boxes and images** — handles appear on the selected element and on the text box you're editing; drag an edge to make a box wider or narrower than its column (written as `width`, plus `max-width: none` when widening). Images keep their aspect ratio.
- **Duplicate** — ⌘D or the menu copies the element's *source text* (never re-serialized DOM), so script-rendered content like charts doesn't leak into the file.
- **Images** — paste (⌘V), drop a file (hold Shift when dragging from the VS Code explorer), or *Insert image…*. The file is saved next to the deck (`images/` by default) and referenced by a relative path; click an image to select it, then drag or resize it.
- **AI this element** — right-click → *AI this element…*, type an instruction ("tighten this", "add a citation for this claim", "split into two bullets"). Claude rewrites just that element and the result is written back through the same scoped edit (⌘Z undoes it). It can search the web, so citations point to real sources. Uses your Anthropic API key (asked for once, kept in VS Code secret storage; `ANTHROPIC_API_KEY` also works).
- **Fits your screen on open** — decks open auto-fitted to the panel (never above 100%), re-fit when you move between monitors, and self-scaling decks get a resize nudge so their own fit logic computes against real dimensions. Manual zoom takes over the moment you touch it.
- **Theme-matching by construction** — edits are made inside the deck's own DOM, so new text inherits the deck's fonts, colors, and spacing. Formatting writes semantic tags (`<strong>`, `<em>`), and paste is plain-text by default (⌘⇧V pastes rich) so outside styling can't pollute the theme.
- **Surgical writes** — each edit replaces exactly one element's inner/outer HTML in the source file, with the file's original whitespace and indentation preserved everywhere else.
- **Live two-way sync** — the file is a normal `TextDocument`: undo/redo (⌘Z) and save (⌘S) work, the dirty dot tracks unsaved changes, and if Claude (or you, in a split source view) edits the file, the deck updates in place. Localized changes — including undo/redo — are patched into the live DOM without reloading the deck, so deck scripts and their state (like the current slide) survive.
- **Coexists with deck scripts** — decks that ship their own keyboard navigation (space/arrows → next slide) keep working when you're browsing, but keystrokes are shielded from them while you're editing text.
- **Slide navigation** — slides are auto-detected (`section.slide`, `.slide`, reveal.js, … configurable), with prev/next buttons, a counter, and PgUp/PgDn.
- **Zoom** — 30–300% plus fit-width.
- **Toolbar buttons** for Save, opening the HTML source side-by-side, and opening the deck in your external browser.

## Install

Build the extension package, then install it into Cursor or VS Code:

```bash
cd LiveDeck
npm install
npm run package        # produces livedeck-<version>.vsix (vsce needs Node 20+, see note)
cursor --install-extension livedeck-*.vsix   # or: code --install-extension livedeck-*.vsix
```

Then reload the window (⌘⇧P → "Reload Window"). Alternatively install through the UI: **Extensions panel → ⋯ → Install from VSIX…**

> **Note:** building and testing work on Node 18+, but `vsce` (the packaging step) requires Node 20+. On a Homebrew Mac with keg-only node@20: `export PATH=/opt/homebrew/opt/node@20/bin:$PATH` before `npm run package`.

For development, open this folder and press F5 to launch an Extension Development Host.

## Usage

1. Right-click an `.html` file → **Open with LiveDeck** (also in the editor title bar and the command palette). Or use **Open With… → LiveDeck**.
2. Click into any text and edit. The file updates as you type (debounced); save with ⌘S as usual.
3. For big changes, keep using Claude on the same file — LiveDeck picks up external edits automatically.

Try it on `examples/demo.html`.

### Shortcuts

| Keys | Action |
| --- | --- |
| ⌘B / ⌘I / ⌘U | Bold / italic / underline |
| ⌘K | Add or edit a link |
| Enter | New bullet (in lists) / split paragraph |
| Enter on empty bullet | Exit the list into a paragraph |
| Shift+Enter | Line break |
| Tab / Shift+Tab | Indent / outdent bullet |
| Alt+↑ / Alt+↓ | Move bullet up / down |
| Escape (while editing) | Select the element (press again to dismiss) |
| ⌥+click | Select any element (works on images/SVG too) |
| Click an image / svg / rule | Select it |
| Right-click | Element menu (AI, duplicate, delete, move, …) |
| Shift+click | Add / remove an element from the selection |
| Drag on empty slide space | Selection band (Shift: add to selection) |
| Drag a selected element | Move it — and the rest of the selection (Shift: lock axis) |
| ⌘+drag a selected element | Reorder it among its siblings |
| Drag a handle | Resize (text box: width / min-height; image: keeps aspect) |
| Arrow keys / Shift+arrows (element selected) | Nudge 1px / 10px |
| ⌥↑ / ⌥↓ (element selected) | Move earlier / later among siblings |
| ⌘D (element selected) | Duplicate |
| ⌘V with an image on the clipboard | Paste it into the deck |
| Backspace / Delete (element selected) | Delete the element |
| ⌘Z / ⇧⌘Z | Undo / redo (applies to the file) |
| ⌘S | Save |
| ⌘C / ⌘X / ⌘V | Copy / cut / paste text (between text boxes, and to/from other apps) |
| ⌘⇧V | Paste with original formatting |
| PgUp / PgDn | Previous / next slide (when not editing) |
| ⌘+click a link | Open it in your browser |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `livedeck.slideSelectors` | common deck selectors | CSS selectors tried in order to detect slides |
| `livedeck.editDebounceMs` | `400` | Idle time before an edit is written to the file |
| `livedeck.pastePlainText` | `true` | Paste as plain text to protect the theme |
| `livedeck.normalizeMarkup` | `true` | `<b>`→`<strong>`, `<i>`→`<em>`, strip empty spans |
| `livedeck.imageFolder` | `images` | Where pasted/dropped/inserted images are saved, relative to the deck |

Command: **LiveDeck: Set Anthropic API Key** — set or clear the key used by *AI this element*.

## How it stays safe

LiveDeck parses the file with `parse5` — the same HTML parsing algorithm browsers use — so the rendered DOM and the source tree correspond element-for-element. Each editable element is tagged with an opaque id in the *rendered* copy only (the file never contains them) and mapped to exact byte offsets in the source. An edit replaces just that range; afterwards the file is re-parsed and the mapping is verified against the previous one (tag + depth of everything outside the edited region must be identical). Any mismatch — a racing edit, malformed markup, anything surprising — falls back to a full re-render from the file rather than risking a wrong write. See `docs/ARCHITECTURE.md` for the details.

## Known limitations

- Text inside `<svg>`, `<canvas>`, and chart libraries isn't editable (it renders fine).
- Backspace at the start of a paragraph doesn't merge it into the previous one — use the source view for structural moves like that, or ask Claude.
- Decks whose scripts *restructure* the DOM at load (e.g. frameworks that re-wrap slides) render fine, but blocks the framework created or moved may not be editable; static decks — the common case for LLM-generated decks — are fully editable.
- Undo/redo applies to the file and patches the deck in place; the caret position is not restored.
- External changes that cross element boundaries trigger a full deck reload; slide-mode decks (one slide shown at a time via their own script) reset to slide 1 on such reloads, since the current slide lives in the deck's own JS state.
- One LiveDeck view per document at a time.
