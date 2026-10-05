// LiveDeck webview shell: renders the deck in an iframe, provides
// PowerPoint-style click-to-edit, and streams scoped edits back to the
// extension host. The iframe document is same-origin (written via
// document.write), so this script manipulates it directly.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (sel) => document.querySelector(sel);

  const state = {
    mapVersion: -1,
    config: {
      slideSelectors: [],
      editDebounceMs: 400,
      pastePlainText: true,
      normalizeMarkup: true,
    },
    frame: null,
    doc: null,
    editing: null, // { root }
    dirty: new Set(), // roots with unflushed DOM changes
    opQueue: [],
    pending: null, // op awaiting ack
    debounceTimer: null,
    slides: [],
    slideIdx: 0,
    zoom: 1,
    fitMode: false,
    autoZoom: true, // fit-on-open until the user touches zoom controls
    selected: null, // element-selection mode (Esc from editing / ⌥-click)
    savedRange: null,
    pasteRichOnce: false,
    hoverEl: null,
    firstRender: true,
    extra: [], // additional selected elements (shift-click / marquee); state.selected is the primary
    marquee: null, // pending/active rubber-band selection
    nudged: new Set(),
    drag: null, // pending/active move or reorder drag of an element
    resize: null, // active resize-handle drag
    nudgeTimer: null,
    lastPointerId: null,
  };

  // ---------------------------------------------------------------- helpers

  const TEXT_BLOCKS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'FIGCAPTION',
    'PRE', 'TD', 'TH', 'DT', 'DD', 'CAPTION', 'SUMMARY',
  ]);
  const LIST_TAGS = new Set(['UL', 'OL']);
  // classes LiveDeck adds to deck elements; never written to the file
  const EDITOR_CLASSES = ['ld-editing', 'ld-hover', 'ld-selected', 'ld-dragging', 'ld-ai-busy'];
  const FORBIDDEN = 'script,style,svg,canvas,iframe,object,video,audio,select,textarea,input,math';
  const BLOCKISH = new Set([
    'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV',
    'UL', 'OL', 'TABLE', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'PRE', 'FIGURE', 'HR', 'CANVAS', 'SVG', 'IFRAME', 'VIDEO',
    'DL', 'FORM',
  ]);

  function post(msg) { vscode.postMessage(msg); }
  function toast(text, ms = 2200) {
    const t = $('#toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { t.hidden = true; }, ms);
  }

  function outermostList(el) {
    let list = el.closest('ul,ol');
    if (!list) return null;
    for (;;) {
      const up = list.parentElement && list.parentElement.closest('ul,ol');
      if (!up) return list;
      list = up;
    }
  }

  function isTextLeaf(el) {
    if (!el.textContent || !el.textContent.trim()) return false;
    for (const c of el.children) {
      if (BLOCKISH.has(c.tagName)) return false;
    }
    return true;
  }

  /** The editable root for a click target, or null. Roots are the smallest
   *  sensible text container: the outermost list for list content, the block
   *  element itself for paragraphs/headings/cells, a leaf div/section that
   *  only holds inline content. Never anything inside svg/canvas/script. */
  function findRoot(target) {
    const doc = state.doc;
    if (!doc || !(target instanceof doc.defaultView.Element)) return null;
    if (!doc.body.contains(target)) return null;
    if (target.closest(FORBIDDEN)) return null;
    let el = target;
    let inlineCandidate = null; // span/a text holder, used if no block matches
    while (el && el !== doc.body) {
      const tag = el.tagName;
      if (tag === 'LI' || LIST_TAGS.has(tag)) {
        const list = outermostList(el);
        return list && list.getAttribute('data-ld-id') ? list : null;
      }
      if (TEXT_BLOCKS.has(tag)) {
        return el.getAttribute('data-ld-id') ? el : null;
      }
      if ((tag === 'SPAN' || tag === 'A') && !inlineCandidate
          && el.getAttribute('data-ld-id') && isTextLeaf(el)) {
        inlineCandidate = el; // prefer an enclosing block if one exists
      }
      if ((tag === 'DIV' || tag === 'SECTION' || tag === 'FIGURE' || tag === 'LABEL')
          && el.getAttribute('data-ld-id') && isTextLeaf(el)) {
        return el;
      }
      el = el.parentElement;
    }
    return inlineCandidate;
  }

  // ------------------------------------------------------------- serializer

  function serializeClean(el, inner) {
    const clone = el.cloneNode(true);
    // Local resources are rendered as data: URIs; write the originals back.
    const restore = (node) => {
      if (!node.attributes) return;
      for (const a of Array.from(node.attributes)) {
        if (!a.name.startsWith('data-ld-orig-')) continue;
        const key = a.name.slice('data-ld-orig-'.length);
        if (key === 'css') {
          node.textContent = a.value;
        } else {
          node.setAttribute(key === 'xlink-href' ? 'xlink:href' : key, a.value);
        }
        node.removeAttribute(a.name);
      }
    };
    restore(clone);
    clone.querySelectorAll('*').forEach(restore);
    const strip = (node) => {
      node.removeAttribute('data-ld-id');
      node.removeAttribute('contenteditable');
      node.removeAttribute('spellcheck');
      node.classList.remove(...EDITOR_CLASSES);
      if (node.getAttribute('class') === '') node.removeAttribute('class');
    };
    strip(clone);
    clone.querySelectorAll('*').forEach(strip);

    if (state.config.normalizeMarkup) {
      const swap = (from, to) => {
        Array.from(clone.querySelectorAll(from)).forEach((n) => {
          const r = clone.ownerDocument.createElement(to);
          for (const a of Array.from(n.attributes)) r.setAttribute(a.name, a.value);
          while (n.firstChild) r.appendChild(n.firstChild);
          n.replaceWith(r);
        });
      };
      swap('b', 'strong');
      swap('i', 'em');
      // unwrap editor junk: attribute-less spans and legacy font tags
      Array.from(clone.querySelectorAll('span,font')).forEach((n) => {
        if (n.tagName === 'FONT' || n.attributes.length === 0) {
          while (n.firstChild) n.parentNode.insertBefore(n.firstChild, n);
          n.remove();
        }
      });
    }
    return inner ? clone.innerHTML : clone.outerHTML;
  }

  // ------------------------------------------------------------ op pipeline
  // Ops run strictly one at a time. Payloads are serialized at send time so
  // consecutive keystrokes coalesce for free. On ack the extension returns
  // fresh ids for the rewritten region, which we stamp back into the DOM.

  function enqueue(op) {
    state.opQueue.push(op);
    pump();
  }

  function pump() {
    if (state.pending || !state.opQueue.length) return;
    const op = state.opQueue.shift();
    if (op.kind === 'inner') {
      const root = op.root;
      if (!root.isConnected) { pump(); return; }
      if (!root.getAttribute('data-ld-id')) { state.dirty.add(root); pump(); return; }
      const html = serializeClean(root, true);
      if (html === root.__ldLastSent) { state.dirty.delete(root); pump(); return; }
      root.__ldLastSent = html;
      op.regionEls = [root];
      op.payload = {
        type: 'edit', mode: 'inner',
        id: root.getAttribute('data-ld-id'),
        html, mapVersion: state.mapVersion,
      };
      state.dirty.delete(root);
    } else if (op.kind === 'struct') {
      // Structural op computed host-side from source text (structOps.ts).
      // build() runs at send time so it reads ids re-stamped by earlier acks.
      const p = op.build();
      if (!p) {
        if (op.quiet) { pump(); return; }
        requestReload('struct target detached');
        return;
      }
      op.payload = Object.assign({ type: 'struct', mapVersion: state.mapVersion }, p);
    } else { // outer: replace one old element with op.els
      if (!op.els.every((e) => e.isConnected)) { requestReload('detached region'); return; }
      op.regionEls = op.els;
      op.payload = {
        type: 'edit', mode: 'outer',
        id: op.oldId,
        parts: op.els.map((e) => serializeClean(e, false)),
        mapVersion: state.mapVersion,
      };
      op.els.forEach((e) => { e.__ldLastSent = undefined; });
    }
    state.pending = op;
    post(op.payload);
  }

  function onAck(msg) {
    const op = state.pending;
    state.pending = null;
    state.mapVersion = msg.mapVersion;
    if (op) {
      const els = [];
      for (const rootEl of op.regionEls) {
        if (rootEl.isConnected) {
          els.push(rootEl, ...rootEl.querySelectorAll('*'));
        }
      }
      if (els.length === msg.ids.length) {
        els.forEach((el, i) => el.setAttribute('data-ld-id', msg.ids[i]));
      } else if (op.regionEls.length === 1 && op.regionEls[0].isConnected && msg.ids.length >= 1) {
        // Structure moved under us mid-flight (fast typing). Stamp the root —
        // it is always first in DFS order — and re-flush to converge.
        const root = op.regionEls[0];
        root.setAttribute('data-ld-id', msg.ids[0]);
        root.__ldLastSent = undefined;
        state.dirty.add(root);
      } else {
        requestReload('region mismatch after ack');
        return;
      }
    }
    pump();
    if (state.dirty.size && !state.pending) scheduleFlush(30);
  }

  function onStructAck(msg) {
    const op = state.pending;
    state.pending = null;
    state.mapVersion = msg.mapVersion;
    if (op && op.kind === 'struct' && op.onAck && !msg.noop) {
      try {
        if (op.onAck(msg) === false) { requestReload('struct ack mismatch'); return; }
      } catch (err) {
        requestReload('struct ack: ' + err);
        return;
      }
    }
    refreshOverlay();
    pump();
    if (state.dirty.size && !state.pending) scheduleFlush(30);
  }

  /** Re-stamp elements an op rearranged: [oldId, newId] pairs from the host. */
  function applyPairs(pairs) {
    const doc = state.doc;
    const found = pairs.map(([o]) => doc.querySelector('[data-ld-id="' + o + '"]'));
    found.forEach((el, i) => {
      if (!el) return;
      el.setAttribute('data-ld-id', pairs[i][1]);
      el.__ldLastSent = undefined;
    });
  }

  function requestReload(reason) {
    state.opQueue = [];
    state.pending = null;
    state.dirty.clear();
    post({ type: 'requestReload' });
    post({ type: 'log', text: 'reload requested: ' + reason });
  }

  function scheduleFlush(ms) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(flushDirty, ms ?? state.config.editDebounceMs);
  }

  function flushDirty() {
    for (const root of Array.from(state.dirty)) {
      if (!root.isConnected) { state.dirty.delete(root); continue; }
      if (!root.getAttribute('data-ld-id')) continue; // stamped on next ack
      enqueue({ kind: 'inner', root });
    }
  }

  function markDirty(root) {
    state.dirty.add(root);
    scheduleFlush();
  }

  // ---------------------------------------------------------------- editing

  function activate(root, mouseEvent) {
    if (state.editing && state.editing.root === root) return;
    deactivate();
    root.setAttribute('contenteditable', 'true');
    root.setAttribute('spellcheck', 'false');
    root.classList.add('ld-editing');
    state.editing = { root };
    // Always focus explicitly — relying on the mousedown default action to
    // focus a just-made-editable element is racy, and a keystroke landing on
    // the page instead (space!) scrolls the deck.
    root.focus({ preventScroll: true });
    if (mouseEvent) {
      placeCaretFromPoint(mouseEvent.clientX, mouseEvent.clientY);
    }
    try { state.doc.execCommand('styleWithCSS', false, 'false'); } catch (e) { /* noop */ }
    updateCrumb(root);
    updateToolbar();
    refreshOverlay();
  }

  function switchEditing(newRoot) {
    if (state.editing) {
      const old = state.editing.root;
      old.removeAttribute('contenteditable');
      old.removeAttribute('spellcheck');
      old.classList.remove('ld-editing');
      if (old.getAttribute('class') === '') old.removeAttribute('class');
    }
    state.editing = null;
    activate(newRoot);
  }

  function deactivate(commit) {
    if (commit === undefined) commit = true;
    if (!state.editing) return;
    const root = state.editing.root;
    clearTimeout(state.debounceTimer);
    state.editing = null;
    root.removeAttribute('contenteditable');
    root.removeAttribute('spellcheck');
    root.classList.remove('ld-editing');
    if (root.getAttribute('class') === '') root.removeAttribute('class');
    if (commit) {
      if (root.isConnected) state.dirty.add(root);
      flushDirty();
    } else {
      state.dirty.delete(root);
    }
    updateCrumb(null);
    updateToolbar();
    refreshOverlay();
  }

  function placeCaretFromPoint(x, y) {
    const doc = state.doc;
    if (!doc) return;
    let range = null;
    if (doc.caretRangeFromPoint) {
      range = doc.caretRangeFromPoint(x, y);
    } else if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      if (p) {
        range = doc.createRange();
        range.setStart(p.offsetNode, p.offset);
      }
    }
    if (range && state.editing && state.editing.root.contains(range.startContainer)) {
      range.collapse(true);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // ------------------------------------------------- element selection mode

  function select(el) {
    deselect();
    if (state.editing) deactivate();
    state.selected = el;
    el.classList.add('ld-selected');
    updateCrumb(el);
    const crumb = $('#crumb');
    if (crumb.textContent) {
      crumb.title = 'drag to move · ⌘-drag to reorder · handles resize · ⌫ delete · right-click for more';
      crumb.textContent += '  —  drag to move · ⌫ delete · right-click for more';
    }
    refreshOverlay();
  }

  function deselect() {
    if (!state.selected && !state.extra.length) return;
    for (const el of [state.selected, ...state.extra]) {
      if (!el) continue;
      el.classList.remove('ld-selected');
      if (el.getAttribute('class') === '') el.removeAttribute('class');
    }
    state.selected = null;
    state.extra = [];
    updateCrumb(state.editing ? state.editing.root : null);
    refreshOverlay();
  }

  /** Every selected element, primary first. */
  function selectedEls() {
    return [state.selected, ...state.extra].filter((el) => el && el.isConnected);
  }

  function isMulti() { return selectedEls().length > 1; }

  /** The selected element containing `node`, if any. */
  function selectionContaining(node) {
    return selectedEls().find((el) => el === node || el.contains(node)) || null;
  }

  function updateMultiCrumb() {
    const n = selectedEls().length;
    if (n < 2) { if (state.selected) select(state.selected); return; }
    const crumb = $('#crumb');
    crumb.textContent = `${n} elements selected  —  drag to move · ⌘D duplicate · ⌫ delete`;
    crumb.title = 'shift-click to add or remove · drag to move · arrows nudge · ⌘D duplicate · ⌫ delete';
    refreshOverlay();
  }

  function unselectOne(el) {
    el.classList.remove('ld-selected');
    if (el.getAttribute('class') === '') el.removeAttribute('class');
    if (el === state.selected) state.selected = state.extra.shift() || null;
    else state.extra = state.extra.filter((x) => x !== el);
  }

  /** Shift-click: add or remove one element. Nested picks replace their
   *  ancestor/descendant, so the selection is always disjoint subtrees. */
  function toggleSelect(el) {
    if (state.editing) {
      const root = state.editing.root;
      deactivate();
      if (!state.selected && root.isConnected && root !== el && !root.contains(el) && !el.contains(root)) {
        select(root);
      }
    }
    if (selectedEls().includes(el)) {
      unselectOne(el);
    } else {
      for (const s of selectedEls()) if (s.contains(el) || el.contains(s)) unselectOne(s);
      if (!state.selected) { select(el); return; }
      state.extra.push(el);
      el.classList.add('ld-selected');
    }
    if (!state.selected) { deselect(); return; }
    updateMultiCrumb();
  }

  /** Select a set of elements at once (marquee, multi-duplicate). */
  function selectMany(els, additive) {
    const list = additive ? selectedEls().concat(els) : els.slice();
    const disjoint = list.filter((el, i) => list.indexOf(el) === i
      && !list.some((o) => o !== el && o.contains(el)));
    if (!disjoint.length) { if (!additive) deselect(); return; }
    select(disjoint[0]);
    for (const el of disjoint.slice(1)) { state.extra.push(el); el.classList.add('ld-selected'); }
    updateMultiCrumb();
  }

  function deleteSelected() {
    const els = selectedEls().filter((el) => el.getAttribute('data-ld-id'));
    deselect();
    if (!els.length) return;
    for (const el of els) {
      const oldId = el.getAttribute('data-ld-id');
      el.remove();
      enqueue({ kind: 'outer', oldId, els: [] });
    }
    toast((els.length > 1 ? `Deleted ${els.length} elements` : 'Deleted <' + els[0].tagName.toLowerCase() + '>') + ' — ⌘Z to undo');
  }

  function duplicateSelection() {
    const els = selectedEls();
    if (els.length < 2) { if (els[0]) duplicateElement(els[0]); return; }
    deselect();
    const clones = els.map((el) => duplicateElement(el, true)).filter(Boolean);
    selectMany(clones, false);
    toast(`Duplicated ${clones.length} elements — ⌘Z to undo`);
  }

  /** Element a ⌥-click selects: the text root if there is one, else the
   *  nearest source-mapped element (makes images/svg/charts selectable). */
  function selectionTarget(target) {
    const doc = state.doc;
    const media = mediaTarget(target);
    if (media) return media;
    const root = findRoot(target);
    if (root) return root;
    if (!target.closest) return null;
    const el = target.closest('[data-ld-id]');
    if (!el || el === doc.body || el === doc.documentElement) return null;
    return el;
  }

  function caretToStart(el) {
    const doc = state.doc;
    const sel = doc.getSelection();
    const r = doc.createRange();
    r.setStart(el, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // ------------------------------------------- element ops: menu, move, size

  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'HR', 'PICTURE', 'OBJECT', 'EMBED']);
  const SIZE_PROPS = ['width', 'height', 'min-height', 'max-width'];

  function stamped(el) { return !!(el && el.isConnected && el.getAttribute('data-ld-id')); }

  /** Images, figures and rules: click selects them (rather than editing the
   *  surrounding text) so they can be moved, resized and deleted directly.
   *  Anything inside an <svg> resolves to the outermost svg. */
  function mediaTarget(target) {
    const doc = state.doc;
    if (!doc || !target || !(target instanceof doc.defaultView.Element)) return null;
    let svg = target.closest('svg');
    if (svg) {
      for (let up = svg.parentElement && svg.parentElement.closest('svg'); up;
        up = up.parentElement && up.parentElement.closest('svg')) svg = up;
      return stamped(svg) ? svg : null;
    }
    let el = target;
    if (el.tagName !== 'PICTURE' && el.parentElement && el.parentElement.tagName === 'PICTURE') el = el.parentElement;
    return MEDIA_TAGS.has(el.tagName) && stamped(el) ? el : null;
  }

  function stampedSibling(el, dir) {
    let s = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    while (s && !s.getAttribute('data-ld-id')) s = dir < 0 ? s.previousElementSibling : s.nextElementSibling;
    return s;
  }

  function stampedParent(el) {
    const p = el.parentElement && el.parentElement.closest('[data-ld-id]');
    return p && p !== state.doc.body ? p : null;
  }

  function isSlide(el) { return state.slides.includes(el); }

  /** CSS px → iframe viewport px for content inside `el`'s parent (decks that
   *  scale themselves to fit, e.g. a transformed 1280×720 canvas). */
  function deckScale(el) {
    const p = el.parentElement;
    if (!p || !p.offsetWidth) return 1;
    return p.getBoundingClientRect().width / p.offsetWidth || 1;
  }

  /** Current CSS `translate` of an element in px, or null if not in px. */
  function currentTranslate(el) {
    const win = state.doc.defaultView;
    const v = (el.style.translate || win.getComputedStyle(el).translate || 'none').trim();
    if (v === 'none' || v === '' || v === '0px') return { x: 0, y: 0 };
    const m = v.match(/^(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?(?:\s+-?[\d.]+px)?$/);
    return m ? { x: +m[1], y: m[2] ? +m[2] : 0 } : null;
  }

  function hasInline(el, props) { return props.some((p) => el.style.getPropertyValue(p)); }

  /** Write already-applied inline style changes to the element's start tag. */
  function commitStyle(el, props) {
    enqueue({
      kind: 'struct',
      quiet: true,
      build: () => (stamped(el) ? { op: 'style', id: el.getAttribute('data-ld-id'), props } : null),
      onAck: (msg) => {
        applyPairs(msg.pairs);
        if (el.hasAttribute('data-ld-orig-style')) {
          if (msg.styleAttr == null) el.removeAttribute('data-ld-orig-style');
          else el.setAttribute('data-ld-orig-style', msg.styleAttr);
        }
      },
    });
  }

  function resetProps(el, names) {
    const props = {};
    names.forEach((n) => { props[n] = null; el.style.removeProperty(n); });
    if (el.getAttribute('style') === '') el.removeAttribute('style');
    refreshOverlay();
    commitStyle(el, props);
  }

  function commitTranslate(el) {
    const t = currentTranslate(el) || { x: 0, y: 0 };
    const x = Math.round(t.x);
    const y = Math.round(t.y);
    if (!x && !y) {
      el.style.removeProperty('translate');
      if (el.getAttribute('style') === '') el.removeAttribute('style');
      commitStyle(el, { translate: null });
    } else {
      el.style.translate = `${x}px ${y}px`;
      commitStyle(el, { translate: `${x}px ${y}px` });
    }
  }

  function nudge(el, dx, dy) {
    const t = currentTranslate(el);
    if (!t) { toast('This element has a non-px CSS translate; can’t move it'); return; }
    el.style.translate = `${Math.round(t.x + dx)}px ${Math.round(t.y + dy)}px`;
    refreshOverlay();
    state.nudged.add(el);
    clearTimeout(state.nudgeTimer);
    state.nudgeTimer = setTimeout(() => {
      const els = Array.from(state.nudged);
      state.nudged.clear();
      els.forEach((n) => { if (n.isConnected) commitTranslate(n); });
    }, 500);
  }

  function duplicateElement(el, quiet) {
    if (!stamped(el)) return null;
    if (!quiet) deselect();
    const clone = el.cloneNode(true);
    const cloneStamped = [clone, ...clone.querySelectorAll('[data-ld-id]')]
      .filter((n) => n.hasAttribute('data-ld-id'));
    cloneStamped.forEach((n) => n.removeAttribute('data-ld-id'));
    [clone, ...clone.querySelectorAll('.ld-hover,.ld-editing,.ld-selected')].forEach((n) => {
      n.classList.remove('ld-hover', 'ld-editing', 'ld-selected');
      n.removeAttribute('contenteditable');
      n.removeAttribute('spellcheck');
      if (n.getAttribute('class') === '') n.removeAttribute('class');
    });
    el.after(clone);
    let sentIds = null;
    enqueue({
      kind: 'struct',
      build: () => {
        if (!stamped(el) || !clone.isConnected) return null;
        sentIds = [el, ...el.querySelectorAll('[data-ld-id]')].map((n) => n.getAttribute('data-ld-id'));
        return { op: 'duplicate', id: el.getAttribute('data-ld-id') };
      },
      onAck: (msg) => {
        // the copy's stamped elements line up with the original's by position
        if (sentIds.length !== cloneStamped.length) return false;
        const pos = new Map(sentIds.map((id, i) => [id, i]));
        for (const [o, n] of msg.pairs) {
          const c = cloneStamped[pos.get(o)];
          if (c) c.setAttribute('data-ld-id', n);
        }
        detectSlides();
      },
    });
    if (!quiet) {
      select(clone);
      toast('Duplicated <' + el.tagName.toLowerCase() + '> — ⌘Z to undo');
    }
    return clone;
  }

  function moveElement(el, target, before) {
    if (!stamped(el) || !stamped(target) || el === target) return;
    if (before ? el.nextElementSibling === target : el.previousElementSibling === target) return;
    if (before) target.before(el); else target.after(el);
    enqueue({
      kind: 'struct',
      build: () => (stamped(el) && stamped(target)
        ? { op: 'move', id: el.getAttribute('data-ld-id'), targetId: target.getAttribute('data-ld-id'), before }
        : null),
      onAck: (msg) => { applyPairs(msg.pairs); detectSlides(); },
    });
    if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(false);
    refreshOverlay();
  }

  function moveStep(el, dir) {
    const sib = stampedSibling(el, dir);
    if (sib) moveElement(el, sib, dir < 0);
  }

  // images ------------------------------------------------------------------

  const imageReqs = new Map();
  let imageReqSeq = 0;

  function requestImage(msg) {
    return new Promise((resolve) => {
      const reqId = ++imageReqSeq;
      imageReqs.set(reqId, resolve);
      post(Object.assign({ reqId }, msg));
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  function naturalSize(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ w: 0, h: 0 });
      img.src = src;
    });
  }

  const IMAGE_NAME = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

  function imageFiles(dt) {
    if (!dt) return [];
    const out = [];
    for (const f of Array.from(dt.files || [])) {
      if ((f.type && f.type.startsWith('image/')) || IMAGE_NAME.test(f.name)) out.push(f);
    }
    if (!out.length) {
      for (const it of Array.from(dt.items || [])) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) out.push(f);
        }
      }
    }
    return out;
  }

  /** Where a new image goes. Slides get it appended; other elements get it
   *  as the next sibling; list items / table cells get it inline at the caret. */
  function placementFor(el) {
    if (!el) return defaultPlacement();
    if (isSlide(el)) return { anchor: el, where: 'append' };
    return { anchor: el, where: 'after' };
  }

  function defaultPlacement() {
    const doc = state.doc;
    const slide = state.slides[state.slideIdx];
    if (stamped(slide)) return { anchor: slide, where: 'append' };
    const win = doc.defaultView;
    let el = doc.elementFromPoint(win.innerWidth / 2, win.innerHeight / 2);
    while (el && el.parentElement && el.parentElement !== doc.body) el = el.parentElement;
    if (stamped(el) && el !== doc.body) return { anchor: el, where: 'after' };
    const kids = Array.from(doc.body.children).filter(stamped);
    return kids.length ? { anchor: kids[kids.length - 1], where: 'after' } : null;
  }

  function pastePlacement() {
    if (state.editing) {
      const root = state.editing.root;
      if (LIST_TAGS.has(root.tagName) || root.closest('td,th,caption,dt,dd,summary')) {
        return { inline: root };
      }
      return { anchor: root, where: 'after' };
    }
    return state.selected ? placementFor(state.selected) : defaultPlacement();
  }

  async function addImages(files, placement) {
    for (const f of files) {
      let data;
      try { data = await blobToBase64(f); } catch (err) { toast('Could not read image'); continue; }
      // clipboard screenshots arrive as "image.png" — let the host timestamp them
      const name = f.name && !/^image\.\w+$/i.test(f.name) ? f.name : '';
      const res = await requestImage({ type: 'saveImage', mime: f.type, name, data });
      await placeImage(res, placement);
    }
  }

  async function pickImage(placement) {
    const res = await requestImage({ type: 'pickImage' });
    await placeImage(res, placement);
  }

  async function placeImage(res, placement) {
    if (!res || res.cancelled) return;
    if (res.error) { toast(res.error); return; }
    if (!placement || !state.doc) { toast('Nowhere to insert the image'); return; }
    const dims = await naturalSize(res.dataUri);
    const box = placement.inline || (placement.where === 'append' ? placement.anchor : placement.anchor.parentElement);
    const cap = Math.max(80, Math.round(((box && box.clientWidth) || 960) * (placement.inline ? 0.4 : 0.6)));
    const width = Math.round(Math.min(dims.w || cap, cap));

    if (placement.inline) {
      const root = placement.inline;
      if (!root.isConnected) return;
      const doc = state.doc;
      const img = doc.createElement('img');
      img.setAttribute('src', res.dataUri);
      img.setAttribute('data-ld-orig-src', res.src); // written back instead of the data: URI
      img.setAttribute('alt', '');
      img.setAttribute('width', String(width));
      if (state.editing && state.editing.root === root) {
        root.focus({ preventScroll: true });
        restoreSelection();
      }
      const sel = doc.getSelection();
      if (sel.rangeCount && root.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0);
        r.deleteContents();
        r.insertNode(img);
        r.setStartAfter(img);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      } else {
        root.appendChild(img);
      }
      markDirty(root);
      return;
    }

    const { anchor, where } = placement;
    if (state.editing) deactivate();
    enqueue({
      kind: 'struct',
      quiet: true,
      build: () => (stamped(anchor)
        ? { op: 'insertImage', anchorId: anchor.getAttribute('data-ld-id'), where, src: res.src, width }
        : null),
      onAck: (msg) => {
        if (!msg.insertHtml || !msg.ids || !msg.ids.length) return false;
        if (where === 'after') {
          anchor.insertAdjacentHTML('afterend', msg.insertHtml);
        } else {
          const kids = Array.from(anchor.children).filter((k) => k.getAttribute('data-ld-id'));
          const last = kids[kids.length - 1];
          if (last) last.insertAdjacentHTML('afterend', msg.insertHtml);
          else anchor.insertAdjacentHTML('beforeend', msg.insertHtml);
        }
        const el = state.doc.querySelector('[data-ld-id="' + msg.ids[0] + '"]');
        if (!el) return false;
        select(el);
        el.addEventListener('load', refreshOverlay, { once: true });
        if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded(false);
        toast('Image added — drag to move, handles resize');
      },
    });
  }

  // context menu ------------------------------------------------------------

  function frameToShell(x, y) {
    const r = state.frame.getBoundingClientRect();
    return { x: r.left + x * state.zoom, y: r.top + y * state.zoom };
  }

  function closeMenu() {
    const m = $('#ctx-menu');
    if (m && !m.hidden) m.hidden = true;
  }

  function openMenu(el, clientX, clientY) {
    const items = [];
    if (el && isMulti()) {
      const els = selectedEls();
      const n = els.length;
      items.push([`Duplicate ${n} elements`, '⌘D', duplicateSelection]);
      items.push([`Delete ${n} elements`, '⌫', deleteSelected]);
      if (els.some((x) => hasInline(x, ['translate']))) {
        items.push(['Reset positions', '', () => els.forEach((x) => { if (hasInline(x, ['translate'])) resetProps(x, ['translate']); })]);
      }
      items.push('-');
      items.push(['Clear selection', 'Esc', deselect]);
    } else if (el) {
      const prev = stampedSibling(el, -1);
      const next = stampedSibling(el, 1);
      const parent = stampedParent(el);
      const ok = stamped(el);
      items.push(['AI this element…', '', () => openAi(el), !ok]);
      items.push('-');
      items.push(['Duplicate', '⌘D', () => duplicateElement(el), !ok]);
      items.push(['Delete', '⌫', () => { select(el); deleteSelected(); }, !ok]);
      items.push('-');
      items.push(['Move up', '⌥↑', () => moveStep(el, -1), !ok || !prev]);
      items.push(['Move down', '⌥↓', () => moveStep(el, 1), !ok || !next]);
      if (hasInline(el, ['translate'])) items.push(['Reset position', '', () => resetProps(el, ['translate'])]);
      if (hasInline(el, SIZE_PROPS)) items.push(['Reset size', '', () => resetProps(el, SIZE_PROPS)]);
      items.push('-');
      items.push(['Select parent', '', () => select(parent), !parent]);
      items.push([isSlide(el) ? 'Insert image in slide…' : 'Insert image after…', '', () => pickImage(placementFor(el)), !ok]);
      items.push(['Reveal in source', '', () => post({ type: 'reveal', id: el.getAttribute('data-ld-id') }), !ok]);
    } else {
      items.push(['Insert image…', '', () => pickImage(defaultPlacement())]);
    }

    const m = $('#ctx-menu');
    m.replaceChildren();
    for (const it of items) {
      if (it === '-') { m.appendChild(Object.assign(document.createElement('div'), { className: 'ctx-sep' })); continue; }
      const [label, keys, fn, disabled] = it;
      const b = document.createElement('button');
      b.disabled = !!disabled;
      b.innerHTML = '<span></span><kbd></kbd>';
      b.firstChild.textContent = label;
      b.lastChild.textContent = keys;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep deck focus
      b.addEventListener('click', () => { closeMenu(); fn(); });
      m.appendChild(b);
    }
    m.hidden = false;
    const p = frameToShell(clientX, clientY);
    const w = m.offsetWidth;
    const h = m.offsetHeight;
    m.style.left = Math.max(4, Math.min(p.x, window.innerWidth - w - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(p.y, window.innerHeight - h - 4)) + 'px';
  }

  // selection overlay + resize handles ---------------------------------------

  /** The element resize handles attach to: the selection, else the text box being edited. */
  function overlayTarget() {
    const el = state.selected || (state.editing && state.editing.root);
    return stamped(el) || (el && el.isConnected && el === state.selected) ? el : null;
  }

  function refreshOverlay() {
    const box = $('#sel-box');
    if (!box) return;
    const el = state.doc && overlayTarget();
    if (!el || state.extra.length || (state.drag && state.drag.moved && state.drag.reorder)) { box.hidden = true; return; }
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) { box.hidden = true; return; }
    const z = state.zoom;
    box.hidden = false;
    box.style.left = r.left * z + 'px';
    box.style.top = r.top * z + 'px';
    box.style.width = r.width * z + 'px';
    box.style.height = r.height * z + 'px';
    box.classList.toggle('media', !!mediaTarget(el));
  }

  function startResize(dir, e) {
    const el = overlayTarget();
    if (!el || !stamped(el)) return;
    const win = state.doc.defaultView;
    const cs = win.getComputedStyle(el);
    const t0 = currentTranslate(el);
    if (dir === 'w' && !t0) { toast('This element has a non-px CSS translate'); return; }
    const w0 = parseFloat(cs.width) || el.getBoundingClientRect().width;
    const h0 = parseFloat(cs.height) || el.getBoundingClientRect().height;
    state.resize = {
      el, dir, x0: e.clientX, y0: e.clientY, w0, h0, t0,
      scale: deckScale(el) * state.zoom,
      media: !!mediaTarget(el),
      maxWidth: cs.maxWidth,
      before: SIZE_PROPS.concat('translate').map((p) => [p, el.style.getPropertyValue(p)]),
      props: {},
    };
  }

  function moveResize(e) {
    const rs = state.resize;
    if (!rs) return;
    const dx = (e.clientX - rs.x0) / rs.scale;
    const dy = (e.clientY - rs.y0) / rs.scale;
    const el = rs.el;
    const set = (p, v) => { el.style.setProperty(p, v); rs.props[p] = v; };
    let w = rs.w0;
    if (rs.dir.includes('e')) w = rs.w0 + dx;
    if (rs.dir === 'w') w = rs.w0 - dx;
    w = Math.max(16, Math.round(w));
    if (rs.dir !== 's') {
      set('width', w + 'px');
      if (w > rs.w0 && rs.maxWidth !== 'none') set('max-width', 'none');
      if (rs.dir === 'w') {
        const shift = rs.w0 - w;
        set('translate', `${Math.round(rs.t0.x + shift)}px ${Math.round(rs.t0.y)}px`);
      }
    }
    if (rs.media) {
      // keep the aspect ratio: width drives, height follows
      if (rs.dir === 's') set('width', Math.max(16, Math.round(rs.w0 * (rs.h0 + dy) / rs.h0)) + 'px');
      set('height', 'auto');
    } else if (rs.dir.includes('s')) {
      set('min-height', Math.max(8, Math.round(rs.h0 + dy)) + 'px');
    }
    refreshOverlay();
  }

  function endResize(cancel) {
    const rs = state.resize;
    state.resize = null;
    if (!rs) return;
    if (cancel || !Object.keys(rs.props).length) {
      for (const [p, v] of rs.before) {
        if (v) rs.el.style.setProperty(p, v); else rs.el.style.removeProperty(p);
      }
      refreshOverlay();
      return;
    }
    commitStyle(rs.el, rs.props);
  }

  // drag to move / ⌘-drag to reorder ------------------------------------------

  function beginDragPending(el, e, keepSelected) {
    state.drag = {
      el, x0: e.clientX, y0: e.clientY, moved: false,
      reorder: e.metaKey || e.ctrlKey,
      keep: keepSelected,
      target: e.target,
      down: { clientX: e.clientX, clientY: e.clientY },
    };
    try {
      if (state.lastPointerId != null && e.target.setPointerCapture) e.target.setPointerCapture(state.lastPointerId);
    } catch (err) { /* capture is best-effort */ }
  }

  function startDrag(d) {
    if (state.hoverEl) { state.hoverEl.classList.remove('ld-hover'); state.hoverEl = null; }
    if (d.reorder && isMulti()) { d.abort = true; toast('⌘-drag reorders one element at a time'); return; }
    if (d.reorder) {
      const parent = d.el.parentElement;
      d.sibs = parent ? Array.from(parent.children).filter((s) => s !== d.el && stamped(s)) : [];
      if (!d.sibs.length || !stamped(d.el)) { d.abort = true; toast('Nothing to reorder with here'); return; }
      const cs = state.doc.defaultView.getComputedStyle(parent);
      d.horizontal = (/flex/.test(cs.display) && cs.flexDirection.startsWith('row'))
        || (/grid/.test(cs.display) && cs.gridTemplateColumns.trim().split(/\s+/).length > 1);
      return;
    }
    // free move: the whole selection when the pressed element is part of it
    const els = selectionContaining(d.el) ? selectedEls() : [d.el];
    d.items = [];
    for (const el of els) {
      const t0 = currentTranslate(el);
      if (!t0) { d.abort = true; toast('An element has a non-px CSS translate; can’t move it'); return; }
      d.items.push({ el, t0, scale: deckScale(el), orig: el.style.translate });
    }
    d.items.forEach((it) => it.el.classList.add('ld-dragging'));
  }

  function updateReorder(d, e) {
    let best = null;
    let bestDist = Infinity;
    for (const s of d.sibs) {
      const r = s.getBoundingClientRect();
      const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right);
      const dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
      const dist = Math.hypot(dx, dy);
      if (dist < bestDist) { bestDist = dist; best = { s, r }; }
    }
    const ind = $('#drop-ind');
    if (!best) { ind.hidden = true; d.drop = null; return; }
    const { s, r } = best;
    const before = d.horizontal ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    d.drop = { target: s, before };
    const z = state.zoom;
    ind.hidden = false;
    if (d.horizontal) {
      Object.assign(ind.style, {
        left: ((before ? r.left : r.right) * z - 1.5) + 'px', top: r.top * z + 'px',
        width: '3px', height: r.height * z + 'px',
      });
    } else {
      Object.assign(ind.style, {
        left: r.left * z + 'px', top: ((before ? r.top : r.bottom) * z - 1.5) + 'px',
        width: r.width * z + 'px', height: '3px',
      });
    }
  }

  function onDragMove(e) {
    const d = state.drag;
    if (!d) return;
    if (!(e.buttons & 1)) { endDrag(false); return; }
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      startDrag(d);
      if (d.abort) { state.drag = null; return; }
    }
    e.preventDefault();
    if (d.reorder) {
      updateReorder(d, e);
    } else {
      let mx = dx;
      let my = dy;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) my = 0; else mx = 0; } // axis lock
      for (const it of d.items) {
        it.el.style.translate = `${Math.round(it.t0.x + mx / it.scale)}px ${Math.round(it.t0.y + my / it.scale)}px`;
      }
    }
    refreshOverlay();
  }

  function endDrag(commit) {
    const d = state.drag;
    state.drag = null;
    if (!d) return;
    $('#drop-ind').hidden = true;
    for (const it of d.items || [{ el: d.el }]) {
      it.el.classList.remove('ld-dragging');
      if (it.el.getAttribute('class') === '') it.el.removeAttribute('class');
    }
    if (!d.moved) {
      if (commit && !d.keep) {
        // a plain click on an already-selected element: drop into text editing
        deselect();
        const root = findRoot(d.target);
        if (root) activate(root, d.down);
      }
      return;
    }
    if (d.reorder) {
      if (commit && d.drop) moveElement(d.el, d.drop.target, d.drop.before);
      refreshOverlay();
      return;
    }
    for (const it of d.items) {
      if (!commit) {
        if (it.orig) it.el.style.translate = it.orig; else it.el.style.removeProperty('translate');
        if (it.el.getAttribute('style') === '') it.el.removeAttribute('style');
      } else if (it.el.style.translate !== it.orig) {
        commitTranslate(it.el);
      }
    }
    refreshOverlay();
  }

  // rubber-band (marquee) selection -------------------------------------------

  function beginMarquee(e) {
    state.marquee = { x0: e.clientX, y0: e.clientY, moved: false, additive: e.shiftKey, start: e.target };
    try {
      if (state.lastPointerId != null && e.target.setPointerCapture) e.target.setPointerCapture(state.lastPointerId);
    } catch (err) { /* best-effort */ }
  }

  function marqueeRect(m, e) {
    return {
      left: Math.min(m.x0, e.clientX), top: Math.min(m.y0, e.clientY),
      right: Math.max(m.x0, e.clientX), bottom: Math.max(m.y0, e.clientY),
    };
  }

  function onMarqueeMove(e) {
    const m = state.marquee;
    if (!m) return;
    if (!(e.buttons & 1)) { endMarquee(null); return; }
    if (!m.moved && Math.hypot(e.clientX - m.x0, e.clientY - m.y0) < 4) return;
    m.moved = true;
    e.preventDefault();
    const r = marqueeRect(m, e);
    const z = state.zoom;
    Object.assign($('#marquee').style, {
      left: r.left * z + 'px', top: r.top * z + 'px',
      width: (r.right - r.left) * z + 'px', height: (r.bottom - r.top) * z + 'px',
    });
    $('#marquee').hidden = false;
  }

  /** Select the outermost source elements lying fully inside the band —
   *  never the container the drag started on (the slide background). */
  function endMarquee(e) {
    const m = state.marquee;
    state.marquee = null;
    $('#marquee').hidden = true;
    if (!m || !m.moved || !e) return;
    const r = marqueeRect(m, e);
    const hits = Array.from(state.doc.querySelectorAll('[data-ld-id]')).filter((el) => {
      if (el.contains(m.start)) return false;
      if (el.parentElement && el.parentElement.closest('svg')) return false;
      const b = el.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && b.left >= r.left && b.right <= r.right
        && b.top >= r.top && b.bottom <= r.bottom;
    });
    let outer = hits.filter((el) => !hits.some((o) => o !== el && o.contains(el)));
    // a lone invisible wrapper (e.g. the row holding three cards): pick its items
    while (outer.length === 1) {
      const kids = Array.from(outer[0].children).filter((k) => k.getAttribute('data-ld-id'));
      if (kids.length < 2 || !kids.every((k) => hits.includes(k))) break;
      outer = kids;
    }
    selectMany(outer, m.additive);
  }

  // Structural op helpers ---------------------------------------------------

  function copyAttrs(from, to) {
    for (const a of Array.from(from.attributes)) {
      if (a.name === 'data-ld-id' || a.name === 'contenteditable' || a.name === 'spellcheck') continue;
      if (a.name === 'class') {
        const cls = a.value.split(/\s+/).filter((c) => c && !EDITOR_CLASSES.includes(c));
        if (cls.length) to.setAttribute('class', cls.join(' '));
        continue;
      }
      to.setAttribute(a.name, a.value);
    }
  }

  /** Enter in a paragraph-like root: split it into two elements. */
  function splitBlock(root) {
    const doc = state.doc;
    const sel = doc.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const tail = doc.createRange();
    tail.setStart(range.startContainer, range.startOffset);
    tail.setEnd(root, root.childNodes.length);
    const frag = tail.extractContents();
    const fresh = doc.createElement(root.tagName.toLowerCase());
    copyAttrs(root, fresh);
    fresh.appendChild(frag);
    if (!fresh.childNodes.length) fresh.appendChild(doc.createElement('br'));
    if (!root.childNodes.length) root.appendChild(doc.createElement('br'));
    const oldId = root.getAttribute('data-ld-id');
    root.after(fresh);
    switchEditing(fresh);
    caretToStart(fresh);
    enqueue({ kind: 'outer', oldId, els: [root, fresh] });
  }

  /** Enter on an empty list item: leave the list, continuing in a paragraph. */
  function exitListItem(li, list) {
    const doc = state.doc;
    const p = doc.createElement('p');
    p.appendChild(doc.createElement('br'));
    const oldId = list.getAttribute('data-ld-id');
    list.after(p);
    li.remove();
    const els = list.querySelector('li') ? [list, p] : [p];
    if (els.length === 1) list.remove();
    switchEditing(p);
    caretToStart(p);
    enqueue({ kind: 'outer', oldId, els });
  }

  function indentLi(li) {
    const prev = li.previousElementSibling;
    if (!prev || prev.tagName !== 'LI') return false;
    const parent = li.parentElement;
    let sub = null;
    for (let i = prev.children.length - 1; i >= 0; i--) {
      if (LIST_TAGS.has(prev.children[i].tagName)) { sub = prev.children[i]; break; }
    }
    if (!sub) {
      sub = state.doc.createElement(parent.tagName.toLowerCase());
      prev.appendChild(sub);
    }
    sub.appendChild(li);
    return true;
  }

  function outdentLi(li) {
    const list = li.parentElement;
    if (!list || !LIST_TAGS.has(list.tagName)) return false;
    const hostLi = list.parentElement && list.parentElement.closest('li');
    if (!hostLi) return false; // already top level
    hostLi.after(li);
    if (!list.querySelector('li')) list.remove();
    return true;
  }

  /** Toolbar list toggle. Converts paragraph⇄list or switches list type. */
  function toggleList(kind) {
    const editing = state.editing;
    if (!editing) return;
    const doc = state.doc;
    const root = editing.root;
    const tag = kind === 'ol' ? 'ol' : 'ul';

    if (LIST_TAGS.has(root.tagName)) {
      if (root.tagName.toLowerCase() === tag) {
        // toggle off: every top-level li becomes a paragraph
        const oldId = root.getAttribute('data-ld-id');
        const els = [];
        for (const li of Array.from(root.children)) {
          if (li.tagName !== 'LI') continue;
          // <p> cannot legally contain a nested list — the HTML parser would
          // split it and break the DOM↔source alignment, so use <div> then.
          const hasBlock = Array.from(li.children).some((c) => BLOCKISH.has(c.tagName));
          const p = doc.createElement(hasBlock ? 'div' : 'p');
          while (li.firstChild) p.appendChild(li.firstChild);
          if (!p.childNodes.length) p.appendChild(doc.createElement('br'));
          els.push(p);
          root.before(p);
        }
        root.remove();
        if (!els.length) return;
        switchEditing(els[0]);
        caretToStart(els[0]);
        enqueue({ kind: 'outer', oldId, els });
      } else {
        // switch ul ⇄ ol
        const oldId = root.getAttribute('data-ld-id');
        const fresh = doc.createElement(tag);
        copyAttrs(root, fresh);
        while (root.firstChild) fresh.appendChild(root.firstChild);
        root.replaceWith(fresh);
        switchEditing(fresh);
        caretToStart(fresh);
        enqueue({ kind: 'outer', oldId, els: [fresh] });
      }
      return;
    }

    // paragraph-like → list
    const oldId = root.getAttribute('data-ld-id');
    const list = doc.createElement(tag);
    const li = doc.createElement('li');
    while (root.firstChild) li.appendChild(root.firstChild);
    list.appendChild(li);
    root.replaceWith(list);
    switchEditing(list);
    caretToStart(li);
    enqueue({ kind: 'outer', oldId, els: [list] });
  }

  function setAlignment(root, value) {
    if (root.style.textAlign === value) {
      root.style.textAlign = '';
      if (!root.getAttribute('style')) root.removeAttribute('style');
    } else {
      root.style.textAlign = value;
    }
    const oldId = root.getAttribute('data-ld-id');
    enqueue({ kind: 'outer', oldId, els: [root] });
  }

  function toggleInlineCode() {
    const doc = state.doc;
    const sel = doc.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const anchor = sel.anchorNode instanceof doc.defaultView.Element
      ? sel.anchorNode : sel.anchorNode.parentElement;
    const codeEl = anchor && anchor.closest('code');
    if (codeEl && state.editing.root.contains(codeEl)) {
      while (codeEl.firstChild) codeEl.parentNode.insertBefore(codeEl.firstChild, codeEl);
      codeEl.remove();
    } else {
      const range = sel.getRangeAt(0);
      const code = doc.createElement('code');
      try {
        range.surroundContents(code);
      } catch (e) {
        // selection crosses element boundaries — fall back to plain text wrap
        const text = sel.toString();
        code.textContent = text;
        range.deleteContents();
        range.insertNode(code);
      }
      sel.removeAllRanges();
      const r = doc.createRange();
      r.selectNodeContents(code);
      sel.addRange(r);
    }
    markDirty(state.editing.root);
  }

  // ----------------------------------------------------------- iframe wiring

  // Window scroll plus any scrolled inner containers (indexed by DFS
  // position) — some decks scroll an element, not the window.
  function captureScrollState() {
    const w = state.frame && state.frame.contentWindow;
    const d = state.doc;
    if (!w || !d || !d.body) return null;
    const els = [];
    const all = d.querySelectorAll('*');
    for (let i = 0; i < all.length && els.length < 8; i++) {
      if (all[i].scrollTop || all[i].scrollLeft) {
        els.push({ i, top: all[i].scrollTop, left: all[i].scrollLeft });
      }
    }
    return { x: w.scrollX, y: w.scrollY, els };
  }

  function restoreScrollState(scroll) {
    const w = state.frame && state.frame.contentWindow;
    const d = state.doc;
    if (!scroll || !w || !d) return;
    w.scrollTo(scroll.x, scroll.y);
    if (scroll.els && scroll.els.length) {
      const all = d.querySelectorAll('*');
      for (const s of scroll.els) {
        const el = all[s.i];
        if (el) { el.scrollTop = s.top; el.scrollLeft = s.left; }
      }
    }
  }

  function render(html) {
    const holder = $('#frame-holder');
    const preserve = !state.firstRender && state.frame && state.frame.contentWindow;
    const scroll = preserve ? captureScrollState() : null;

    state.editing = null;
    state.selected = null;
    state.drag = null;
    state.resize = null;
    state.extra = [];
    state.marquee = null;
    state.nudged.clear();
    closeMenu();
    if (ai.reqId) closeAi();
    state.dirty.clear();
    state.opQueue = [];
    state.pending = null;
    state.hoverEl = null;
    state.slides = [];
    state.doc = null;

    const frame = document.createElement('iframe');
    frame.id = 'deck-frame';
    frame.setAttribute('title', 'deck');
    holder.replaceChildren(frame, $('#overlay'));
    $('#sel-box').hidden = true;
    state.frame = frame;
    state.firstRender = false;

    let wired = false;
    const finishWire = (doc) => {
      if (wired) return;
      wired = true;
      state.doc = doc;
      wire(doc);
      restoreScrollState(scroll);
      detectSlides();
    };
    // Wire as soon as the srcdoc document is parsing (don't wait for images).
    const attempt = () => {
      if (wired || state.frame !== frame || !frame.isConnected) return;
      const doc = frame.contentDocument;
      if (doc && doc.URL === 'about:srcdoc' && doc.body) {
        finishWire(doc);
        return;
      }
      requestAnimationFrame(attempt);
    };
    frame.addEventListener('load', () => {
      if (state.frame !== frame) return;
      if (frame.contentDocument) finishWire(frame.contentDocument);
      restoreScrollState(scroll);
      nudgeDeckResize();
      autoFit();
      setTimeout(() => {
        if (state.frame !== frame) return;
        restoreScrollState(scroll);
        nudgeDeckResize();
        autoFit();
        detectSlides();
      }, 150);
      detectSlides();
      if (state.fitMode) fitWidth();
    });
    // Load via srcdoc, NOT document.open()/write(): document.open() nulls the
    // document's service-worker controller — the thing that serves local
    // vscode-resource files — so with write(), the deck's local images and
    // stylesheets never load. srcdoc documents inherit the controller.
    frame.srcdoc = html;
    applyZoom();
    requestAnimationFrame(attempt);
  }

  function injectEditingStyle(doc) {
    const style = doc.createElement('style');
    style.setAttribute('data-livedeck', '');
    style.textContent = `
      .ld-hover { outline: 1.5px dashed rgba(64,156,255,.65) !important; outline-offset: 2px; cursor: text; }
      .ld-selected { outline: 2.5px solid rgba(255,145,60,.95) !important; outline-offset: 2px; background-color: rgba(255,145,60,.07); }
      .ld-editing { outline: 2px solid rgba(64,156,255,.9) !important; outline-offset: 2px; }
      .ld-editing:focus { outline: 2px solid rgba(64,156,255,.9) !important; }
      [contenteditable="true"]:empty::before { content: '\\200b'; }
      .ld-dragging { cursor: grabbing !important; }
      .ld-selected { cursor: grab; }
      .ld-ai-busy { outline: 2.5px dashed rgba(160,110,255,.95) !important; outline-offset: 3px; animation: ld-ai-pulse 1.2s ease-in-out infinite; }
      @keyframes ld-ai-pulse { 50% { outline-color: rgba(160,110,255,.35); } }
    `;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function wire(doc) {
    injectEditingStyle(doc);
    const win = doc.defaultView;

    doc.addEventListener('pointerdown', (e) => { state.lastPointerId = e.pointerId; }, true);

    doc.addEventListener('mousedown', (e) => {
      closeMenu();
      // several branches below preventDefault (selection, drags), which also
      // suppresses the focus change — pull focus into the deck so the keys
      // that act on a selection (arrows, ⌫, ⌘D) arrive here
      if (!doc.hasFocus()) win.focus();
      if (e.button !== 0) return; // right-click: the contextmenu handler selects
      if (e.altKey) {
        const target = selectionTarget(e.target);
        if (target) {
          e.preventDefault();
          select(target);
          beginDragPending(target, e, true);
          return;
        }
      }
      // shift-click: add/remove elements (inside the text being edited it
      // extends the text selection as usual)
      if (e.shiftKey && !(state.editing && state.editing.root.contains(e.target))) {
        const target = selectionTarget(e.target);
        if (target && !isSlide(target)) {
          e.preventDefault();
          toggleSelect(target);
          return;
        }
        e.preventDefault();
        beginMarquee(e); // shift-drag on empty space adds a band selection
        return;
      }
      // press on a selected element: drag moves it (and the rest of the
      // selection); a plain click on a lone selected text box edits it
      const hit = selectionContaining(e.target);
      if (hit) {
        e.preventDefault();
        beginDragPending(hit, e, !!mediaTarget(hit) || isMulti());
        return;
      }
      // images, svg figures, rules: select (and allow drag) on press
      const media = mediaTarget(e.target);
      if (media && !(state.editing && state.editing.root.contains(media))) {
        e.preventDefault();
        select(media);
        beginDragPending(media, e, true);
        return;
      }
      if (state.selected) deselect();
      const root = findRoot(e.target);
      if (root) {
        if (!state.editing || state.editing.root !== root) activate(root, e);
      } else if (!(state.editing && state.editing.root.contains(e.target))) {
        if (state.editing) deactivate();
        // empty space: drag a selection band
        e.preventDefault();
        beginMarquee(e);
      }
    }, true);

    doc.addEventListener('click', (e) => {
      // If the mousedown default didn't land the caret in the editing root
      // (focus race on a freshly-editable element), place it ourselves.
      if (state.editing && state.editing.root.contains(e.target)) {
        const sel = doc.getSelection();
        if (!sel.rangeCount || !state.editing.root.contains(sel.anchorNode)) {
          state.editing.root.focus({ preventScroll: true });
          placeCaretFromPoint(e.clientX, e.clientY);
        }
      }
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) post({ type: 'openExternal', url: href });
      } else if (href.startsWith('#')) {
        if (state.editing) e.preventDefault();
      } else {
        e.preventDefault();
      }
    }, true);

    doc.addEventListener('mousemove', (e) => { onDragMove(e); onMarqueeMove(e); }, true);
    doc.addEventListener('mouseup', (e) => {
      if (state.drag) endDrag(true);
      if (state.marquee) endMarquee(e);
    }, true);
    doc.addEventListener('dragstart', (e) => { if (state.drag || mediaTarget(e.target)) e.preventDefault(); }, true);

    doc.addEventListener('contextmenu', (e) => {
      // keep the native menu (copy/paste) for a text selection being edited
      if (state.editing && state.editing.root.contains(e.target)) {
        const sel = doc.getSelection();
        if (sel && !sel.isCollapsed) return;
      }
      e.preventDefault();
      if (isMulti() && selectionContaining(e.target)) {
        openMenu(state.selected, e.clientX, e.clientY);
        return;
      }
      const el = selectionTarget(e.target);
      if (el) select(el); else deselect();
      openMenu(el, e.clientX, e.clientY);
    }, true);

    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    doc.addEventListener('dragover', (e) => e.preventDefault(), true);
    doc.addEventListener('drop', (e) => {
      e.preventDefault();
      const files = imageFiles(e.dataTransfer);
      if (files.length) {
        const at = selectionTarget(doc.elementFromPoint(e.clientX, e.clientY) || e.target);
        addImages(files, at ? placementFor(at) : defaultPlacement());
        return;
      }
      // files dragged from the VS Code explorer arrive as uri-lists (hold Shift)
      const uris = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/)
        .filter((u) => /^file:/.test(u) && IMAGE_NAME.test(u));
      if (uris.length) {
        const at = selectionTarget(doc.elementFromPoint(e.clientX, e.clientY) || e.target);
        const placement = at ? placementFor(at) : defaultPlacement();
        uris.forEach((uri) => requestImage({ type: 'pickImage', uri }).then((res) => placeImage(res, placement)));
      }
    }, true);

    doc.addEventListener('mouseover', (e) => {
      if ((state.drag && state.drag.moved) || state.marquee) return;
      // with ⌥ held, preview what a select-click would grab (incl. images)
      const root = e.altKey ? selectionTarget(e.target) : findRoot(e.target);
      if (state.hoverEl && state.hoverEl !== root) {
        state.hoverEl.classList.remove('ld-hover');
        if (state.hoverEl.getAttribute('class') === '') state.hoverEl.removeAttribute('class');
        state.hoverEl = null;
      }
      if (root && root !== state.selected && (!state.editing || state.editing.root !== root)) {
        root.classList.add('ld-hover');
        state.hoverEl = root;
      }
    }, true);

    doc.addEventListener('input', () => {
      if (!state.editing) return;
      markDirty(state.editing.root);
      refreshOverlay();
    }, true);

    doc.addEventListener('paste', (e) => {
      const files = imageFiles(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        addImages(files, pastePlacement());
        return;
      }
      if (!state.editing) return;
      e.preventDefault();
      insertClipboard(e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html'), state.pasteRichOnce);
      state.pasteRichOnce = false;
    }, true);

    doc.addEventListener('selectionchange', () => {
      if (!state.editing) return;
      const sel = doc.getSelection();
      if (sel.rangeCount && state.editing.root.contains(sel.anchorNode)) {
        state.savedRange = sel.getRangeAt(0).cloneRange();
      }
      updateToolbar();
    });

    doc.addEventListener('keydown', (e) => onDeckKeyDown(e, doc), true);
    const shield = (e) => { if (state.editing) e.stopPropagation(); };
    doc.addEventListener('keypress', shield, true);
    doc.addEventListener('keyup', shield, true);
    // capture-phase so scrolls of inner containers are seen too
    doc.addEventListener('scroll', () => { updateSlideIndicator(); closeMenu(); refreshOverlay(); },
      { capture: true, passive: true });
    win.addEventListener('resize', () => refreshOverlay());
    win.addEventListener('focus', () => hideLinkPop(), true);

    // Surface broken resources instead of failing silently.
    let failedCount = 0;
    doc.addEventListener('error', (e) => {
      const t = e.target;
      if (!t || !t.tagName) return;
      if (t.tagName === 'IMG' || t.tagName === 'SOURCE' || t.tagName === 'LINK') {
        const url = t.src || t.href || '(unknown)';
        post({ type: 'log', text: 'resource failed to load: ' + url });
        failedCount++;
        if (failedCount === 1) {
          toast('Failed to load: ' + String(url).split('/').pop());
        }
      }
    }, true);
  }

  function onDeckKeyDown(e, doc) {
    const mod = e.metaKey || e.ctrlKey;

    // While editing, shield keystrokes from the deck's own scripts — decks
    // commonly bind space/arrows to slide navigation with preventDefault,
    // which would hijack typing and caret movement. Our capture-phase
    // listener runs first; stopPropagation keeps the keys ours. Default
    // actions (typing) are unaffected.
    if (state.editing) e.stopPropagation();

    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault(); flushDirty(); post({ type: 'undo' }); return;
    }
    if ((mod && e.shiftKey && e.key.toLowerCase() === 'z') || (e.ctrlKey && e.key.toLowerCase() === 'y')) {
      e.preventDefault(); flushDirty(); post({ type: 'redo' }); return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault(); flushDirty(); post({ type: 'save' }); return;
    }
    // Clipboard. The editor host runs ⌘C/⌘X/⌘V against LiveDeck's outer
    // document, never this nested deck document, so we do it ourselves.
    if (mod && !e.altKey && ['c', 'x', 'v'].includes(e.key.toLowerCase())) {
      const k = e.key.toLowerCase();
      e.preventDefault();
      e.stopPropagation();
      state.lastClipKey = Date.now();
      if (k === 'v') clipboardPaste(e.shiftKey);
      else clipboardCopy(k === 'x');
      return;
    }

    if (state.drag && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); endDrag(false); return;
    }
    if (state.marquee && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); endMarquee(null); return;
    }
    if (state.resize && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); endResize(true); return;
    }
    if (!$('#ctx-menu').hidden && e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); closeMenu(); return;
    }

    if (state.selected && !state.editing) {
      const el = state.selected;
      const arrows = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault(); e.stopPropagation(); duplicateSelection(); return;
      }
      if (e.altKey && arrows[e.key] && !isMulti()) {
        e.preventDefault(); e.stopPropagation();
        moveStep(el, e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (!mod && arrows[e.key]) {
        // PowerPoint-style nudge: 1px, Shift for 10px
        e.preventDefault(); e.stopPropagation();
        const step = e.shiftKey ? 10 : 1;
        selectedEls().forEach((x) => nudge(x, arrows[e.key][0] * step, arrows[e.key][1] * step));
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        e.stopPropagation();
        deleteSelected();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        deselect();
        return;
      }
    }

    if (!state.editing) {
      if (e.key === 'PageDown') { e.preventDefault(); gotoSlide(state.slideIdx + 1); }
      else if (e.key === 'PageUp') { e.preventDefault(); gotoSlide(state.slideIdx - 1); }
      else if (e.key === 'Home' && state.slides.length) { e.preventDefault(); gotoSlide(0); }
      else if (e.key === 'End' && state.slides.length) { e.preventDefault(); gotoSlide(state.slides.length - 1); }
      return;
    }

    const root = state.editing.root;

    // Focus drift guard: if we are in editing mode but focus escaped the root
    // (mousedown/focus race), the browser's default for this key would hit
    // the page — space scrolls to the next slide. Pull focus back and type
    // the character manually.
    if (!root.contains(doc.activeElement)) {
      root.focus({ preventScroll: true });
      restoreSelection();
      const s = doc.getSelection();
      if (!s.rangeCount || !root.contains(s.anchorNode)) {
        const r = doc.createRange();
        r.selectNodeContents(root);
        r.collapse(false);
        s.removeAllRanges();
        s.addRange(r);
      }
      if (!mod && !e.altKey && e.key.length === 1) {
        e.preventDefault();
        doc.execCommand('insertText', false, e.key);
        markDirty(root);
        return;
      }
    }

    if (mod && !e.shiftKey && ['b', 'i', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      const k = e.key.toLowerCase();
      if (k === 'u') toggleDecoration('underline', 'underline');
      else { doc.execCommand(k === 'b' ? 'bold' : 'italic'); markDirty(root); }
      updateToolbar();
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault(); showLinkPop(); return;
    }
    if (e.key === 'Escape') {
      // PowerPoint-style: Esc steps up from text editing to element
      // selection (where ⌫ deletes); Esc again dismisses.
      e.preventDefault();
      const edited = root;
      deactivate();
      if (edited.isConnected) select(edited);
      return;
    }

    const sel = doc.getSelection();
    const anchorEl = sel.anchorNode instanceof doc.defaultView.Element
      ? sel.anchorNode : sel.anchorNode && sel.anchorNode.parentElement;
    const li = anchorEl && anchorEl.closest('li');
    const inList = !!(li && root.contains(li));

    if (e.key === 'Tab') {
      e.preventDefault();
      if (inList) {
        if (e.shiftKey ? outdentLi(li) : indentLi(li)) markDirty(root);
      }
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      if (inList) {
        const empty = !li.textContent.trim() && !li.querySelector('img,svg,br+br');
        if (empty) {
          e.preventDefault();
          const parentList = li.parentElement;
          if (parentList && parentList !== outermostList(li)) {
            // empty item in a nested list: outdent one level, PowerPoint-style
            if (outdentLi(li)) markDirty(root);
          } else {
            exitListItem(li, outermostList(li));
          }
        }
        // otherwise let the browser create the next <li>; input event flushes
        return;
      }
      const tag = root.tagName;
      if (tag === 'P' || tag === 'DIV' || tag === 'SECTION' || tag === 'BLOCKQUOTE') {
        e.preventDefault();
        splitBlock(root);
      } else {
        // headings, table cells, captions: keep it one element, insert a line break
        e.preventDefault();
        doc.execCommand('insertLineBreak');
        markDirty(root);
      }
      return;
    }

    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && inList) {
      e.preventDefault();
      const sib = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling;
      if (sib && sib.tagName === 'LI') {
        if (e.key === 'ArrowUp') sib.before(li); else sib.after(li);
        markDirty(root);
      }
      return;
    }
  }

  // ----------------------------------------------------------------- slides

  function detectSlides() {
    const doc = state.doc;
    if (!doc || !doc.body) return;
    state.slides = [];
    for (const sel of state.config.slideSelectors) {
      let els = [];
      try { els = Array.from(doc.querySelectorAll(sel)); } catch (e) { continue; }
      els = els.filter((el) => el.offsetHeight > 150);
      if (els.length >= 2) { state.slides = els; break; }
    }
    updateSlideIndicator();
  }

  function updateSlideIndicator() {
    const ind = $('#slide-ind');
    if (!state.slides.length) { ind.textContent = '–'; return; }
    // viewport-relative, so it works whether the window or an inner
    // container does the scrolling
    const win = state.doc.defaultView;
    const probe = win.innerHeight / 3;
    let idx = 0;
    state.slides.forEach((el, i) => {
      if (el.getBoundingClientRect().top <= probe) idx = i;
    });
    state.slideIdx = idx;
    ind.textContent = `${idx + 1} / ${state.slides.length}`;
  }

  function gotoSlide(i) {
    if (!state.slides.length) {
      const win = state.doc && state.doc.defaultView;
      if (win) win.scrollBy({ top: (i > state.slideIdx ? 1 : -1) * win.innerHeight * 0.9, behavior: 'smooth' });
      return;
    }
    const clamped = Math.max(0, Math.min(state.slides.length - 1, i));
    state.slides[clamped].scrollIntoView({ behavior: 'smooth', block: 'start' });
    state.slideIdx = clamped;
    $('#slide-ind').textContent = `${clamped + 1} / ${state.slides.length}`;
  }

  // ------------------------------------------------------------------- zoom

  function applyZoom() {
    const f = state.frame;
    if (!f) return;
    const z = state.zoom;
    f.style.width = `${100 / z}%`;
    f.style.height = `${100 / z}%`;
    f.style.transform = `scale(${z})`;
    $('#zoom-ind').textContent = `${Math.round(z * 100)}%`;
    refreshOverlay();
    vscode.setState({ zoom: z, fitMode: state.fitMode, autoZoom: state.autoZoom });
  }

  /** Manual zoom (buttons/shortcuts): takes over from auto-fit. */
  function setZoom(z, fit) {
    state.zoom = Math.max(0.3, Math.min(3, z));
    state.fitMode = !!fit;
    state.autoZoom = false;
    applyZoom();
  }

  /**
   * Self-fitting decks compute their scale from window dimensions in a
   * load-time script, which can run before the iframe's final layout and
   * never re-run (nothing resizes afterwards). Dispatching a resize lets
   * them recompute against the real dimensions.
   */
  function nudgeDeckResize() {
    try {
      const w = state.frame && state.frame.contentWindow;
      if (w) w.dispatchEvent(new w.Event('resize'));
    } catch (err) { /* deck without a window yet */ }
  }

  /**
   * Auto zoom: shrink (never grow past 100%) so the deck's content width
   * fits the panel. Content transformed smaller by a self-fitting deck
   * doesn't count as overflow (scrollable overflow is post-transform), so
   * this leaves such decks at 100%. Active until the user touches zoom.
   */
  function autoFit() {
    if (!state.autoZoom || !state.doc || !state.doc.documentElement) return;
    const holder = $('#frame-holder');
    const d = state.doc;
    const natural = Math.max(
      d.documentElement.scrollWidth,
      d.body ? d.body.scrollWidth : 0
    );
    if (!natural || !holder.clientWidth) return;
    const zTarget = Math.max(0.3, Math.min(1, holder.clientWidth / natural));
    if (Math.abs(zTarget - state.zoom) > 0.02) {
      state.zoom = zTarget;
      applyZoom();
    }
  }

  function fitWidth() {
    const doc = state.doc;
    if (!doc || !doc.documentElement) return;
    const holder = $('#frame-holder');
    const natural = Math.max(
      doc.documentElement.scrollWidth,
      doc.body ? doc.body.scrollWidth : 0
    );
    if (natural > 0) setZoom(holder.clientWidth / natural, true);
  }

  // ---------------------------------------------------------------- toolbar

  function updateCrumb(root) {
    const crumb = $('#crumb');
    if (!root) { crumb.textContent = ''; return; }
    let slidePart = '';
    if (state.slides.length) {
      const idx = state.slides.findIndex((s) => s.contains(root));
      if (idx >= 0) slidePart = `slide ${idx + 1} · `;
    }
    const path = [];
    let el = root;
    while (el && el !== state.doc.body && path.length < 3) {
      path.unshift(el.tagName.toLowerCase());
      el = el.parentElement;
      if (path.length === 1 && el && el.classList.contains('slide')) break;
    }
    crumb.textContent = slidePart + path.join(' › ');
  }

  function updateToolbar() {
    const editing = !!state.editing;
    document.querySelectorAll('[data-needs-edit] button').forEach((b) => {
      b.disabled = !editing;
    });
    if (!editing) return;
    const doc = state.doc;
    const q = (cmd) => { try { return doc.queryCommandState(cmd); } catch (e) { return false; } };
    const set = (cmd, on) => {
      const b = document.querySelector(`[data-cmd="${cmd}"]`);
      if (b) b.classList.toggle('active', !!on);
    };
    set('bold', q('bold'));
    set('italic', q('italic'));
    set('underline', q('underline'));
    set('strike', q('strikeThrough'));
    const sel = doc.getSelection();
    const anchorEl = sel && sel.anchorNode
      ? (sel.anchorNode instanceof doc.defaultView.Element ? sel.anchorNode : sel.anchorNode.parentElement)
      : null;
    set('ul', anchorEl && anchorEl.closest('ul'));
    set('ol', anchorEl && anchorEl.closest('ol') && !anchorEl.closest('ul'));
    set('code', anchorEl && anchorEl.closest('code'));
    const align = state.editing.root.style.textAlign;
    set('alignleft', align === 'left');
    set('aligncenter', align === 'center');
    set('alignright', align === 'right');
  }

  function restoreSelection() {
    if (!state.savedRange || !state.editing) return;
    const doc = state.doc;
    const sel = doc.getSelection();
    sel.removeAllRanges();
    sel.addRange(state.savedRange);
  }

  function runCommand(cmd) {
    const doc = state.doc;
    if (!doc) return;
    if (cmd === 'undo') { flushDirty(); post({ type: 'undo' }); return; }
    if (cmd === 'redo') { flushDirty(); post({ type: 'redo' }); return; }
    if (!state.editing) return;
    const root = state.editing.root;
    restoreSelection();

    switch (cmd) {
      case 'bold': doc.execCommand('bold'); markDirty(root); break;
      case 'italic': doc.execCommand('italic'); markDirty(root); break;
      case 'underline': toggleDecoration('underline', 'underline'); break;
      case 'strike': toggleDecoration('line-through', 'strikeThrough'); break;
      case 'clear':
        doc.execCommand('removeFormat');
        doc.execCommand('unlink');
        markDirty(root);
        break;
      case 'code': toggleInlineCode(); break;
      case 'link': showLinkPop(); return;
      case 'ul': toggleList('ul'); break;
      case 'ol': toggleList('ol'); break;
      case 'indent':
      case 'outdent': {
        const sel = doc.getSelection();
        const anchorEl = sel.anchorNode instanceof doc.defaultView.Element
          ? sel.anchorNode : sel.anchorNode && sel.anchorNode.parentElement;
        const li = anchorEl && anchorEl.closest('li');
        if (li && root.contains(li)) {
          if (cmd === 'indent' ? indentLi(li) : outdentLi(li)) markDirty(root);
        }
        break;
      }
      case 'alignleft': setAlignment(root, 'left'); break;
      case 'aligncenter': setAlignment(root, 'center'); break;
      case 'alignright': setAlignment(root, 'right'); break;
    }
    updateToolbar();
  }

  /**
   * Underline / strikethrough. execCommand only adds and removes <u>/<s>
   * tags, but decks often underline via CSS (links especially), and a CSS
   * text-decoration can't be cancelled from a descendant — it has to be
   * switched off on the element that draws it. So: find that element; if it
   * is a decoration tag, let execCommand handle it, otherwise toggle
   * `text-decoration-line` on the element itself.
   */
  function toggleDecoration(line, cmd) {
    const doc = state.doc;
    const win = doc.defaultView;
    const root = state.editing.root;
    const sel = doc.getSelection();
    const n = sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    const start = n && (n.nodeType === 1 ? n : n.parentElement);
    const chain = [];
    for (let el = start; el && el !== doc.body; el = el.parentElement) chain.push(el);
    const TAGS = line === 'underline' ? ['U', 'INS'] : ['S', 'STRIKE', 'DEL'];

    // our own earlier "off" switch: turn the CSS decoration back on
    const off = chain.find((el) => el.style.textDecorationLine === 'none' || el.style.textDecoration === 'none');
    const drawer = chain.find((el) => win.getComputedStyle(el).textDecorationLine.includes(line));
    if (!drawer && off) {
      setDecorationStyle(off, root, null);
      return;
    }
    if (!drawer || (TAGS.includes(drawer.tagName) && root.contains(drawer) && drawer !== root)) {
      doc.execCommand(cmd);
      markDirty(root);
      return;
    }
    const rest = win.getComputedStyle(drawer).textDecorationLine.split(/\s+/)
      .filter((l) => l && l !== line && l !== 'none');
    setDecorationStyle(drawer, root, rest.length ? rest.join(' ') : 'none');
  }

  function setDecorationStyle(el, root, value) {
    if (value === null) {
      el.style.removeProperty('text-decoration-line');
      el.style.removeProperty('text-decoration');
    } else {
      el.style.setProperty('text-decoration-line', value);
    }
    if (el.getAttribute('style') === '') el.removeAttribute('style');
    if (el !== root && root.contains(el)) {
      markDirty(root); // a descendant: the inner edit carries its attributes
    } else if (stamped(el)) {
      // the root itself, or the text box's ancestor (e.g. a link wrapping it):
      // edit just that start tag
      commitStyle(el, { 'text-decoration-line': value, 'text-decoration': null });
    } else {
      toast('That decoration comes from markup LiveDeck can\u2019t edit here');
    }
    updateToolbar();
  }

  // clipboard -----------------------------------------------------------------

  const clipReqs = new Map();
  let clipReqSeq = 0;

  /** Host round-trip to vscode.env.clipboard — always available, text only. */
  function hostClipboard(msg) {
    return new Promise((resolve) => {
      const reqId = ++clipReqSeq;
      clipReqs.set(reqId, resolve);
      post(Object.assign({ reqId }, msg));
      setTimeout(() => { if (clipReqs.delete(reqId)) resolve(null); }, 3000);
    });
  }

  /** Text of the current deck selection, or of the selected element(s). */
  function selectionText() {
    const doc = state.doc;
    const sel = doc && doc.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) return sel.toString();
    const els = selectedEls();
    return els.length ? els.map((el) => el.innerText.trim()).join('\n\n') : '';
  }

  function clipboardCopy(cut) {
    const doc = state.doc;
    if (!doc) return;
    if (state.editing) restoreSelection();
    const text = selectionText();
    if (!text) return;
    const sel = doc.getSelection();
    const hasRange = sel && !sel.isCollapsed;
    // execCommand('copy') keeps rich HTML on the clipboard; fall back to the host
    let ok = false;
    if (hasRange) { try { ok = doc.execCommand('copy'); } catch (err) { ok = false; } }
    if (!ok) hostClipboard({ type: 'clipboardWrite', text });
    if (cut && hasRange && state.editing && state.editing.root.contains(sel.anchorNode)) {
      doc.execCommand('delete');
      markDirty(state.editing.root);
    }
  }

  async function clipboardPaste(rich) {
    const doc = state.doc;
    if (!doc) return;
    if (state.editing) restoreSelection();
    state.pasteRichOnce = rich;
    // 1. a native paste (fires our 'paste' handler, which does the work)
    try { if (doc.execCommand('paste')) return; } catch (err) { /* not allowed */ }
    state.pasteRichOnce = false;
    // 2. async clipboard API: images and rich HTML
    try {
      const items = await doc.defaultView.navigator.clipboard.read();
      for (const item of items) {
        const img = item.types.find((t) => t.startsWith('image/'));
        if (img) {
          const blob = await item.getType(img);
          addImages([new File([blob], 'image.' + img.split('/')[1].replace('svg+xml', 'svg'), { type: img })], pastePlacement());
          return;
        }
      }
      const item = items[0];
      if (item && state.editing) {
        const text = item.types.includes('text/plain') ? await (await item.getType('text/plain')).text() : '';
        const html = item.types.includes('text/html') ? await (await item.getType('text/html')).text() : '';
        if (text || html) { insertClipboard(text, html, rich); return; }
      }
    } catch (err) { /* permission denied or unsupported */ }
    // 3. the extension host's clipboard (text)
    if (!state.editing) return;
    const res = await hostClipboard({ type: 'clipboardRead' });
    if (res && res.text) insertClipboard(res.text, '', false);
  }

  /** Insert pasted content at the caret of the text being edited. Plain text
   *  by default (keeps the deck's theme); ⌘⇧V or pastePlainText:false keeps HTML. */
  function insertClipboard(text, html, rich) {
    if (!state.editing) return;
    const doc = state.doc;
    const root = state.editing.root;
    root.focus({ preventScroll: true });
    restoreSelection();
    const sel = doc.getSelection();
    if (!sel.rangeCount || !root.contains(sel.anchorNode)) {
      const r = doc.createRange();
      r.selectNodeContents(root);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    if (html && (rich || !state.config.pastePlainText)) doc.execCommand('insertHTML', false, html);
    else if (text) doc.execCommand('insertText', false, text);
    markDirty(root);
  }

  // AI this element ---------------------------------------------------------

  let aiReqSeq = 0;
  const ai = { el: null, reqId: 0 };

  function openAi(el) {
    if (!stamped(el)) return;
    closeMenu();
    ai.el = el;
    const pop = $('#ai-pop');
    $('#ai-target').textContent = '<' + el.tagName.toLowerCase() + '>';
    $('#ai-status').textContent = '';
    pop.hidden = false;
    const r = el.getBoundingClientRect();
    const p = frameToShell(r.left, r.bottom);
    pop.style.left = Math.max(8, Math.min(p.x, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    const below = p.y + 8;
    pop.style.top = (below + pop.offsetHeight < window.innerHeight
      ? below : Math.max(40, frameToShell(0, r.top).y - pop.offsetHeight - 8)) + 'px';
    const input = $('#ai-input');
    input.disabled = false;
    input.focus();
    input.select();
  }

  function closeAi() {
    if (ai.reqId) post({ type: 'aiCancel' });
    if (ai.el) ai.el.classList.remove('ld-ai-busy');
    ai.el = null;
    ai.reqId = 0;
    $('#ai-pop').hidden = true;
  }

  function runAi() {
    const el = ai.el;
    const instruction = $('#ai-input').value.trim();
    if (!el || !instruction || ai.reqId) return;
    if (!stamped(el)) { $('#ai-status').textContent = 'Element is no longer in the deck'; return; }
    if (state.editing) deactivate();
    flushDirty();
    const slide = state.slides.find((sl) => sl.contains(el));
    ai.reqId = ++aiReqSeq;
    el.classList.add('ld-ai-busy');
    $('#ai-input').disabled = true;
    $('#ai-status').textContent = 'Working… (Esc to cancel)';
    // wait for queued edits so the host sees the element as it is now
    const send = () => {
      if (state.pending || state.opQueue.length) { setTimeout(send, 50); return; }
      if (!ai.reqId) return;
      post({
        type: 'aiEdit', reqId: ai.reqId, instruction,
        id: el.getAttribute('data-ld-id'),
        slideId: slide && slide.getAttribute('data-ld-id'),
      });
    };
    send();
  }

  function onAiDone(msg) {
    if (msg.reqId !== ai.reqId) return;
    ai.reqId = 0;
    if (ai.el) ai.el.classList.remove('ld-ai-busy');
    $('#ai-input').disabled = false;
    if (msg.ok) {
      ai.el = null;
      $('#ai-pop').hidden = true;
      toast(msg.message, 3500);
    } else {
      $('#ai-status').textContent = msg.message;
      $('#ai-input').focus();
    }
  }

  // link popover ------------------------------------------------------------

  function showLinkPop() {
    const pop = $('#link-pop');
    const input = $('#link-url');
    const doc = state.doc;
    let existing = '';
    if (doc) {
      const sel = doc.getSelection();
      const anchorEl = sel && sel.anchorNode
        ? (sel.anchorNode instanceof doc.defaultView.Element ? sel.anchorNode : sel.anchorNode.parentElement)
        : null;
      const a = anchorEl && anchorEl.closest('a');
      if (a) existing = a.getAttribute('href') || '';
    }
    input.value = existing;
    pop.hidden = false;
    input.focus();
    input.select();
  }

  function hideLinkPop() { $('#link-pop').hidden = true; }

  function applyLink(remove) {
    const doc = state.doc;
    if (!doc || !state.editing) { hideLinkPop(); return; }
    const root = state.editing.root;
    root.focus({ preventScroll: true });
    restoreSelection();
    if (remove) {
      doc.execCommand('unlink');
    } else {
      const url = $('#link-url').value.trim();
      if (url) {
        const sel = doc.getSelection();
        if (sel.isCollapsed) {
          const anchorEl = sel.anchorNode instanceof doc.defaultView.Element
            ? sel.anchorNode : sel.anchorNode && sel.anchorNode.parentElement;
          const a = anchorEl && anchorEl.closest('a');
          if (a) a.setAttribute('href', url);
        } else {
          doc.execCommand('createLink', false, url);
        }
      }
    }
    hideLinkPop();
    markDirty(root);
  }

  // ------------------------------------------------------- toolbar bindings

  document.querySelectorAll('#toolbar button[data-cmd]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep deck selection
    b.addEventListener('click', () => runCommand(b.getAttribute('data-cmd')));
  });
  $('#slide-prev').addEventListener('click', () => gotoSlide(state.slideIdx - 1));
  $('#slide-next').addEventListener('click', () => gotoSlide(state.slideIdx + 1));
  $('#zoom-in').addEventListener('click', () => setZoom(state.zoom + 0.1));
  $('#zoom-out').addEventListener('click', () => setZoom(state.zoom - 0.1));
  $('#zoom-ind').addEventListener('click', () => setZoom(1));
  $('#zoom-fit').addEventListener('click', fitWidth);
  $('#btn-save').addEventListener('click', () => { flushDirty(); post({ type: 'save' }); });
  $('#btn-src').addEventListener('click', () => post({ type: 'openSource' }));
  $('#btn-browser').addEventListener('click', () => post({ type: 'openBrowser' }));
  $('#link-apply').addEventListener('click', () => applyLink(false));
  $('#link-remove').addEventListener('click', () => applyLink(true));
  $('#link-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); applyLink(false); }
    if (e.key === 'Escape') hideLinkPop();
  });
  // resize handles (shell document; pointer capture keeps the drag alive over the iframe)
  document.querySelectorAll('#sel-box .h').forEach((h) => {
    h.addEventListener('mousedown', (e) => e.preventDefault()); // keep deck focus
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      h.setPointerCapture(e.pointerId);
      startResize(h.getAttribute('data-dir'), e);
    });
    h.addEventListener('pointermove', (e) => { if (state.resize) moveResize(e); });
    h.addEventListener('pointerup', () => endResize(false));
    h.addEventListener('lostpointercapture', () => { if (state.resize) endResize(false); });
  });
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#ctx-menu')) closeMenu();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMenu(); if (state.resize) endResize(true); }
  });
  // The editor runs Copy/Cut/Paste (menu, keybinding) on this outer
  // document; redirect them to the deck.
  // (skipped when the deck already handled the keypress itself)
  const inShellInput = (e) => (e.target && e.target.closest && e.target.closest('input,textarea'))
    || Date.now() - (state.lastClipKey || 0) < 400;
  document.addEventListener('paste', (e) => {
    if (inShellInput(e) || !state.doc) return;
    const files = imageFiles(e.clipboardData);
    if (files.length) { e.preventDefault(); addImages(files, pastePlacement()); return; }
    if (!state.editing) return;
    e.preventDefault();
    insertClipboard(e.clipboardData.getData('text/plain'), e.clipboardData.getData('text/html'), false);
  });
  const shellCopy = (cut) => (e) => {
    if (inShellInput(e) || !state.doc) return;
    if (state.editing) restoreSelection();
    const sel = state.doc.getSelection();
    const text = selectionText();
    if (!text) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const div = document.createElement('div');
      div.appendChild(sel.getRangeAt(0).cloneContents());
      e.clipboardData.setData('text/html', div.innerHTML);
      if (cut && state.editing && state.editing.root.contains(sel.anchorNode)) {
        state.doc.execCommand('delete');
        markDirty(state.editing.root);
      }
    }
  };
  document.addEventListener('copy', shellCopy(false));
  document.addEventListener('cut', shellCopy(true));
  window.addEventListener('blur', closeMenu);
  $('#ai-run').addEventListener('click', runAi);
  $('#ai-close').addEventListener('click', closeAi);
  $('#ai-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runAi(); }
    if (e.key === 'Escape') { e.preventDefault(); closeAi(); }
  });

  window.addEventListener('resize', () => {
    closeMenu();
    refreshOverlay();
    if (state.fitMode) fitWidth();
    // iframe resize propagates natively; re-run auto-fit once layout settles
    else if (state.autoZoom) requestAnimationFrame(autoFit);
  });

  // --------------------------------------------------------------- messages

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg && msg.type) {
      case 'init':
        state.mapVersion = msg.mapVersion;
        if (msg.config) state.config = msg.config;
        render(msg.html);
        updateToolbar();
        break;
      case 'ack':
        onAck(msg);
        break;
      case 'structAck':
        onStructAck(msg);
        break;
      case 'imageReady': {
        const resolve = imageReqs.get(msg.reqId);
        imageReqs.delete(msg.reqId);
        if (resolve) resolve(msg);
        break;
      }
      case 'aiDone':
        onAiDone(msg);
        break;
      case 'clipboardText': {
        const resolve = clipReqs.get(msg.reqId);
        clipReqs.delete(msg.reqId);
        if (resolve) resolve(msg);
        break;
      }
      case 'patch': {
        // Localized external change (undo/redo, a scoped edit by an agent):
        // swap one element's content in place instead of re-rendering the
        // whole deck, so deck scripts — and their state, like the current
        // slide — are untouched.
        const doc = state.doc;
        const el = doc && doc.querySelector('[data-ld-id="' + msg.oldId + '"]');
        if (!el) { requestReload('patch target missing'); break; }
        if (state.editing) {
          const r = state.editing.root;
          if (r === el || el.contains(r) || r.contains(el)) deactivate(false);
        }
        if (state.selected && (state.selected === el || el.contains(state.selected) || state.selected.contains(el))) {
          deselect();
        }
        el.innerHTML = msg.html;
        const els = [el, ...el.querySelectorAll('*')];
        if (els.length !== msg.ids.length) { requestReload('patch stamp mismatch'); break; }
        els.forEach((n, i) => n.setAttribute('data-ld-id', msg.ids[i]));
        el.__ldLastSent = undefined;
        state.mapVersion = msg.mapVersion;
        refreshOverlay();
        break;
      }
      case 'dirty':
        $('#dirty-dot').hidden = !msg.dirty;
        break;
      case 'toast':
        toast(msg.text);
        break;
    }
  });

  const persisted = vscode.getState();
  if (persisted && persisted.autoZoom === false && persisted.zoom) {
    // the user had explicitly chosen a zoom — keep honoring it
    state.zoom = persisted.zoom;
    state.fitMode = !!persisted.fitMode;
    state.autoZoom = false;
  }

  updateToolbar();
  post({ type: 'ready' });
})();
