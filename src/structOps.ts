/**
 * Structural element operations — duplicate, reorder, reposition, insert —
 * computed purely from the source text.
 *
 * Unlike `inner`/`outer` edits, these never serialize the live DOM: the new
 * text is assembled from slices of the original source (plus, for inserts,
 * markup we generate). That matters for elements a deck script has drawn into
 * (charts, rendered math): their runtime DOM never reaches the file.
 *
 * Each op is planned as ONE contiguous source replacement plus the DFS region
 * of the old map it affects. After the edit, `applyStructPlan` re-parses,
 * verifies the region against what the op predicts (tag + depth of every
 * element, via `origin`), and returns old→new id pairs so the webview can
 * re-stamp the DOM it already rearranged — no DFS re-count of live DOM, so
 * script-generated (unstamped) descendants can't cause a mismatch.
 */
import {
  DeckMap,
  ElementInfo,
  buildDeck,
  indentOf,
  rebuildAfterEdit,
} from './sourceMap';

export type StructOp =
  | { op: 'duplicate'; id: string }
  | { op: 'move'; id: string; targetId: string; before: boolean }
  | { op: 'style'; id: string; props: Record<string, string | null> }
  | { op: 'insert'; anchorId: string; where: 'after' | 'append'; html: string };

export interface StructPlan {
  /** source replacement */
  start: number;
  end: number;
  text: string;
  /** DFS region of the old map that the replacement covers */
  region: { start: number; end: number };
  /** per new-region element (DFS order): old-map index it derives from, or -1 if new */
  origin: number[];
  /** depth new (origin -1) top-level elements must have */
  insertDepth?: number;
  /** style op: the element's new style attribute value (null = removed) */
  styleAttr?: string | null;
}

export interface StructResult {
  next: DeckMap;
  freshIds: string[];
  /** [oldId, newId] for every region element derived from an old element */
  pairs: [string, string][];
}

// ------------------------------------------------------------ tree helpers

export function parentOf(map: DeckMap, entry: ElementInfo): ElementInfo | null {
  if (entry.depth === 0) return null;
  for (let i = entry.index - 1; i >= 0; i--) {
    if (map.order[i].depth === entry.depth - 1) return map.order[i];
  }
  return null;
}

/** Element children of `parent` (null = body) in source order. */
export function childrenOf(map: DeckMap, parent: ElementInfo | null): ElementInfo[] {
  const out: ElementInfo[] = [];
  const end = parent ? parent.index + parent.subtree + 1 : map.order.length;
  for (let i = parent ? parent.index + 1 : 0; i < end; ) {
    out.push(map.order[i]);
    i += map.order[i].subtree + 1;
  }
  return out;
}

function subtreeIndices(e: ElementInfo): number[] {
  return Array.from({ length: e.subtree + 1 }, (_, k) => e.index + k);
}

/** True when nothing but indentation precedes `offset` on its line. */
function startsOwnLine(source: string, offset: number): boolean {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*$/.test(source.slice(lineStart, offset));
}

/** Separator that puts an inserted sibling on its own line when `e` is on one. */
function siblingJoiner(source: string, e: ElementInfo): string {
  return startsOwnLine(source, e.outerStart) ? '\n' + indentOf(source, e.outerStart) : '';
}

// ------------------------------------------------- start-tag attribute edits

interface AttrSpan {
  name: string;
  /** start of the attribute name (preceded by whitespace in valid markup) */
  start: number;
  /** end of the whole attribute (after the closing quote) */
  end: number;
  value: string | null;
  quote: '"' | "'" | '';
}

/** Tokenize the attributes of an HTML start tag (`<tag a="1" b>`). */
export function attrSpans(tag: string): AttrSpan[] {
  const out: AttrSpan[] = [];
  let i = 1;
  while (i < tag.length && !/[\s/>]/.test(tag[i])) i++; // tag name
  for (;;) {
    while (i < tag.length && /[\s/]/.test(tag[i])) i++;
    if (i >= tag.length || tag[i] === '>') break;
    const start = i;
    while (i < tag.length && !/[\s/>=]/.test(tag[i])) i++;
    if (i === start) i++; // stray '=' — skip it rather than loop
    const name = tag.slice(start, i).toLowerCase();
    let j = i;
    while (j < tag.length && /\s/.test(tag[j])) j++;
    if (tag[j] !== '=') {
      out.push({ name, start, end: i, value: null, quote: '' });
      continue;
    }
    j++;
    while (j < tag.length && /\s/.test(tag[j])) j++;
    const q = tag[j];
    if (q === '"' || q === "'") {
      const close = tag.indexOf(q, j + 1);
      const valEnd = close === -1 ? tag.length - 1 : close;
      out.push({ name, start, end: valEnd + 1, value: tag.slice(j + 1, valEnd), quote: q });
      i = valEnd + 1;
    } else {
      let k = j;
      while (k < tag.length && !/[\s>]/.test(tag[k])) k++;
      out.push({ name, start, end: k, value: tag.slice(j, k), quote: '' });
      i = k;
    }
  }
  return out;
}

