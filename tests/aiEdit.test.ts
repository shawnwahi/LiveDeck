import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReply, validateReplacement } from '../src/aiEdit';

test('parseReply: extracts the fenced html block', () => {
  const r = parseReply('Here you go:\n```html\n<p class="x">New text</p>\n```\nDone.');
  assert.deepEqual(r, { html: '<p class="x">New text</p>' });
});

test('parseReply: no block means an explanation', () => {
  const r = parseReply('I could not find a verifiable source for this claim.');
  assert.deepEqual(r, { message: 'I could not find a verifiable source for this claim.' });
});

test('validateReplacement: accepts elements, rejects stray text and documents', () => {
  assert.equal(validateReplacement('<p>a</p>\n<p>b</p>'), null);
  assert.equal(validateReplacement('<li>a</li>'), null);
  assert.equal(validateReplacement('<td>cell</td>'), null);
  assert.ok(validateReplacement('just text'));
  assert.ok(validateReplacement('<p>a</p> trailing'));
  assert.ok(validateReplacement('<html><body><p>a</p></body></html>'));
  assert.ok(validateReplacement('   '));
});
