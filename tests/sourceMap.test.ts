import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, serialize } from 'parse5';
import {
  buildDeck,
  rebuildAfterEdit,
  regionOf,
  indentOf,
  deepestContaining,
  deletionRange,
  DeckMap,
  ElementInfo,
} from '../src/sourceMap';

const DECK = `<!DOCTYPE html>
<html>
<head>
<title>t</title>
</head>
<body>
<div class="slide">
  <h1>Hello</h1>
  <ul>
    <li>One</li>
    <li>Two <strong>bold</strong></li>
  </ul>
</div>
<table><tr><td>X</td></tr></table>
</body>
</html>`;

function entryByTag(map: DeckMap, tag: string, nth = 0): ElementInfo {
  const found = map.order.filter((e) => e.tag === tag);
  assert.ok(found.length > nth, `no <${tag}> #${nth}`);
  return found[nth];
}

function applyInner(map: DeckMap, entry: ElementInfo, html: string): string {
  return map.source.slice(0, entry.innerStart) + html + map.source.slice(entry.innerEnd);
}

function applyOuter(map: DeckMap, entry: ElementInfo, text: string): string {
  return map.source.slice(0, entry.outerStart) + text + map.source.slice(entry.outerEnd);
}

test('build: order matches browser DOM including implied tbody', () => {
  const map = buildDeck(DECK, { baseHref: 'https://x/' });
  assert.deepEqual(
    map.order.map((e) => e.tag),
    ['div', 'h1', 'ul', 'li', 'li', 'strong', 'table', 'tbody', 'tr', 'td']
  );
  const tbody = entryByTag(map, 'tbody');
  assert.equal(tbody.startTagEnd, -1); // parser-implied, no source location
  assert.equal(tbody.subtree, 2); // tr, td
});

test('build: inner ranges slice to the exact content', () => {
  const map = buildDeck(DECK);
  const h1 = entryByTag(map, 'h1');
  assert.equal(map.source.slice(h1.innerStart, h1.innerEnd), 'Hello');
  const li2 = entryByTag(map, 'li', 1);
  assert.equal(map.source.slice(li2.innerStart, li2.innerEnd), 'Two <strong>bold</strong>');
  const div = entryByTag(map, 'div');
  assert.equal(div.subtree, 5); // h1, ul, li, li, strong
});

