import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, DeckMap, ElementInfo } from '../src/sourceMap';
import {
  StructOp,
  applyStructPlan,
  attrSpans,
  instrumentFragment,
  planSource,
  planStructOp,
  setStyleDecls,
  setStyleInStartTag,
  StructPlan,
} from '../src/structOps';

const DECK = `<!DOCTYPE html>
<html>
<body>
<section class="slide">
  <h1>Title</h1>
  <!-- note -->
  <p>One</p>
  <div class="card"><canvas id="c"></canvas></div>
  <hr>
</section>
<section class="slide">
  <p style="color: red">Two</p>
</section>
</body>
</html>`;

function nth(map: DeckMap, tag: string, n = 0): ElementInfo {
  const found = map.order.filter((e) => e.tag === tag);
  assert.ok(found.length > n, `no <${tag}> #${n}`);
  return found[n];
}

function run(map: DeckMap, op: StructOp) {
  const plan = planStructOp(map, op);
  assert.ok(!('error' in plan), 'error' in plan ? plan.error : '');
  const src = planSource(map, plan as StructPlan);
  const res = applyStructPlan(map, plan as StructPlan, src);
  assert.ok(res, 'apply should verify');
  return { plan: plan as StructPlan, src, ...res! };
}

test('attrSpans: quoted, unquoted, valueless', () => {
  const a = attrSpans(`<img src="a b.png" alt=x hidden data-q='y'>`);
  assert.deepEqual(a.map((x) => [x.name, x.value, x.quote]), [
    ['src', 'a b.png', '"'],
    ['alt', 'x', ''],
    ['hidden', null, ''],
    ['data-q', 'y', "'"],
  ]);
});

test('setStyleDecls: set, replace, remove, keeps untouched text', () => {
  assert.equal(setStyleDecls('', { translate: '1px 2px' }), 'translate: 1px 2px');
  assert.equal(setStyleDecls('color:red;', { translate: '1px' }), 'color:red; translate: 1px;');
  assert.equal(setStyleDecls('color:red; translate: 3px', { translate: '4px' }), 'color:red; translate: 4px');
  assert.equal(setStyleDecls('translate: 3px; color:red', { translate: null }), ' color:red');
  assert.equal(setStyleDecls('translate: 3px', { translate: null }), '');
  // semicolons inside url() are not separators
  assert.equal(
    setStyleDecls("background:url('data:image/png;base64,AA')", { translate: '1px' }),
    "background:url('data:image/png;base64,AA'); translate: 1px"
  );
});

test('setStyleInStartTag: add, update, remove attribute', () => {
  assert.equal(setStyleInStartTag('<p class="x">', { translate: '1px 2px' }).tag, '<p class="x" style="translate: 1px 2px">');
  assert.equal(setStyleInStartTag('<img src=x />', { translate: '1px' }).tag, '<img src=x style="translate: 1px" />');
  assert.equal(setStyleInStartTag('<p style="translate: 1px">', { translate: '5px' }).tag, '<p style="translate: 5px">');
  const r = setStyleInStartTag('<p class="x" style="translate: 1px">', { translate: null });
  assert.equal(r.tag, '<p class="x">');
  assert.equal(r.style, null);
});

test('duplicate: copies source text on its own line; original keeps ids', () => {
  const map = buildDeck(DECK);
  const card = nth(map, 'div');
  const { src, pairs, next } = run(map, { op: 'duplicate', id: card.id });
  assert.ok(src.includes(
    '  <div class="card"><canvas id="c"></canvas></div>\n  <div class="card"><canvas id="c"></canvas></div>\n  <hr>'
  ));
  assert.equal(nth(next, 'div', 0).id, card.id); // original untouched
  assert.deepEqual(pairs.map((p) => p[0]), [card.id, nth(map, 'canvas').id]);
  assert.deepEqual(pairs.map((p) => p[1]), [nth(next, 'div', 1).id, nth(next, 'canvas', 1).id]);
  assert.equal(nth(next, 'hr').id, nth(map, 'hr').id);
});

test('move: adjacent swap keeps separators in place', () => {
  const map = buildDeck(DECK);
  const p = nth(map, 'p');
  const h1 = nth(map, 'h1');
  const { src, pairs, next } = run(map, { op: 'move', id: p.id, targetId: h1.id, before: true });
  assert.ok(src.includes('  <p>One</p>\n  <!-- note -->\n  <h1>Title</h1>\n'));
  assert.equal(next.order[1].tag, 'p');
  const byOld = new Map(pairs);
  assert.equal(nth(next, 'p').id, byOld.get(p.id));
  assert.equal(nth(next, 'h1').id, byOld.get(h1.id));
  assert.equal(nth(next, 'hr').id, nth(map, 'hr').id); // outside the run
});

