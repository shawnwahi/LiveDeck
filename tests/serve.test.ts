import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { serve } from '../src/server/serve';

process.env.LIVEDECK_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'livedeck-home-'));

const DECK = `<!DOCTYPE html>
<html>
<head><title>T</title></head>
<body>
<section class="slide">
  <h1>Hello</h1>
  <p>One</p>
</section>
</body>
</html>
`;

/** Read Server-Sent Events from the editor stream. */
function eventStream(url: string) {
  const ctrl = new AbortController();
  const queue: any[] = [];
  let wake: (() => void) | null = null;
  const ready = fetch(url, { signal: ctrl.signal }).then(async (res) => {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
            if (data) { queue.push(JSON.parse(data)); wake?.(); }
          }
        }
      } catch { /* aborted */ }
    })();
  });
  return {
    ready,
    async next(type: string): Promise<any> {
      for (;;) {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) return queue.splice(i, 1)[0];
        await new Promise<void>((r) => { wake = r; setTimeout(r, 2000); });
      }
    },
    close: () => ctrl.abort(),
  };
}

test('serve: shell page, editing, external changes, guards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedeck-'));
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, DECK);
  fs.writeFileSync(path.join(dir, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const server = await serve({ file, port: 0, portFallback: false, mediaDir: path.join(__dirname, '..', 'media') });
  const base = server.url.replace(/\/$/, '');
  const post = (client: string, msg: unknown, headers: Record<string, string> = { 'X-LiveDeck': '1' }) =>
    fetch(`${base}/msg?client=${client}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(msg) });

  try {
    const page = await (await fetch(base + '/')).text();
    assert.match(page, /<script src="\/media\/bridge\.js"><\/script>\s*<script src="\/media\/shell\.js">/);
    assert.equal((await fetch(base + '/media/bridge.js')).status, 200);
    assert.equal((await fetch(base + '/media/../package.json')).status, 404);
    assert.equal((await fetch(base + '/deck/pic.svg')).status, 200);
    assert.equal((await fetch(base + '/deck/..%2F..%2Fetc%2Fpasswd')).status, 403);

    const client = 'testclient1';
    const events = eventStream(`${base}/events?client=${client}`);
    await events.ready;
    assert.equal((await post(client, { type: 'ready' }, {})).status, 403); // no custom header
    assert.equal((await post('nobody00', { type: 'ready' })).status, 410);

    await post(client, { type: 'ready' });
    const init = await events.next('init');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('data-ld-id'));
    const h1Id = /<h1 data-ld-id="([^"]+)"/.exec(init.html)![1];

    // an edit from the page lands in the file as that element only
    await post(client, { type: 'edit', mode: 'inner', id: h1Id, mapVersion: init.mapVersion, html: 'Hi there' });
    const ack = await events.next('ack');
    assert.equal(fs.readFileSync(file, 'utf8'), DECK.replace('<h1>Hello</h1>', '<h1>Hi there</h1>'));

    // selection is published for agents
    const pId = /<p data-ld-id="([^"]+)"/.exec(init.html)![1];
    await post(client, { type: 'selection', mapVersion: ack.mapVersion, items: [{ id: pId, slide: 1 }] });
    const sel = fs.readdirSync(path.join(process.env.LIVEDECK_HOME!, 'selection'));
    assert.equal(sel.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.LIVEDECK_HOME!, 'selection', sel[0]), 'utf8'));
    assert.equal(saved.items[0].html, '<p>One</p>');

    // undo goes through our own stack and comes back as a patch
    await post(client, { type: 'undo' });
    const patch = await events.next('patch');
    assert.equal(patch.html, 'Hello');
    assert.equal(fs.readFileSync(file, 'utf8'), DECK);

    // someone else (an agent) edits the file: patched in place
    fs.writeFileSync(file, DECK.replace('<p>One</p>', '<p>One, edited by Claude</p>'));
    const ext = await events.next('patch');
    assert.equal(ext.html, 'One, edited by Claude');

    // wrong Host header (DNS rebinding) is refused
    const http = await import('http');
    const status = await new Promise<number>((resolve) => {
      http.get(base + '/', { headers: { Host: 'evil.example:80' } }, (res) => { res.resume(); resolve(res.statusCode!); });
    });
    assert.equal(status, 403);
    events.close();
  } finally {
    server.close();
  }
});
