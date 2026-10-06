import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileDocument, diffRange } from '../src/server/fileDocument';

function tmpDeck(text: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedeck-'));
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, text);
  return file;
}

test('diffRange: smallest single range', () => {
  assert.equal(diffRange('abc', 'abc'), null);
  assert.deepEqual(diffRange('<p>One</p>', '<p>Two</p>'), { start: 3, endA: 6, endB: 6 });
  assert.deepEqual(diffRange('aXb', 'ab'), { start: 1, endA: 2, endB: 1 });
  assert.deepEqual(diffRange('aa', 'aaa'), { start: 2, endA: 2, endB: 3 });
});

test('replace writes exactly that range to disk and emits it', () => {
  const file = tmpDeck('<h1>Title</h1>\n<p>One</p>\n');
  const doc = new FileDocument(file);
  const seen: unknown[] = [];
  doc.onDidChange((c) => seen.push(c));
  assert.ok(doc.replace(18, 21, 'Uno'));
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Title</h1>\n<p>Uno</p>\n');
  assert.deepEqual(seen, [[{ start: 18, end: 21 }]]);
  assert.equal(doc.replace(5, 999, 'x'), false);
});

test('undo / redo restore our own edits', () => {
  const file = tmpDeck('<p>One</p>');
  const doc = new FileDocument(file);
  doc.replace(3, 6, 'Two');
  doc.replace(3, 6, 'Three');
  assert.equal(doc.undo(), 'ok');
  assert.equal(fs.readFileSync(file, 'utf8'), '<p>Two</p>');
  assert.equal(doc.undo(), 'ok');
  assert.equal(doc.getText(), '<p>One</p>');
  assert.equal(doc.undo(), 'empty');
  assert.equal(doc.redo(), 'ok');
  assert.equal(doc.getText(), '<p>Two</p>');
});

test('external writes become change events; our own writes do not echo', () => {
  const file = tmpDeck('<h1>A</h1>\n<p>One</p>\n');
  const doc = new FileDocument(file);
  const seen: unknown[] = [];
  doc.replace(4, 5, 'B');
  doc.onDidChange((c) => seen.push(c));
  doc.checkDisk(); // our own write is already in memory
  assert.deepEqual(seen, []);
  fs.writeFileSync(file, '<h1>B</h1>\n<p>One!</p>\n');
  doc.checkDisk();
  assert.deepEqual(seen, [[{ start: 17, end: 17 }]]);
  assert.equal(doc.getText(), '<h1>B</h1>\n<p>One!</p>\n');
});

test('undo refuses when someone else changed the range since', () => {
  const file = tmpDeck('<p>One</p>');
  const doc = new FileDocument(file);
  doc.replace(3, 6, 'Two');
  fs.writeFileSync(file, '<p>Agent</p>');
  doc.checkDisk();
  assert.equal(doc.undo(), 'conflict');
  assert.equal(doc.getText(), '<p>Agent</p>');
});

test('a byte-order mark survives edits', () => {
  const file = tmpDeck('﻿<p>One</p>');
  const doc = new FileDocument(file);
  assert.equal(doc.getText(), '<p>One</p>');
  doc.replace(3, 6, 'Two');
  assert.equal(fs.readFileSync(file, 'utf8'), '﻿<p>Two</p>');
});

test('undo survives an outside edit earlier in the file', () => {
  const file = tmpDeck('<title>T</title>\n<h1>A</h1>\n<p>One</p>\n<p>Two</p>\n');
  const doc = new FileDocument(file);
  const text = () => fs.readFileSync(file, 'utf8');
  // two of our own edits: delete <p>One</p>, then retitle the h1
  const p1 = text().indexOf('<p>One</p>\n');
  assert.ok(doc.replace(p1, p1 + '<p>One</p>\n'.length, ''));
  const h = text().indexOf('A</h1>');
  assert.ok(doc.replace(h, h + 1, 'Alpha'));
  // an agent changes the <title>, before both edits
  fs.writeFileSync(file, text().replace('<title>T</title>', '<title>Longer title</title>'));
  doc.checkDisk();
  assert.equal(doc.undo(), 'ok');
  assert.equal(doc.undo(), 'ok');
  assert.equal(text(), '<title>Longer title</title>\n<h1>A</h1>\n<p>One</p>\n<p>Two</p>\n');
});

test('undo keeps going past an outside edit after our edits', () => {
  const file = tmpDeck('<h1>A</h1>\n<p>One</p>\n');
  const doc = new FileDocument(file);
  const text = () => fs.readFileSync(file, 'utf8');
  assert.ok(doc.replace(4, 5, 'B'));
  fs.writeFileSync(file, text() + '<p>Agent</p>\n');
  doc.checkDisk();
  assert.equal(doc.undo(), 'ok');
  assert.equal(text(), '<h1>A</h1>\n<p>One</p>\n<p>Agent</p>\n');
});

test('undo stops at an edit an outside change overlapped', () => {
  const file = tmpDeck('<h1>A</h1>\n<p>One</p>\n');
  const doc = new FileDocument(file);
  const text = () => fs.readFileSync(file, 'utf8');
  assert.ok(doc.replace(4, 5, 'B')); // h1: A → B
  assert.ok(doc.replace(14, 17, 'Uno')); // p: One → Uno
  fs.writeFileSync(file, text().replace('B</h1>', 'C</h1>')); // agent rewrites the h1
  doc.checkDisk();
  assert.equal(doc.undo(), 'ok'); // Uno → One still undoes
  assert.equal(doc.undo(), 'conflict'); // the h1 edit is gone, not reverted over the agent's
  assert.equal(doc.undo(), 'empty');
  assert.equal(text(), '<h1>C</h1>\n<p>One</p>\n');
});