test('build: instrumentation stamps ids and injects base without touching source', () => {
  const map = buildDeck(DECK, { baseHref: 'https://res/deck/' });
  assert.equal(map.source, DECK);
  const h1 = entryByTag(map, 'h1');
  assert.ok(map.instrumented.includes(`<h1 data-ld-id="${h1.id}">Hello</h1>`));
  assert.ok(map.instrumented.includes('<head><base href="https://res/deck/">'));
  // ids count = elements with real start tags (all except tbody)
  const stamped = map.instrumented.match(/data-ld-id="/g) ?? [];
  assert.equal(stamped.length, map.order.length - 1);
});

test('build: existing <base> is respected', () => {
  const src = '<html><head><base href="./x/"></head><body><p>a</p></body></html>';
  const map = buildDeck(src, { baseHref: 'https://res/' });
  assert.ok(!map.instrumented.includes('https://res/'));
});

test('build: self-closing svg child is instrumented without corruption', () => {
  const src = '<html><body><svg viewBox="0 0 1 1"><path d="M0 0"/></svg></body></html>';
  const map = buildDeck(src);
  const path = entryByTag(map, 'path');
  assert.ok(map.instrumented.includes(`<path d="M0 0" data-ld-id="${path.id}"/>`));
});

test('inner edit: fresh ids for region, stable ids outside', () => {
  const map = buildDeck(DECK);
  const h1 = entryByTag(map, 'h1');
  const ulIdBefore = entryByTag(map, 'ul').id;
  const divIdBefore = entryByTag(map, 'div').id;

  const newSource = applyInner(map, h1, 'Hi <em>there</em>');
  const res = rebuildAfterEdit(map, newSource, regionOf(map, h1));
  assert.ok(res, 'rebuild should succeed');
  const { next, freshIds } = res!;

  assert.equal(freshIds.length, 2); // h1 + em
  assert.equal(entryByTag(next, 'h1').id, freshIds[0]);
  assert.equal(entryByTag(next, 'em').id, freshIds[1]);
  assert.equal(entryByTag(next, 'ul').id, ulIdBefore);
  assert.equal(entryByTag(next, 'div').id, divIdBefore);
  assert.equal(entryByTag(next, 'h1').tag, 'h1');
  assert.equal(next.source.slice(entryByTag(next, 'em').innerStart, entryByTag(next, 'em').innerEnd), 'there');
  // no id collisions with the previous generation
  const oldIds = new Set(map.order.map((e) => e.id));
  for (const id of freshIds) assert.ok(!oldIds.has(id));
});

test('inner edit: adding a list item grows the region', () => {
  const map = buildDeck(DECK);
  const ul = entryByTag(map, 'ul');
  const inner = map.source.slice(ul.innerStart, ul.innerEnd) + '<li>Three</li>\n  ';
  const res = rebuildAfterEdit(map, applyInner(map, ul, inner), regionOf(map, ul));
  assert.ok(res);
  // region was ul+li+li+strong (4); now ul+li+li+strong+li (5)
  assert.equal(res!.freshIds.length, 5);
  assert.equal(entryByTag(res!.next, 'li', 2).tag, 'li');
  assert.equal(entryByTag(res!.next, 'table').id, entryByTag(map, 'table').id);
});

test('outer edit: splitting one element into two', () => {
  const map = buildDeck(DECK);
  const h1 = entryByTag(map, 'h1');
  const res = rebuildAfterEdit(
    map,
    applyOuter(map, h1, '<h1>Hel</h1>\n  <p>lo</p>'),
    regionOf(map, h1)
  );
  assert.ok(res);
  assert.equal(res!.freshIds.length, 2);
  const tags = res!.next.order.map((e) => e.tag);
  assert.deepEqual(tags.slice(0, 4), ['div', 'h1', 'p', 'ul']);
  assert.equal(entryByTag(res!.next, 'ul').id, entryByTag(map, 'ul').id);
});

test('rebuild: rejects when the document changed outside the region', () => {
  const map = buildDeck(DECK);
  const h1 = entryByTag(map, 'h1');
  // simulate a racing external edit that also deleted the table
  const withEdit = applyInner(map, h1, 'Hi');
  const corrupted = withEdit.replace(/<table>.*<\/table>\n/s, '');
  assert.equal(rebuildAfterEdit(map, corrupted, regionOf(map, h1)), null);
});

test('li without explicit end tag: inner unavailable, outer valid', () => {
  const src = '<html><body><ul>\n<li>a\n<li>b\n</ul></body></html>';
  const map = buildDeck(src);
  const li = entryByTag(map, 'li', 0);
  assert.equal(li.innerStart, -1);
  assert.ok(li.outerEnd > li.outerStart);
  assert.equal(src.slice(li.outerStart, li.outerEnd), '<li>a\n');
});

test('instrumented output re-parses to the same element structure', () => {
  const map = buildDeck(DECK, { baseHref: 'https://res/' });
  const again = buildDeck(map.instrumented);
  assert.deepEqual(
    again.order.map((e) => `${e.tag}@${e.depth}`),
    map.order.map((e) => `${e.tag}@${e.depth}`)
  );
});

test('indentOf finds line indentation', () => {
  const src = '<body>\n    <p>x</p>\n</body>';
  const map = buildDeck('<html>' + src + '</html>');
  const p = entryByTag(map, 'p');
  assert.equal(indentOf(map.source, p.outerStart), '    ');
});

test('deck without head still builds and maps', () => {
  const src = '<p>hello</p>';
  const map = buildDeck(src, { baseHref: 'https://res/' });
  const p = entryByTag(map, 'p');
  assert.equal(map.source.slice(p.innerStart, p.innerEnd), 'hello');
  assert.ok(map.instrumented.includes('<base href="https://res/">'));
});

// Walk a parse5 document in the same DFS order as sourceMap so we can pair
// map entries with tree nodes. serialize(node) implements the HTML fragment
// serialization algorithm — i.e. what the browser's innerHTML returns — so
// this simulates the webview's write-back path end to end.
function bodyNodesDFS(source: string): any[] {
  const doc: any = parse(source, { sourceCodeLocationInfo: true });
  const html = doc.childNodes.find((n: any) => n.tagName === 'html');
  const body = html?.childNodes?.find((n: any) => n.tagName === 'body');
  const out: any[] = [];
  const visit = (n: any) => {
    for (const c of n.childNodes ?? []) {
      if (!c.tagName) continue;
      out.push(c);
      if (c.tagName !== 'template') visit(c);
    }
  };
  if (body) visit(body);
  return out;
}

test('browser-style innerHTML round-trips for every editable element of the demo deck', () => {
  const source = readFileSync(join(__dirname, '..', 'examples', 'demo.html'), 'utf8');
  let map = buildDeck(source, { baseHref: 'https://res/' });
  const nodes = bodyNodesDFS(source);
  assert.equal(nodes.length, map.order.length, 'DFS order must match');

  for (let i = 0; i < map.order.length; i++) {
    const entry = map.order[i];
    if (entry.innerStart < 0) continue; // void/implied elements
    if (['script', 'style', 'svg'].includes(entry.tag)) continue;
    const browserInnerHTML = serialize(nodes[i]);
    const newSource =
      map.source.slice(0, entry.innerStart) + browserInnerHTML + map.source.slice(entry.innerEnd);
    const res = rebuildAfterEdit(map, newSource, regionOf(map, entry));
    assert.ok(res, `round-trip failed for <${entry.tag}> #${i}`);
    // untouched elements keep their ids
    if (i > 0) assert.equal(res!.next.order[0].id, map.order[0].id);
  }
});

test('deepestContaining finds the smallest enclosing element', () => {
  const map = buildDeck(DECK);
  const li2 = entryByTag(map, 'li', 1);
  // a span strictly inside the second li's text
  const inside = deepestContaining(map, li2.innerStart + 1, li2.innerStart + 3);
  assert.equal(inside && inside.id, li2.id);
  // a span crossing from h1 into the ul can only be handled by the slide div
  const h1 = entryByTag(map, 'h1');
  const ul = entryByTag(map, 'ul');
  const crossing = deepestContaining(map, h1.innerStart, ul.innerStart + 1);
  assert.equal(crossing && crossing.id, entryByTag(map, 'div').id);
  // head / outside body → null
  assert.equal(deepestContaining(map, 0, 5), null);
});

test('external patch flow: an undo-style revert maps to one element region', () => {
  // forward edit: LiveDeck writes new content into a li
  const map0 = buildDeck(DECK);
  const li = entryByTag(map0, 'li', 0);
  const edited = applyInner(map0, li, 'Changed <em>text</em>');
  const map1 = rebuildAfterEdit(map0, edited, regionOf(map0, li))!.next;

  // undo: the same span reverts to the original text; the change span
  // (as reported by contentChanges) is the li's inner range in map1
  const li1 = entryByTag(map1, 'li', 0);
  const target = deepestContaining(map1, li1.innerStart, li1.innerEnd);
  assert.equal(target && target.id, li1.id);

  const reverted = applyInner(map1, li1, 'One');
  const rebuilt = rebuildAfterEdit(map1, reverted, regionOf(map1, target!));
  assert.ok(rebuilt);
  const root = rebuilt!.next.byId.get(rebuilt!.freshIds[0])!;
  assert.equal(root.tag, 'li');
  assert.equal(root.subtree + 1, rebuilt!.freshIds.length);
  assert.equal(rebuilt!.next.source, DECK);
  assert.equal(rebuilt!.next.source.slice(root.innerStart, root.innerEnd), 'One');
  // everything outside the li kept its identity
  assert.equal(entryByTag(rebuilt!.next, 'table').id, entryByTag(map1, 'table').id);
});

test('deletionRange consumes the whole line for an element on its own line', () => {
  const map = buildDeck(DECK);
  const h1 = entryByTag(map, 'h1');
  const del = deletionRange(map.source, h1.outerStart, h1.outerEnd);
  const deleted = map.source.slice(del.start, del.end);
  assert.equal(deleted, '  <h1>Hello</h1>\n');
  // inline element (strong sits mid-line): range stays exact
  const strong = entryByTag(map, 'strong');
  const del2 = deletionRange(map.source, strong.outerStart, strong.outerEnd);
  assert.equal(del2.start, strong.outerStart);
  assert.equal(del2.end, strong.outerEnd);
});

test('element deletion: empty region rebuild keeps everything else stable', () => {
  const map = buildDeck(DECK);
  const h1 = entryByTag(map, 'h1');
  const del = deletionRange(map.source, h1.outerStart, h1.outerEnd);
  const newSource = map.source.slice(0, del.start) + map.source.slice(del.end);
  const res = rebuildAfterEdit(map, newSource, regionOf(map, h1));
  assert.ok(res);
  assert.equal(res!.freshIds.length, 0);
  assert.deepEqual(
    res!.next.order.map((e) => e.tag),
    ['div', 'ul', 'li', 'li', 'strong', 'table', 'tbody', 'tr', 'td']
  );
  assert.equal(entryByTag(res!.next, 'ul').id, entryByTag(map, 'ul').id);
  assert.equal(entryByTag(res!.next, 'table').id, entryByTag(map, 'table').id);
  assert.ok(!res!.next.source.includes('Hello'));
  assert.ok(!res!.next.source.includes('\n\n  <ul>'), 'no blank line left behind');
});

test('sequential edits keep converging', () => {
  let map = buildDeck(DECK);
  for (let i = 0; i < 5; i++) {
    const li = entryByTag(map, 'li', 0);
    const newSource = applyInner(map, li, `edit ${i} <em>x</em>`);
    const res = rebuildAfterEdit(map, newSource, regionOf(map, li));
    assert.ok(res, `iteration ${i}`);
    map = res!.next;
    assert.equal(
      map.source.slice(entryByTag(map, 'li', 0).innerStart, entryByTag(map, 'li', 0).innerEnd),
      `edit ${i} <em>x</em>`
    );
    assert.equal(entryByTag(map, 'table').id, 'ld-7');
  }
});
