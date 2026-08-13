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
    savedRange: null,
    pasteRichOnce: false,
    hoverEl: null,
    firstRender: true,
  };

  // ---------------------------------------------------------------- helpers

  const TEXT_BLOCKS = new Set([
    'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'FIGCAPTION',
    'PRE', 'TD', 'TH', 'DT', 'DD', 'CAPTION', 'SUMMARY',
  ]);
  const LIST_TAGS = new Set(['UL', 'OL']);
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
      node.classList.remove('ld-editing', 'ld-hover');
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

  function caretToStart(el) {
    const doc = state.doc;
    const sel = doc.getSelection();
    const r = doc.createRange();
    r.setStart(el, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  // Structural op helpers ---------------------------------------------------

  function copyAttrs(from, to) {
    for (const a of Array.from(from.attributes)) {
      if (a.name === 'data-ld-id' || a.name === 'contenteditable' || a.name === 'spellcheck') continue;
      if (a.name === 'class') {
        const cls = a.value.split(/\s+/).filter((c) => c && c !== 'ld-editing' && c !== 'ld-hover');
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
    state.dirty.clear();
    state.opQueue = [];
    state.pending = null;
    state.hoverEl = null;
    state.slides = [];
    state.doc = null;

    const frame = document.createElement('iframe');
    frame.id = 'deck-frame';
    frame.setAttribute('title', 'deck');
    holder.replaceChildren(frame);
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
      setTimeout(() => { if (state.frame === frame) restoreScrollState(scroll); }, 150);
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
      .ld-editing { outline: 2px solid rgba(64,156,255,.9) !important; outline-offset: 2px; }
      .ld-editing:focus { outline: 2px solid rgba(64,156,255,.9) !important; }
      [contenteditable="true"]:empty::before { content: '\\200b'; }
    `;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function wire(doc) {
    injectEditingStyle(doc);
    const win = doc.defaultView;

    doc.addEventListener('mousedown', (e) => {
      const root = findRoot(e.target);
      if (root) {
        if (!state.editing || state.editing.root !== root) activate(root, e);
      } else if (state.editing && !state.editing.root.contains(e.target)) {
        deactivate();
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

    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    doc.addEventListener('dragover', (e) => e.preventDefault(), true);
    doc.addEventListener('drop', (e) => e.preventDefault(), true);

    doc.addEventListener('mouseover', (e) => {
      const root = findRoot(e.target);
      if (state.hoverEl && state.hoverEl !== root) {
        state.hoverEl.classList.remove('ld-hover');
        if (state.hoverEl.getAttribute('class') === '') state.hoverEl.removeAttribute('class');
        state.hoverEl = null;
      }
      if (root && (!state.editing || state.editing.root !== root)) {
        root.classList.add('ld-hover');
        state.hoverEl = root;
      }
    }, true);

    doc.addEventListener('input', () => {
      if (!state.editing) return;
      markDirty(state.editing.root);
    }, true);

    doc.addEventListener('paste', (e) => {
      if (!state.editing) return;
      if (state.pasteRichOnce) { state.pasteRichOnce = false; return; }
      if (!state.config.pastePlainText) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      if (text) doc.execCommand('insertText', false, text);
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
    doc.addEventListener('scroll', updateSlideIndicator, { capture: true, passive: true });
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
    if (mod && e.shiftKey && e.key.toLowerCase() === 'v') {
      state.pasteRichOnce = true; return; // let the paste event through untouched
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
      doc.execCommand({ b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()]);
      markDirty(root);
      return;
    }
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault(); showLinkPop(); return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); deactivate(); return;
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
    vscode.setState({ zoom: z });
  }

  function setZoom(z, fit) {
    state.zoom = Math.max(0.3, Math.min(3, z));
    state.fitMode = !!fit;
    applyZoom();
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
      case 'underline': doc.execCommand('underline'); markDirty(root); break;
      case 'strike': doc.execCommand('strikeThrough'); markDirty(root); break;
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
  window.addEventListener('resize', () => { if (state.fitMode) fitWidth(); });

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
        el.innerHTML = msg.html;
        const els = [el, ...el.querySelectorAll('*')];
        if (els.length !== msg.ids.length) { requestReload('patch stamp mismatch'); break; }
        els.forEach((n, i) => n.setAttribute('data-ld-id', msg.ids[i]));
        el.__ldLastSent = undefined;
        state.mapVersion = msg.mapVersion;
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
  if (persisted && persisted.zoom) state.zoom = persisted.zoom;

  updateToolbar();
  post({ type: 'ready' });
})();