/** Split CSS declarations on top-level `;` (ignores `;` inside quotes/parens). */
function splitDecls(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let last = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(css.slice(last, i));
      last = i + 1;
    }
  }
  out.push(css.slice(last));
  return out;
}

/** Set (string) or remove (null) declarations in an inline style string.
 *  Untouched declarations keep their exact text. */
export function setStyleDecls(style: string, props: Record<string, string | null>): string {
  const pending = new Map(Object.entries(props).map(([k, v]) => [k.toLowerCase(), v]));
  const segs = splitDecls(style);
  const trailingSemi = segs.length > 1 && !segs[segs.length - 1].trim();
  const kept: string[] = [];
  for (const seg of segs) {
    if (!seg.trim()) continue;
    const colon = seg.indexOf(':');
    const name = (colon === -1 ? seg : seg.slice(0, colon)).trim().toLowerCase();
    if (pending.has(name)) {
      const v = pending.get(name);
      pending.delete(name);
      if (v !== null && v !== undefined) {
        kept.push(seg.slice(0, seg.length - seg.trimStart().length) + `${name}: ${v}`);
      }
      continue;
    }
    kept.push(seg);
  }
  let out = kept.join(';');
  for (const [name, v] of pending) {
    if (v === null || v === undefined) continue;
    out = out.trim() ? out.replace(/\s+$/, '') + `; ${name}: ${v}` : `${name}: ${v}`;
  }
  if (out.trim() && trailingSemi) out += ';';
  return out.trim() ? out : '';
}

/** Rewrite one start tag's `style` attribute. Returns the new tag text and
 *  the new attribute value (null when the attribute ends up removed). */
