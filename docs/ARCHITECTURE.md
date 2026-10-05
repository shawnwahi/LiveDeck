# LiveDeck architecture

## The problem being solved

WYSIWYG editors usually own the document: they parse HTML into their model and
serialize the whole thing back, destroying formatting, comments, and attribute
order — terrible for files that a human and an LLM keep editing as text.
LiveDeck instead treats **the HTML file as the single source of truth** and
performs only *scoped* writes: one element's inner/outer HTML at a time.

## Components

```
┌────────────────────────────────────────────────────────────┐
│ Host (Node)                                                │
│  deckSession.ts          DeckSession, 1 per open editor:   │
│                          document ⇄ shell protocol         │
│                          (never imports vscode)            │
│    HostAdapter ── vscodeAdapter.ts   TextDocument/webview  │
│                └─ server/serve.ts    file on disk/browser  │
│  sourceMap.ts            parse5 mapping (the core)         │
│  extension.ts / deckEditorProvider.ts   VS Code entry      │
│  cli.ts                  `livedeck` serve / mcp entry      │
└──────────────▲─────────────────────────────────────────────┘
               │ postMessage protocol (SSE + POST in a browser)
┌──────────────▼─────────────────────────────────────────────┐
│ Shell (media/shell.js + shell.css; shellHtml.ts)           │
│  toolbar, zoom, slide nav, link popover, toasts            │
│  <iframe> ← deck HTML written via document.write           │
│    same-origin: shell manipulates contentDocument directly │
│    click-to-edit, contenteditable, op pipeline             │
└────────────────────────────────────────────────────────────┘
```
The deck iframe is same-origin with the webview (loaded via `srcdoc`), so
`shell.js` attaches listeners and mutates the deck DOM directly. It must stay
`srcdoc`: `document.open()`/`write()` nulls the document's service-worker
controller, which is what serves `vscode-resource` URIs — with `write()`,
local images and stylesheets silently fail to load. There is no injected
runtime inside the deck itself; the served markup differs from the file only
by `data-ld-id` attributes, a `<base>` tag, and inlined resources (below).

**Local resources are inlined as data: URIs** (`src/resources.ts`), because
even `srcdoc` documents don't reliably reach the webview's vscode-resource
service worker in practice — data: URIs render unconditionally. The extension
host resolves relative `src`/`srcset`/`poster`/`href`, `<style>`/`style=`
`url(...)` refs, stylesheet links (including their nested `url()`s), and
script `src` against the deck's directory (48MB/file cap, mtime-cached).
Every rewritten attribute on a *body* element gets a `data-ld-orig-*` twin;
`serializeClean` restores the originals before write-back, so data URIs never
reach the user's file. Head elements are never serialized back, so they are
rewritten without stamps.

## Hosts

`DeckSession` implements the whole edit protocol against a `HostAdapter`:
read the text, replace one range (one undo step), change events in old-text
offsets, post to the shell, plus the editor services (undo/redo/save,
clipboard, image picker, reveal, API key). New features that need something
from the editor go through the adapter, implemented once per host; features
in `shell.js`, `sourceMap.ts` or `structOps.ts` work in both unchanged.

- **VS Code** (`vscodeAdapter.ts`): a `TextDocument` edited with
  `WorkspaceEdit`s; undo/redo/save are the editor's commands.
- **Standalone** (`server/`, `livedeck serve`): `FileDocument` holds the text,
  writes every edit to disk immediately (agents read the file, so a dirty
  buffer would hide edits from them), keeps its own undo/redo (refusing when
  someone else changed the range since), and watches the deck's directory.
  An outside write becomes a single minimal change (common prefix/suffix), so
  the usual `tryPatch` path patches it in place. `serve.ts` serves the shell
  with `media/bridge.js`, which defines `acquireVsCodeApi()`: host → page over
  Server-Sent Events, page → host as POSTs chained so they arrive in order
  (invariant 5). Clipboard, the image file picker and new tabs are handled in
  the browser. Several tabs may share one `FileDocument`; each has its own
  session and sees the others' edits as external changes. The server binds to
  loopback only, rejects other `Host` headers (DNS rebinding), and requires a
  custom header on POSTs, which cross-origin pages can't send without a
  preflight the server never grants.

**Selection for agents.** The shell reports the selected elements (or the
text root being edited) as `{type:'selection'}`; the session resolves ids to
source ranges and writes them to `~/.livedeck/selection/<hash>.json`
(`selection.ts`). `livedeck mcp` (`mcp.ts`, dependency-free stdio JSON-RPC)
serves `get_selection`, re-anchoring each item against the current file: at
its offsets, else at the single place its exact source still occurs, else
`stale`. Agents edit with their own tools; LiveDeck never writes on their behalf.

## Source mapping (`sourceMap.ts`)

- `buildDeck(source)` parses with parse5 (`sourceCodeLocationInfo: true`) and
  walks all `<body>` descendant elements in DFS pre-order. parse5 implements
  the same spec algorithm as the browser, so this order matches
  `body.querySelectorAll('*')` in the iframe **including parser-implied
  elements** like `<tbody>` (which get map entries but no source stamp).
