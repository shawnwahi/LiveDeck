import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineResources, rewriteCssUrls, ResourceResolver } from '../src/resources';
import { buildDeck } from '../src/sourceMap';

const png = { mime: 'image/png', data: Buffer.from('PNGBYTES') };
const woff = { mime: 'font/woff2', data: Buffer.from('FONTBYTES') };
const css = {
  mime: 'text/css',
  data: Buffer.from("h1 { background: url('../assets/a.png'); }"),
};
const js = { mime: 'text/javascript', data: Buffer.from('console.log(1)') };

/** Minimal path normalizer so 'styles/../assets/a.png' hits the fixture. */
function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

const FILES: Record<string, { mime: string; data: Buffer }> = {
  'assets/a.png': png,
  'assets/f.woff2': woff,
  'styles/m.css': css,
  'app.js': js,
};

const resolve: ResourceResolver = (url) => FILES[normalize(url.split(/[?#]/)[0])] ?? null;

const pngUri = `data:image/png;base64,${png.data.toString('base64')}`;

test('img src becomes a data URI with the original stamped', () => {
  const html = '<html><body><img src="assets/a.png" alt="x"></body></html>';
  const out = inlineResources(html, resolve);
  assert.ok(out.includes(`src="${pngUri}"`));
  assert.ok(out.includes('data-ld-orig-src="assets/a.png"'));
});

test('head elements are rewritten without stamps', () => {
  const html = '<html><head><link rel="icon" href="assets/a.png"></head><body></body></html>';
  const out = inlineResources(html, resolve);
  assert.ok(out.includes(`href="${pngUri}"`));
  assert.ok(!out.includes('data-ld-orig'));
});

test('stylesheet link inlines with its inner url() refs resolved from its own dir', () => {
  const html = '<html><head><link rel="stylesheet" href="styles/m.css"></head><body></body></html>';
  const out = inlineResources(html, resolve);
  const m = out.match(/href="data:text\/css;base64,([^"]+)"/);
  assert.ok(m, 'stylesheet inlined');
  const decoded = Buffer.from(m![1], 'base64').toString('utf8');
  assert.ok(decoded.includes(`url('${pngUri}')`), 'nested url rewritten');
});

test('inline <style> in head rewritten, <style> in body stamped', () => {
  const html =
    '<html><head><style>a{background:url(assets/a.png)}</style></head>' +
    '<body><style>b{background:url(assets/a.png)}</style></body></html>';
  const out = inlineResources(html, resolve);
  assert.equal((out.match(new RegExp(pngUri.replace(/[+/=]/g, '.'), 'g')) ?? []).length >= 2, true);
  assert.equal((out.match(/data-ld-orig-css=/g) ?? []).length, 1);
});

test('style attribute rewritten and stamped in body', () => {
  const html = '<html><body><div style="background-image: url(\'assets/a.png\')">x</div></body></html>';
  const out = inlineResources(html, resolve);
  assert.ok(out.includes(`url(&apos;`) || out.includes(pngUri));
  assert.ok(out.includes('data-ld-orig-style="background-image: url(&#39;assets/a.png&#39;)"')
    || out.includes(`data-ld-orig-style="background-image: url('assets/a.png')"`));
});

test('absolute, data:, protocol-relative and fragment URLs untouched', () => {
  const html =
    '<html><body>' +
    '<img src="https://cdn.example.com/x.png">' +
    '<img src="data:image/png;base64,AAAA">' +
    '<img src="//cdn.example.com/y.png">' +
    '<a href="#slide2">go</a>' +
    '</body></html>';
  const out = inlineResources(html, resolve);
  assert.equal(out, html);
});

test('missing files are left alone', () => {
  const html = '<html><body><img src="assets/missing.png"></body></html>';
  assert.equal(inlineResources(html, resolve), html);
});

test('srcset is blanked (data URIs break its comma syntax) and stamped', () => {
  const html = '<html><body><img src="assets/a.png" srcset="assets/a.png 1x, assets/a.png 2x"></body></html>';
  const out = inlineResources(html, resolve);
  assert.ok(out.includes('srcset=""'));
  assert.ok(out.includes('data-ld-orig-srcset="assets/a.png 1x, assets/a.png 2x"'));
  assert.ok(out.includes(`src="${pngUri}"`));
});

test('script src inlined as data URI', () => {
  const html = '<html><body><p>x</p><script src="app.js"></script></body></html>';
  const out = inlineResources(html, resolve);
  assert.ok(out.includes(`src="data:text/javascript;base64,${js.data.toString('base64')}"`));
  assert.ok(out.includes('data-ld-orig-src="app.js"'));
});

test('rewriting preserves element structure exactly', () => {
  const html =
    '<!DOCTYPE html><html><head><style>a{background:url(assets/a.png)}</style></head><body>' +
    '<div class="slide"><h1>T</h1><img src="assets/a.png"/><ul><li>x</li></ul></div>' +
    '</body></html>';
  const before = buildDeck(html);
  const after = buildDeck(inlineResources(html, resolve));
  assert.deepEqual(
    after.order.map((e) => `${e.tag}@${e.depth}`),
    before.order.map((e) => `${e.tag}@${e.depth}`)
  );
});

test('rewriteCssUrls handles fonts and quoting variants', () => {
  const out = rewriteCssUrls(
    '@font-face { src: url("assets/f.woff2") format("woff2"); } .x { background: url( assets/a.png ); }',
    resolve
  );
  assert.ok(out.includes(`url('data:font/woff2;base64,${woff.data.toString('base64')}')`));
  assert.ok(out.includes(`url('${pngUri}')`));
});

test('self-closing svg image keeps valid markup when stamped', () => {
  const html = '<html><body><svg><image href="assets/a.png"/></svg></body></html>';
  const out = inlineResources(html, resolve);
  assert.ok(out.includes('data-ld-orig-href="assets/a.png"'));
  const reparsed = buildDeck(out);
  assert.deepEqual(reparsed.order.map((e) => e.tag), ['svg', 'image']);
});
