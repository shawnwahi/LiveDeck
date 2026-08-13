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
│ Extension host (Node)                                      │
│  extension.ts            commands, registration            │
│  deckEditorProvider.ts   CustomTextEditorProvider          │
│    DeckSession           1 per open editor:                │
│                          document ⇄ webview protocol       │
│  sourceMap.ts            parse5 mapping (the core)         │
└──────────────▲─────────────────────────────────────────────┘
               │ postMessage protocol
┌──────────────▼─────────────────────────────────────────────┐
│ Webview (media/shell.js + shell.css)                       │
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

Never editable: anything inside `svg`, `canvas`, `script`, `style`, `iframe`,
form controls — and any element without a `data-ld-id` stamp (i.e. created at
runtime by deck scripts, not present in the source).

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