export function setStyleInStartTag(
  tag: string,
  props: Record<string, string | null>
): { tag: string; style: string | null } {
  const attr = attrSpans(tag).find((a) => a.name === 'style');
  const next = setStyleDecls(attr?.value ?? '', props);
  if (attr) {
    if (!next) {
      let s = attr.start;
      while (s > 0 && /\s/.test(tag[s - 1])) s--;
      return { tag: tag.slice(0, s) + tag.slice(attr.end), style: null };
    }
    const q = attr.quote === "'" && !next.includes("'") ? "'" : '"';
    const val = q === '"' ? next.replace(/"/g, '&quot;') : next;
    return { tag: tag.slice(0, attr.start) + `style=${q}${val}${q}` + tag.slice(attr.end), style: next };
  }
  if (!next) return { tag, style: null };
  // insert before `>` / `/>`, after the last attribute
  let p = tag.length - 1;
  if (tag[p - 1] === '/') p--;
  while (p > 0 && /\s/.test(tag[p - 1])) p--;
  return { tag: tag.slice(0, p) + ` style="${next.replace(/"/g, '&quot;')}"` + tag.slice(p), style: next };
}

// ----------------------------------------------------------------- planning

function located(e: ElementInfo | undefined): e is ElementInfo {
  return !!e && e.outerStart >= 0 && e.startTagEnd >= 0;
}

export function planStructOp(map: DeckMap, op: StructOp): StructPlan | { error: string } {
  const src = map.source;

  if (op.op === 'duplicate') {
    const e = map.byId.get(op.id);
    if (!located(e)) return { error: 'element has no source location' };
    const at = e.index + e.subtree + 1;
    return {
      start: e.outerEnd,
      end: e.outerEnd,
      text: siblingJoiner(src, e) + src.slice(e.outerStart, e.outerEnd),
      region: { start: at, end: at },
      origin: subtreeIndices(e),
    };
  }

  if (op.op === 'move') {
    const e = map.byId.get(op.id);
    const t = map.byId.get(op.targetId);
    if (!located(e) || !located(t)) return { error: 'element has no source location' };
    if (e === t) return { error: 'cannot move an element relative to itself' };
    const sibs = childrenOf(map, parentOf(map, e));
    const i = sibs.indexOf(e);
    const j = sibs.indexOf(t);
    if (i < 0 || j < 0) return { error: 'elements are not siblings' };
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const run = sibs.slice(lo, hi + 1);
    if (!run.every(located)) return { error: 'a sibling has no source location' };
    // new order of the run
    const rest = run.filter((s) => s !== e);
    const ti = rest.indexOf(t);
    rest.splice(op.before ? ti : ti + 1, 0, e);
    if (rest.every((s, k) => s === run[k])) return { error: 'already in place' };
    // separators (whitespace, comments, text) stay where they are
    const seps = run.slice(0, -1).map((s, k) => src.slice(s.outerEnd, run[k + 1].outerStart));
    let text = '';
    rest.forEach((s, k) => {
      text += src.slice(s.outerStart, s.outerEnd);
      if (k < seps.length) text += seps[k];
    });
    return {
      start: run[0].outerStart,
      end: run[run.length - 1].outerEnd,
      text,
      region: { start: run[0].index, end: run[run.length - 1].index + run[run.length - 1].subtree + 1 },
      origin: rest.flatMap(subtreeIndices),
    };
  }

  if (op.op === 'style') {
    const e = map.byId.get(op.id);
    if (!located(e)) return { error: 'element has no source location' };
    const startTag = src.slice(e.outerStart, e.startTagEnd);
    const r = setStyleInStartTag(startTag, op.props);
    if (r.tag === startTag) return { error: 'no change' };
    return {
      start: e.outerStart,
      end: e.startTagEnd,
      text: r.tag,
      region: { start: e.index, end: e.index + 1 }, // descendants keep their ids
      origin: [e.index],
      styleAttr: r.style,
    };
  }

  // insert
  const a = map.byId.get(op.anchorId);
  if (!located(a)) return { error: 'anchor has no source location' };
  const at = a.index + a.subtree + 1;
  if (op.where === 'after') {
    return {
      start: a.outerEnd,
      end: a.outerEnd,
      text: siblingJoiner(src, a) + op.html,
      region: { start: at, end: at },
      origin: [],
      insertDepth: a.depth,
    };
  }
  const kids = childrenOf(map, a);
  const last = kids[kids.length - 1];
  if (last) {
    if (!located(last)) return { error: 'last child has no source location' };
    return {
      start: last.outerEnd,
      end: last.outerEnd,
      text: siblingJoiner(src, last) + op.html,
      region: { start: at, end: at },
      origin: [],
      insertDepth: a.depth + 1,
    };
  }
  if (a.innerStart < 0) return { error: 'container has no end tag' };
  const inner = src.slice(a.innerStart, a.innerEnd);
  const ind = indentOf(src, a.outerStart);
  const text = startsOwnLine(src, a.outerStart) && !inner.trim()
    ? `\n${ind}  ${op.html}\n${ind}`
    : op.html;
  return {
    start: a.innerStart,
    end: a.innerEnd,
    text: inner.trim() ? inner + text : text,
    region: { start: at, end: at },
    origin: [],
    insertDepth: a.depth + 1,
  };
}

/** The source text a plan produces. */
export function planSource(map: DeckMap, plan: StructPlan): string {
  return map.source.slice(0, plan.start) + plan.text + map.source.slice(plan.end);
}

/**
 * Rebuild the map after `newSource` (normally `planSource(map, plan)`) and
 * verify the region matches the plan. Null → the caller must fully re-render.
 */
export function applyStructPlan(
  map: DeckMap,
  plan: StructPlan,
  newSource: string,
  opts: { baseHref?: string } = {}
): StructResult | null {
  const rebuilt = rebuildAfterEdit(map, newSource, plan.region, opts);
  if (!rebuilt) return null;
  const { next, freshIds } = rebuilt;
  const base = plan.region.start;
  if (plan.origin.length) {
    if (freshIds.length !== plan.origin.length) return null;
    for (let k = 0; k < plan.origin.length; k++) {
      const o = map.order[plan.origin[k]];
      const n = next.order[base + k];
      if (!o || !n || o.tag !== n.tag || o.depth !== n.depth) return null;
    }
  } else {
    if (freshIds.length === 0) return null;
    if (next.order[base].depth !== plan.insertDepth) return null;
    // every inserted element must sit inside the inserted top-level ones
    let k = 0;
    while (k < freshIds.length) {
      const top = next.order[base + k];
      if (top.depth !== plan.insertDepth) return null;
      k += top.subtree + 1;
    }
    if (k !== freshIds.length) return null;
  }
  const pairs: [string, string][] = [];
  plan.origin.forEach((oi, k) => pairs.push([map.order[oi].id, freshIds[k]]));
  return { next, freshIds, pairs };
}

/**
 * Instrument a standalone fragment (newly inserted markup) with the ids the
 * rebuild assigned. Fresh ids are sequential, so building the fragment alone
 * from the first one yields the same ids in the same DFS order.
 */
export function instrumentFragment(html: string, freshIds: string[]): string {
  const first = Number(freshIds[0]?.slice(3));
  const pre = '<html><body>';
  const post = '</body></html>';
  const m = buildDeck(pre + html + post, { startId: first });
  if (m.order.length !== freshIds.length) throw new Error('fragment shape mismatch');
  return m.instrumented.slice(pre.length, m.instrumented.length - post.length);
}