- Every element gets an id `ld-N`, spliced into the *instrumented* copy as
  `data-ld-id`. The user's file never contains these ids. Ids are monotonic
  across rebuilds within a session, so a stale id can never address the wrong
  element.
- Each entry records `outerStart/outerEnd`, `innerStart/innerEnd` (−1 when
  there is no explicit end tag), `depth`, and `subtree` size.

### Applying an edit

1. Webview sends `{mode: 'inner'|'outer', id, html|parts, mapVersion}`.
2. Session validates `mapVersion` (stale → full re-render, never a blind write).
3. The corresponding source range is replaced via `WorkspaceEdit`:
   - `inner`: the element's inner range. If the element had no explicit end
     tag (`<li>` with implied close), the whole outer range is rewritten with
     an explicit end tag added — self-healing.
   - `outer`: the element's outer range is replaced by `parts` joined with the
     element's original line indentation (used for paragraph splits, list
     toggles, alignment — anything that changes the root element itself).
4. `rebuildAfterEdit` re-parses the new text and re-attaches ids:
   *prefix* and *suffix* elements (outside the edited region) must match the
   old map by tag **and** depth and keep their ids; the region gets fresh ids,
   returned to the webview (`ack`) which re-stamps them onto the region's DOM
   subtree in DFS order. Counts disagreeing (deck script mutated the DOM
   mid-flight) → stamp the root only and re-flush to converge, or fall back to
   a full re-render. Any prefix/suffix mismatch → full re-render.

The webview serializes edits from the live DOM with `serializeClean`: strips
`data-ld-id`/`contenteditable`/editing classes, normalizes `<b>→<strong>`,
`<i>→<em>`, unwraps attribute-less spans and `<font>`. Because the browser DOM
preserves the source's whitespace text nodes, untouched parts of an element
round-trip byte-identically → minimal diffs.

### Op pipeline (webview)

Edits run strictly one at a time (`opQueue`/`pending`): payloads are
serialized at *send* time, so keystrokes coalesce; a root whose flush is
pending is marked dirty and re-flushed after the ack. New elements created
locally (paragraph split, list exit) have no id until the ack stamps them —
flushes for them are held until then.

## Editing model

Editable **roots** are the smallest sensible text containers:

| Click target | Root | Enter behavior |
| --- | --- | --- |
| inside `ul`/`ol`/`li` | outermost list | browser adds `<li>` (inner edit); empty `<li>` exits list (outer op) |
| `p`, `div`/`section` leaf, `blockquote` | the element | split into two elements (outer op) |
| `h1–h6`, `td`, `th`, `caption`, … | the element | `<br>` line break (inner edit) |

