/**
 * Source mapping between an HTML deck file and the DOM rendered in the webview.
 *
 * The model:
 *  - The HTML file is the single source of truth.
 *  - We parse it with parse5 (the same spec-compliant algorithm browsers use),
 *    so the element tree here matches the iframe DOM one-to-one — including
 *    parser-implied elements like <tbody> that have no source location.
 *  - Every element in <body> gets an opaque id (`ld-N`). Elements with a real
 *    start tag get the id stamped into the served markup as `data-ld-id`; the
 *    user's file NEVER contains these ids.
 *  - An edit replaces exactly one element's inner or outer source range. After
 *    applying it we re-parse and re-attach ids: elements before/after the
 *    edited region keep their ids (verified by tag+depth), the region gets
 *    fresh ids which are sent back to the webview for re-stamping.
 *
 * Ids are monotonically increasing across rebuilds within a session so a stale
 * id can never accidentally address a different element.
 */
import { parse } from 'parse5';

export interface ElementInfo {
  id: string;
  tag: string;
  depth: number;
  /** index in DFS pre-order over body descendants */
  index: number;
  /** number of descendant elements (contiguous after `index` in `order`) */
  subtree: number;
  outerStart: number;
  outerEnd: number;
  /** -1 when the element has no explicit end tag (void / implied close) */
  innerStart: number;
  innerEnd: number;
  /** end offset of the start tag in source; -1 if the tag is parser-implied */
  startTagEnd: number;
  selfClosing: boolean;
}

export interface DeckMap {
  version: number;
  source: string;
  /** markup to render: source + data-ld-id stamps + optional <base> */
  instrumented: string;
  order: ElementInfo[];
  byId: Map<string, ElementInfo>;
  /** next fresh id number (monotonic across rebuilds) */
  nextId: number;
}

