/**
 * `livedeck serve`: the LiveDeck editor in a plain browser tab, so it runs in
 * the Claude desktop app's Preview pane, the Codex app's in-app browser, or
 * any browser, next to a coding agent editing the same file.
 *
 * The page is the same shell as the VS Code webview; media/bridge.js stands
 * in for acquireVsCodeApi(). Host → page messages go over Server-Sent Events,
 * page → host messages are POSTs, sent strictly in order by the bridge.
 */
import * as http from 'http';
import { AddressInfo } from 'net';
import * as fs from 'fs';
import * as path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_CONFIG, DeckSession, HostAdapter, mimeType } from '../deckSession';
import { shellHtml } from '../shellHtml';
import { lineCol } from '../selection';
import { FileDocument } from './fileDocument';

export interface ServeOptions {
  file: string;
  port: number;
  /** try the following ports if `port` is taken */
  portFallback: boolean;
  /** where shell.js / shell.css / bridge.js live */
  mediaDir: string;
  log?: (line: string) => void;
}

const MEDIA_FILES = new Set(['shell.js', 'shell.css', 'bridge.js', 'standalone.css']);
const MAX_BODY = 64 * 1024 * 1024; // pasted images arrive base64-encoded

function loadConfig(deckDir: string) {
  const cfg = { ...DEFAULT_CONFIG };
  try {
    const user = JSON.parse(fs.readFileSync(path.join(deckDir, '.livedeck.json'), 'utf8'));
    for (const k of Object.keys(cfg) as (keyof typeof cfg)[]) {
      if (user[k] !== undefined && typeof user[k] === typeof cfg[k]) (cfg as any)[k] = user[k];
    }
  } catch {
    /* no config file: defaults */
  }
  return cfg;
}

/** One browser tab's view of the shared document. */
class BrowserAdapter implements HostAdapter {
  constructor(
    private readonly doc: FileDocument,
    readonly post: (msg: unknown) => void
  ) {}

  get fsPath() {
    return this.doc.file;
  }
  getText() {
    return this.doc.getText();
  }
  isDirty() {
    return false; // every edit is on disk already
  }
  async replace(start: number, end: number, text: string) {
    return this.doc.replace(start, end, text);
  }
  onDidChange(cb: Parameters<FileDocument['onDidChange']>[0]) {
    return this.doc.onDidChange(cb);
  }
  onDidSave() {
    return { dispose() {} };
  }
  baseHref() {
    return '/deck/';
  }
  config() {
    return loadConfig(path.dirname(this.doc.file));
  }
  private toast(text: string) {
    this.post({ type: 'toast', text });
  }
  private undoResult(r: 'ok' | 'empty' | 'conflict', what: string) {
    if (r === 'empty') this.toast(`Nothing to ${what}`);
    if (r === 'conflict') this.toast(`Can't ${what}: the file was changed elsewhere since`);
  }
  async undo() {
    this.undoResult(this.doc.undo(), 'undo');
  }
  async redo() {
    this.undoResult(this.doc.redo(), 'redo');
  }
  async save() {
    this.toast('Saved — LiveDeck writes every edit to disk');
  }
  async openSource() {
    this.toast(`Source: ${this.doc.file}`);
  }
  async openBrowser() {
    /* opened by the bridge (needs the click's user gesture) */
  }
  async reveal(start: number) {
    const { line } = lineCol(this.doc.getText(), start);
    this.toast(`${path.basename(this.doc.file)}, line ${line}`);
  }
  async openExternal() {
    /* opened by the bridge */
  }
  async clipboardRead() {
    return ''; // the bridge uses the browser clipboard
  }
  async clipboardWrite() {}
  async pickImageFile() {
    return null; // the bridge shows a file input and sends the bytes
  }
  async anthropicClient(): Promise<Anthropic | { error: string }> {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      return { error: 'Set ANTHROPIC_API_KEY before starting livedeck serve' };
    }
    return new Anthropic();
  }
  async onAuthError() {
    return 'ANTHROPIC_API_KEY was rejected';
  }
}

interface Client {
  session: DeckSession;
  res: http.ServerResponse;
}

