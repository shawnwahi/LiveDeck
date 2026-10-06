import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { anchor, lineCol, readSelections, writeSelection, SelectionItem } from '../src/selection';
import { handleRequest } from '../src/mcp';

process.env.LIVEDECK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'livedeck-home-'));

const item = (html: string, start: number): SelectionItem => ({
  tag: 'p', start, end: start + html.length, html, slide: 2, editing: false,
});

test('anchor: current, moved, stale', () => {
  const text = '<h1>T</h1>\n<p>One</p>\n<p>Two</p>';
  assert.deepEqual(anchor(item('<p>One</p>', 11), text), { status: 'current', start: 11, end: 21 });
  const moved = '<h1>Title</h1>\n' + text.slice(11);
  assert.deepEqual(anchor(item('<p>One</p>', 11), moved), { status: 'moved', start: 15, end: 25 });
  assert.deepEqual(anchor(item('<p>One</p>', 11), text.replace('One', 'Uno')), { status: 'stale' });
  // moved and duplicated since: ambiguous, so stale
  assert.deepEqual(anchor(item('<p>One</p>', 3), '<p>One</p><p>One</p>'), { status: 'stale' });
});

test('lineCol is 1-based', () => {
  assert.deepEqual(lineCol('ab\ncd', 0), { line: 1, column: 1 });
  assert.deepEqual(lineCol('ab\ncd', 4), { line: 2, column: 2 });
});

test('selections round-trip, newest first, and get_selection re-anchors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedeck-'));
  const a = path.join(dir, 'a.html');
  const b = path.join(dir, 'b.html');
  fs.writeFileSync(a, '<p>A</p>');
  fs.writeFileSync(b, '<h1>B</h1>\n<p>One</p>');
  writeSelection(a, [item('<p>A</p>', 0)]);
  await new Promise((r) => setTimeout(r, 5));
  writeSelection(b, [item('<p>One</p>', 11)]);
  assert.deepEqual(readSelections().map((s) => s.file), [b, a]);

  fs.writeFileSync(b, '<h1>Bee</h1>\n<p>One</p>'); // edited above the selection
  const res = handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_selection', arguments: {} } }, 't');
  const out = JSON.parse(res.result.content[0].text);
  assert.equal(out.file, b);
  assert.equal(out.items[0].status, 'moved');
  assert.equal(out.items[0].start, 13);
  assert.equal(out.items[0].startLine, 2);

  const resA = handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_selection', arguments: { file: a } } }, 't');
  assert.equal(JSON.parse(resA.result.content[0].text).items[0].status, 'current');
});

test('mcp: initialize, tools/list, notifications', () => {
  const init = handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, '1.2.3');
  assert.equal(init.result.serverInfo.version, '1.2.3');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, 't');
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['get_selection']);
  assert.equal(handleRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, 't'), undefined);
  assert.equal(handleRequest({ jsonrpc: '2.0', id: 3, method: 'nope' }, 't').error.code, -32601);
});