interface Analysis {
  order: ElementInfo[]; // ids not yet assigned
  hasBase: boolean;
  baseInsertPos: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type P5Node = any;

function analyze(source: string): Analysis {
  const doc: P5Node = parse(source, { sourceCodeLocationInfo: true });

  let htmlNode: P5Node, doctypeEnd = 0;
  for (const n of doc.childNodes ?? []) {
    if (n.nodeName === '#documentType' && n.sourceCodeLocation) {
      doctypeEnd = n.sourceCodeLocation.endOffset;
    }
    if (n.tagName === 'html') htmlNode = n;
  }
  const headNode = htmlNode?.childNodes?.find((c: P5Node) => c.tagName === 'head');
  const bodyNode = htmlNode?.childNodes?.find((c: P5Node) => c.tagName === 'body');

  const order: ElementInfo[] = [];
  const visit = (node: P5Node, depth: number) => {
    for (const c of node.childNodes ?? []) {
      if (!c.tagName) continue;
      const i = order.length;
      const loc = c.sourceCodeLocation ?? null;
      const st = loc?.startTag ?? null;
      const et = loc?.endTag ?? null;
      const info: ElementInfo = {
        id: '',
        tag: String(c.tagName).toLowerCase(),
        depth,
        index: i,
        subtree: 0,
        outerStart: loc ? loc.startOffset : -1,
        outerEnd: loc ? loc.endOffset : -1,
        innerStart: st && et ? st.endOffset : -1,
        innerEnd: st && et ? et.startOffset : -1,
        startTagEnd: st ? st.endOffset : -1,
        selfClosing: st ? source.slice(st.endOffset - 2, st.endOffset) === '/>' : false,
      };
      order.push(info);
      // Do not descend into <template> — matches DOM querySelectorAll('*').
      if (c.tagName !== 'template') visit(c, depth + 1);
      info.subtree = order.length - i - 1;
    }
  };
  if (bodyNode) visit(bodyNode, 0);

  const hasBase =
    !!headNode?.childNodes?.some((c: P5Node) => c.tagName === 'base');
  const baseInsertPos =
    headNode?.sourceCodeLocation?.startTag?.endOffset ??
    htmlNode?.sourceCodeLocation?.startTag?.endOffset ??
    doctypeEnd;

  return { order, hasBase, baseInsertPos };
}

function attrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function finalize(
  a: Analysis,
  source: string,
  ids: string[],
  baseHref: string,
  version: number,
  nextId: number
): DeckMap {
  const byId = new Map<string, ElementInfo>();
  const splices: { pos: number; text: string }[] = [];

  a.order.forEach((info, i) => {
    info.id = ids[i];
    byId.set(info.id, info);
    if (info.startTagEnd >= 0) {
      const pos = info.selfClosing ? info.startTagEnd - 2 : info.startTagEnd - 1;
      splices.push({ pos, text: ` data-ld-id="${info.id}"` });
    }
  });

  if (baseHref && !a.hasBase) {
    splices.push({ pos: a.baseInsertPos, text: `<base href="${attrEscape(baseHref)}">` });
  }

  splices.sort((x, y) => y.pos - x.pos);
  let instrumented = source;
  for (const s of splices) {
    instrumented = instrumented.slice(0, s.pos) + s.text + instrumented.slice(s.pos);
  }

  return { version, source, instrumented, order: a.order, byId, nextId };
}

export function buildDeck(
  source: string,
  opts: { baseHref?: string; version?: number; startId?: number } = {}
): DeckMap {
  const a = analyze(source);
  const start = opts.startId ?? 1;
  const ids = a.order.map((_, i) => `ld-${start + i}`);
  return finalize(a, source, ids, opts.baseHref ?? '', opts.version ?? 1, start + a.order.length);
}

/** Source range covered by an element and its whole subtree, as order indices. */
export function regionOf(map: DeckMap, entry: ElementInfo): { start: number; end: number } {
  return { start: entry.index, end: entry.index + 1 + entry.subtree };
}

/**
 * Re-parse `newSource` after an edit confined to the given region of `prev`.
 * Elements outside the region must line up (tag + depth) with the old map and
 * keep their ids; region elements get fresh ids (returned in DFS order for the
 * webview to re-stamp). Returns null if the document changed in a way that
 * breaks the alignment — the caller should fall back to a full re-render.
 */
export function rebuildAfterEdit(
  prev: DeckMap,
  newSource: string,
  region: { start: number; end: number },
  opts: { baseHref?: string } = {}
): { next: DeckMap; freshIds: string[] } | null {
  const a = analyze(newSource);
  const prefixLen = region.start;
  const suffixLen = prev.order.length - region.end;
  if (prefixLen < 0 || suffixLen < 0) return null;
  if (a.order.length < prefixLen + suffixLen) return null;

  for (let i = 0; i < prefixLen; i++) {
    const o = prev.order[i], n = a.order[i];
    if (o.tag !== n.tag || o.depth !== n.depth) return null;
  }
  for (let k = 0; k < suffixLen; k++) {
    const o = prev.order[prev.order.length - 1 - k];
    const n = a.order[a.order.length - 1 - k];
    if (o.tag !== n.tag || o.depth !== n.depth) return null;
  }

  const middleLen = a.order.length - prefixLen - suffixLen;
  const ids: string[] = new Array(a.order.length);
  let nextId = prev.nextId;
  const freshIds: string[] = [];

  for (let i = 0; i < prefixLen; i++) ids[i] = prev.order[i].id;
  for (let m = 0; m < middleLen; m++) {
    const id = `ld-${nextId++}`;
    ids[prefixLen + m] = id;
    freshIds.push(id);
  }
  for (let k = 0; k < suffixLen; k++) {
    ids[a.order.length - 1 - k] = prev.order[prev.order.length - 1 - k].id;
  }

  const next = finalize(a, newSource, ids, opts.baseHref ?? '', prev.version + 1, nextId);
  return { next, freshIds };
}

/**
 * Deepest body element whose inner source range contains [lo, hi) — i.e. the
 * smallest element an external text change is confined to. Null when the
 * change touches structure outside any single element (head, top level, tag
 * boundaries), in which case only a full re-render is safe.
 */
export function deepestContaining(map: DeckMap, lo: number, hi: number): ElementInfo | null {
  let best: ElementInfo | null = null;
  for (const el of map.order) {
    if (el.innerStart >= 0 && el.innerStart <= lo && hi <= el.innerEnd) {
      if (!best || el.depth > best.depth) best = el;
    }
  }
  return best;
}

/**
 * Range to remove when deleting an element outright: if the element sits on
 * its own line(s), consume the leading indentation and the trailing newline
 * too, so the deletion doesn't leave a blank line behind.
 */
export function deletionRange(
  source: string,
  outerStart: number,
  outerEnd: number
): { start: number; end: number } {
  const lineStart = source.lastIndexOf('\n', outerStart - 1) + 1;
  if (/^[ \t]*$/.test(source.slice(lineStart, outerStart))) {
    const nl = source.indexOf('\n', outerEnd);
    const tail = nl === -1 ? source.slice(outerEnd) : source.slice(outerEnd, nl);
    if (/^[ \t\r]*$/.test(tail)) {
      return { start: lineStart, end: nl === -1 ? source.length : nl + 1 };
    }
  }
  return { start: outerStart, end: outerEnd };
}

/** Leading whitespace of the line an element starts on (used to indent multi-part writes). */
export function indentOf(source: string, offset: number): string {
  let lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const lead = source.slice(lineStart, offset);
  return /^[ \t]*$/.test(lead) ? lead : '';
}