export async function serve(opts: ServeOptions): Promise<{ url: string; close(): void }> {
  const file = path.resolve(opts.file);
  const deckDir = path.dirname(file);
  const log = opts.log ?? (() => {});
  const doc = new FileDocument(file);
  doc.watch();
  const clients = new Map<string, Client>();
  let port = opts.port;

  const page = shellHtml({
    media: (f) => `/media/${f}`,
    cspSource: `'self'`,
    styles: ['/media/standalone.css'],
    preScripts: ['/media/bridge.js'],
    hide: ['save', 'source'],
  });

  const send = (res: http.ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };

  /** Only answer requests addressed to this machine by name (blocks DNS rebinding). */
  const hostOk = (req: http.IncomingMessage) =>
    [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(req.headers.host ?? '');

  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!hostOk(req)) return send(res, 403, 'Forbidden');
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/') return send(res, 200, page, 'text/html; charset=utf-8');

    if (req.method === 'GET' && p.startsWith('/media/')) {
      const name = p.slice('/media/'.length);
      if (!MEDIA_FILES.has(name)) return send(res, 404, 'Not found');
      return fs.readFile(path.join(opts.mediaDir, name), (err, data) =>
        err ? send(res, 404, 'Not found') : send(res, 200, data, mimeType(name))
      );
    }

    // the deck's own folder, for anything not inlined (links, fetches) and "Browser"
    if (req.method === 'GET' && (p === '/deck' || p === '/deck/')) {
      res.writeHead(302, { Location: `/deck/${encodeURIComponent(path.basename(file))}` });
      return res.end();
    }
    if (req.method === 'GET' && p.startsWith('/deck/')) {
      let rel: string;
      try {
        rel = decodeURIComponent(p.slice('/deck/'.length));
      } catch {
        return send(res, 400, 'Bad path');
      }
      const abs = path.resolve(deckDir, rel);
      if (abs !== deckDir && !abs.startsWith(deckDir + path.sep)) return send(res, 403, 'Forbidden');
      return fs.readFile(abs, (err, data) =>
        err ? send(res, 404, 'Not found') : send(res, 200, data, mimeType(abs))
      );
    }

    if (req.method === 'GET' && p === '/events') {
      const id = url.searchParams.get('client') ?? '';
      if (!/^[\w-]{6,64}$/.test(id)) return send(res, 400, 'Bad client id');
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.get(id)?.session.dispose();
      const session = new DeckSession(
        new BrowserAdapter(doc, (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`))
      );
      clients.set(id, { session, res });
      log(`editor connected (${clients.size} open)`);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        session.dispose();
        if (clients.get(id)?.res === res) clients.delete(id);
        log(`editor disconnected (${clients.size} open)`);
      });
      return;
    }

    if (req.method === 'POST' && p === '/msg') {
      // a custom header makes cross-origin pages preflight, which we never grant
      if (req.headers['x-livedeck'] !== '1') return send(res, 403, 'Forbidden');
      const client = clients.get(url.searchParams.get('client') ?? '');
      if (!client) return send(res, 410, 'Unknown client');
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy();
        else chunks.push(c);
      });
      req.on('end', async () => {
        let msg: unknown;
        try {
          msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(res, 400, 'Bad JSON');
        }
        try {
          await client.session.onMessage(msg);
        } catch (err) {
          log(`error handling message: ${(err as Error).stack ?? err}`);
        }
        send(res, 204, '');
      });
      return;
    }

    send(res, 404, 'Not found');
  };

  // Listen on both loopback addresses: "localhost" resolves to either.
  const servers: http.Server[] = [];
  const listen = (host: string, p: number) =>
    new Promise<http.Server>((resolve, reject) => {
      const s = http.createServer(handler);
      s.once('error', reject);
      s.listen(p, host, () => resolve(s));
    });
  for (let attempt = 0; ; attempt++) {
    try {
      servers.push(await listen('127.0.0.1', port));
      port = (servers[0].address() as AddressInfo).port; // port 0 picks a free one
      break;
    } catch (err: any) {
      if (err?.code !== 'EADDRINUSE' || !opts.portFallback || attempt >= 20) throw err;
      port++;
    }
  }
  try {
    servers.push(await listen('::1', port));
  } catch {
    /* no IPv6 loopback: 127.0.0.1 is enough */
  }

  return {
    url: `http://localhost:${port}/`,
    close() {
      for (const c of clients.values()) {
        c.session.dispose();
        c.res.end();
      }
      clients.clear();
      doc.dispose();
      servers.forEach((s) => s.close());
    },
  };
}