test('move: non-adjacent, after target; whole slides reorder', () => {
  const map = buildDeck(DECK);
  const h1 = nth(map, 'h1');
  const hr = nth(map, 'hr');
  const r = run(map, { op: 'move', id: h1.id, targetId: hr.id, before: false });
  assert.deepEqual(r.next.order.slice(1, 6).map((e) => e.tag), ['p', 'div', 'canvas', 'hr', 'h1']);

  const s1 = nth(map, 'section', 0);
  const s2 = nth(map, 'section', 1);
  const r2 = run(map, { op: 'move', id: s2.id, targetId: s1.id, before: true });
  assert.ok(r2.src.indexOf('Two') < r2.src.indexOf('Title'));
  assert.equal(r2.pairs.length, map.order.length);
});

test('move: refuses non-siblings and no-ops', () => {
  const map = buildDeck(DECK);
  const p = nth(map, 'p');
  assert.ok('error' in planStructOp(map, { op: 'move', id: p.id, targetId: nth(map, 'p', 1).id, before: true }));
  assert.ok('error' in planStructOp(map, { op: 'move', id: p.id, targetId: nth(map, 'h1').id, before: false }));
});

test('style: only the start tag changes; descendants keep ids', () => {
  const map = buildDeck(DECK);
  const card = nth(map, 'div');
  const { src, pairs, next, plan } = run(map, { op: 'style', id: card.id, props: { translate: '10px 20px' } });
  assert.ok(src.includes('<div class="card" style="translate: 10px 20px"><canvas id="c"></canvas></div>'));
  assert.equal(pairs.length, 1);
  assert.equal(nth(next, 'canvas').id, nth(map, 'canvas').id);
  assert.equal(plan.styleAttr, 'translate: 10px 20px');

  const p2 = nth(map, 'p', 1);
  const r2 = run(map, { op: 'style', id: p2.id, props: { translate: '1px 1px' } });
  assert.ok(r2.src.includes('<p style="color: red; translate: 1px 1px">Two</p>'));
});

test('insert after anchor and append into container', () => {
  const map = buildDeck(DECK);
  const img = '<img src="images/a.png" alt="" width="300">';
  const a = run(map, { op: 'insert', anchorId: nth(map, 'p').id, where: 'after', html: img });
  assert.ok(a.src.includes('<p>One</p>\n  <img src="images/a.png" alt="" width="300">\n  <div'));
  assert.equal(a.freshIds.length, 1);
  assert.equal(nth(a.next, 'img').id, a.freshIds[0]);

  const s2 = nth(map, 'section', 1);
  const b = run(map, { op: 'insert', anchorId: s2.id, where: 'append', html: img });
  assert.ok(b.src.includes('<p style="color: red">Two</p>\n  <img src="images/a.png" alt="" width="300">\n</section>'));
  const html = instrumentFragment(img, b.freshIds);
  assert.equal(html, `<img src="images/a.png" alt="" width="300" data-ld-id="${b.freshIds[0]}">`);
});

test('insert into empty container', () => {
  const src = '<html><body>\n<div class="slide"></div>\n</body></html>';
  const map = buildDeck(src);
  const r = run(map, { op: 'insert', anchorId: nth(map, 'div').id, where: 'append', html: '<img src="x.png">' });
  assert.ok(r.src.includes('<div class="slide">\n  <img src="x.png">\n</div>'));
});

test('apply rejects a document that diverged from the plan', () => {
  const map = buildDeck(DECK);
  const plan = planStructOp(map, { op: 'duplicate', id: nth(map, 'p').id }) as StructPlan;
  const wrong = planSource(map, plan).replace('<hr>', '');
  assert.equal(applyStructPlan(map, plan, wrong), null);
});

test('parser-implied elements cannot be targeted', () => {
  const map = buildDeck('<html><body><table><tr><td>x</td></tr></table></body></html>');
  assert.ok('error' in planStructOp(map, { op: 'duplicate', id: nth(map, 'tbody').id }));
  // but duplicating the row (inside implied tbody) works
  const r = run(map, { op: 'duplicate', id: nth(map, 'tr').id });
  assert.equal(r.next.order.filter((e) => e.tag === 'tr').length, 2);
});