Decorations: underline / strikethrough from CSS (links!) can't be removed
by `execCommand` — a text-decoration can't be cancelled from a descendant.
`toggleDecoration` finds the element that draws it and toggles
`text-decoration-line` on that element (inner edit if it's inside the root,
a `style` struct op if it's the root or wraps it).

Never editable: anything inside `svg`, `canvas`, `script`, `style`, `iframe`,
form controls — and any element without a `data-ld-id` stamp (i.e. created at
runtime by deck scripts, not present in the source).

**Element selection & deletion**: Escape from editing selects the edited
element; ⌥+click selects the text root or, failing that, the nearest
source-mapped element (this is how images/svg become deletable). Backspace on
a selection removes the element locally and sends an outer op with empty
`parts`; the provider maps that to `deletionRange` (consuming the element's
own line so no blank line is left) and the region rebuild yields zero fresh
ids. Undo restores it through the in-place patch path.

### Structural ops (`structOps.ts`)

Duplicate, reorder (menu / ⌥↑↓ / ⌘-drag), reposition and resize (inline
`translate` / `width` …), and image insertion don't serialize DOM at all.
The webview sends `{type:'struct', op, …}`; the host plans the new text from
**slices of the source** (plus generated `<img>` markup for inserts) as one
contiguous replacement:

| op | replaced range | DFS region |
| --- | --- | --- |
| `duplicate` | empty, at the element's end (copy of its source on the next line) | empty, after its subtree |
| `move` | from the first to the last sibling of the run; separators stay put | the run's subtrees |
| `style` | the element's start tag only (`style` attr rewritten in place) | the element alone — descendants keep ids |
| `insert` | empty, after the anchor or the container's last child | empty |

Images placed at a point (click-then-paste, drop, *Paste/Insert image
here*) are appended to the slide — or the nearest positioned container —
with `position: absolute; left/top` computed in the container's padding-box
CSS px; a static container first gets a `position: relative` style op.

`applyStructPlan` rebuilds and checks every region element against the
plan's `origin` (tag + depth), then returns `[oldId, newId]` pairs. The
webview, which already rearranged its DOM, re-stamps by id lookup — not by
DFS re-count — so unstamped, script-generated descendants (a chart drawn
into a moved card) can't cause a mismatch. A duplicate's clone has its
stamps removed until the ack arrives, so it can never address the
original's range. Any failure → full re-render (`failStruct`).

Moves and resizes are written as inline `translate` / `width` / `max-width`
/ `min-height` on the one element: the element keeps its place in the
layout. Pixel deltas are converted to the element's coordinate space
(LiveDeck zoom × the deck's own scale of the parent). If the element has a
`data-ld-orig-style` twin (inlined `url()`s), the ack updates it so later
outer edits don't restore a stale style.

**Multi-selection**: `state.selected` is the primary, `state.extra` the
rest; the set is always disjoint subtrees (adding a nested element replaces
its ancestor/descendant). Group actions are just the single-element ops
queued once per element — each is its own scoped write (and undo step).
The selection band picks the outermost stamped elements fully inside it,
never the container the drag started on, and descends through a lone
wrapper to its items.

Resize handles, the selection band and the reorder drop indicator live in the shell's
`#overlay`, never in the deck DOM (an extra node there would shift DFS order).

### AI this element (`aiEdit.ts`)

The host sends the element's exact source, its slide's source (context),
and the instruction to `claude-opus-5-5` (web search enabled so citations
are real; server-side refusal fallback on). The reply's fenced HTML is
validated, the element's source is re-checked to be unchanged since the
request, and the replacement is applied as a normal `WorkspaceEdit` — the
inner range when the start tag is unchanged — so the existing
external-change path (`tryPatch`) patches that element in place. One edit,
one ⌘Z.

**Zoom**: `autoZoom` (default on, off once the user touches zoom controls,
persisted) shrinks to fit the panel width, capped at 100%, re-running on
panel resize. Self-fitting decks are handled separately: after load (and at
the 150ms settle), a synthetic `resize` event is dispatched into the deck so
its own fit logic recomputes against final dimensions — their post-transform
size doesn't register as overflow, so autoFit correctly leaves them at 100%.

Alignment is applied by setting `style="text-align:…"` on the root ourselves
(not `execCommand`) because it mutates the root's own attributes, which an
inner-edit would not capture — hence an outer op.

## Sync & failure ladder

- **Self edits**: `applyingSelfEdit` suppresses the document-change listener;
  the map is rebuilt incrementally (ids preserved outside the region).
- **External edits** (Claude, git, undo/redo, split source view): first try an
  **in-place patch** — if every changed span is confined to one element's
  inner range (`deepestContaining`), that element's innerHTML is swapped in
  the live DOM (`patch` message, fresh ids re-stamped, resources inlined via
  the body-context wrapper trick). No iframe reload means deck scripts and
  their state (e.g. the current slide of a slide-mode deck) survive — this is
  what keeps ⌘Z from resetting slide-mode decks. Only when the change crosses
  element boundaries does it fall back to a debounced full re-render, which
  preserves window scroll plus scrolled inner containers. In-flight edits
  from before the change are rejected by `mapVersion`.
- **Deck scripts vs typing**: decks often bind space/arrows to their own
  slide navigation with `preventDefault`. While an element is being edited,
  the capture-phase key handlers call `stopPropagation()` so deck scripts
  never see keystrokes (default actions like typing are unaffected); when not
  editing, deck navigation works normally.
- **Anything unexpected** (region mismatch, detached elements, failed
  `applyEdit`): full re-render from the file. The file is never written from a
  mapping we could not verify.

**Clipboard**: the editor runs Copy/Cut/Paste against the webview's outer
document, never the nested deck document, so ⌘C/⌘X/⌘V are handled in the
deck's keydown: copy via `execCommand('copy')` (rich), falling back to the
host's `vscode.env.clipboard`; paste via a native `execCommand('paste')`,
then the async clipboard API (images, HTML), then the host's text
clipboard. Copy/cut/paste events that do land on the outer document (menu
commands) are redirected into the deck, de-duplicated against a keypress
the deck already handled.

Undo/redo/save are forwarded from the webview (key events inside the iframe
never reach VS Code) and executed as regular VS Code commands against the
document.

## Rendering

- The iframe fills the panel; the deck scrolls natively inside it, so
  `100vh`-sized slides behave exactly as in a browser. Zoom scales the iframe
  (`width: 100/z%` + `transform: scale(z)`).
- CSP is deliberately permissive (https + inline scripts + eval) because decks
  legitimately use CDN libraries, Google Fonts, and inline `<script>`; the
  iframe inherits the webview CSP. No nonce — a nonce would disable
  `'unsafe-inline'` and break deck scripts.
- `retainContextWhenHidden` keeps deck state across tab switches.

## Adding a toolbar command (checklist)

1. Button in `deckEditorProvider.ts` `shellHtml` (`data-cmd="x"`, in a
   `data-needs-edit` group if it needs an active editing root).
2. Case in `runCommand` in `shell.js`. If it only mutates *descendants* of the
   root → `markDirty(root)` (inner edit). If it mutates the root itself or
   replaces it → build the new element(s) with DOM ops and
   `enqueue({kind:'outer', oldId, els})`.
3. Reflect state in `updateToolbar` if it's a toggle.
