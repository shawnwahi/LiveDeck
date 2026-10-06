/**
 * One editing session: a deck file shown in one editor shell (a VS Code
 * webview, or a browser tab served by `livedeck serve`). Owns the source map
 * and implements the edit protocol; everything host-specific goes through
 * HostAdapter. Never import `vscode` here.
 */
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import {
  buildDeck,
  rebuildAfterEdit,
  regionOf,
  indentOf,
  deepestContaining,
  deletionRange,
  DeckMap,
} from './sourceMap';
import { inlineResources, ResourceResolver, ResolvedResource } from './resources';
import {
  StructOp,
  StructPlan,
  applyStructPlan,
  instrumentFragment,
  planSource,
  planStructOp,
} from './structOps';
import Anthropic from '@anthropic-ai/sdk';
import { runAiEdit, validateReplacement } from './aiEdit';
import { SelectionItem, writeSelection } from './selection';
import { DEFAULT_IMAGE_COMPRESS, planImageCompression } from './imageCompress';

export interface ShellConfig {
  slideSelectors: string[];
  editDebounceMs: number;
  pastePlainText: boolean;
  normalizeMarkup: boolean;
}

/** Host-side settings: the shell config plus what only the extension uses. */
export type HostConfig = ShellConfig & {
  imageFolder: string;
  /** On open, rewrite large opaque inline PNGs as JPEG (imageCompress.ts). */
  compressInlineImages: boolean;
};

/** Defaults mirror the `livedeck.*` settings in package.json. */
export const DEFAULT_CONFIG: HostConfig = {
  slideSelectors: [
    'section.slide',
    '.slide',
    '.reveal .slides > section',
    'body > section',
    'main > section',
    '[data-slide]',
  ],
  editDebounceMs: 400,
  pastePlainText: true,
  normalizeMarkup: true,
  imageFolder: 'images',
  compressInlineImages: true,
};

/** A changed span of the document, in offsets of the text before the change. */
export interface TextChange {
  start: number;
  end: number;
}

export interface Disposable {
  dispose(): void;
}

/** What a host must provide. Document writes are always one contiguous range. */
export interface HostAdapter {
  /** Absolute path of the deck on disk, or null (untitled / remote scheme). */
  readonly fsPath: string | null;
  getText(): string;
  isDirty(): boolean;
  /** Replace [start, end) of the document as one undoable edit. */
  replace(start: number, end: number, text: string): Promise<boolean>;
  /** Fires after every document change, including our own replace(). */
  onDidChange(cb: (changes: TextChange[]) => void): Disposable;
  onDidSave(cb: () => void): Disposable;
  /** Send a message to the shell. */
  post(msg: unknown): void;
  /** <base href> for the rendered deck: where relative URLs resolve. */
  baseHref(): string;
  config(): HostConfig;
  undo(): Promise<void>;
  redo(): Promise<void>;
  save(): Promise<void>;
  openSource(): Promise<void>;
  openBrowser(): Promise<void>;
  /** Show [start, end) of the source to the user. */
  reveal(start: number, end: number): Promise<void>;
  openExternal(url: string): Promise<void>;
  clipboardRead(): Promise<string>;
  clipboardWrite(text: string): Promise<void>;
  /** Ask the user for an image file; absolute path or null if cancelled. */
  pickImageFile(defaultDir: string, exts: string[]): Promise<string | null>;
  /** Client for "AI this element", or a reason it is unavailable. */
  anthropicClient(): Promise<Anthropic | { error: string }>;
  /** The stored API key was rejected; forget it. Returns the message to show. */
  onAuthError(): Promise<string>;
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
};

export function mimeType(file: string): string {
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

const MAX_RESOURCE_BYTES = 48 * 1024 * 1024;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'bmp'];
const EXT_FOR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
};

function attrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

interface EditMessage {
  type: 'edit';
  mode: 'inner' | 'outer';
  id: string;
  mapVersion: number;
  /** inner mode: new innerHTML for the element */
  html?: string;
  /** outer mode: outerHTML parts that replace the element's outer range */
  parts?: string[];
}

export class DeckSession {
  private map: DeckMap | null = null;
  private mapVersionCounter = 0;
  private nextIdCounter = 1;
  private applyingSelfEdit = false;
  private externalReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: Disposable[] = [];
  private aiAbort: AbortController | null = null;
  private compressing: Promise<void> | null = null;
  /** Inline images already examined, by base64 payload (null: left as is). */
  private readonly compressedImages = new Map<string, string | null>();

  constructor(private readonly host: HostAdapter) {
    this.disposables.push(
      host.onDidChange((changes) => {
        this.postDirty();
        if (this.applyingSelfEdit) return;
        if (changes.length === 0) return;
        if (!this.tryPatch(changes)) this.scheduleExternalReload();
      }),
      host.onDidSave(() => this.postDirty())
    );
  }

  dispose() {
    clearTimeout(this.externalReloadTimer);
    this.aiAbort?.abort();
    this.disposables.forEach((d) => d.dispose());
  }

  private readonly resourceCache = new Map<
    string,
    { mtimeMs: number; res: ResolvedResource | null }
  >();

  /** Resolve deck-relative URLs to file contents for data:-URI inlining. */
  private makeResolver(): ResourceResolver {
    const dir = this.deckDir();
    if (!dir) return () => null;
    return (url) => {
      try {
        let clean = url.split(/[?#]/)[0];
        try {
          clean = decodeURIComponent(clean);
        } catch {
          /* keep raw */
        }
        if (!clean) return null;
        // treat root-relative paths as deck-relative first, then absolute
        const candidates = clean.startsWith('/')
          ? [path.resolve(dir, '.' + clean), clean]
          : [path.resolve(dir, clean)];
        for (const p of candidates) {
          let stat: fs.Stats;
          try {
            stat = fs.statSync(p);
          } catch {
            continue;
          }
          if (!stat.isFile() || stat.size > MAX_RESOURCE_BYTES) return null;
          const cached = this.resourceCache.get(p);
          if (cached && cached.mtimeMs === stat.mtimeMs) return cached.res;
          const res: ResolvedResource = {
            mime: mimeType(p),
            data: fs.readFileSync(p),
          };
          this.resourceCache.set(p, { mtimeMs: stat.mtimeMs, res });
          return res;
        }
        return null;
      } catch {
        return null;
      }
    };
  }

  private post(msg: unknown) {
    this.host.post(msg);
  }

  private postDirty() {
    this.post({ type: 'dirty', dirty: this.host.isDirty() });
  }

  private shellConfig(): ShellConfig {
    const { slideSelectors, editDebounceMs, pastePlainText, normalizeMarkup } = this.host.config();
    return { slideSelectors, editDebounceMs, pastePlainText, normalizeMarkup };
  }

  /** Build a fresh map and (re)render the deck in the webview. */
  private postInit() {
    this.map = buildDeck(this.host.getText(), {
      baseHref: this.host.baseHref(),
      version: ++this.mapVersionCounter,
      startId: this.nextIdCounter,
    });
    this.nextIdCounter = this.map.nextId;
    this.post({
      type: 'init',
      html: inlineResources(this.map.instrumented, this.makeResolver()),
      mapVersion: this.map.version,
      config: this.shellConfig(),
    });
    this.postDirty();
  }

  /**
   * Before rendering, shrink large opaque inline PNGs to JPEG. One edit per
   * data: URI, applied last-to-first and only where the source still holds
   * the exact URI; concurrent 'ready's (several tabs) share one run.
   */
  private compressInlineImages(): Promise<void> {
    if (!this.host.config().compressInlineImages) return Promise.resolve();
    this.compressing ??= this.runImageCompression().finally(() => {
      this.compressing = null;
    });
    return this.compressing;
  }

  private async runImageCompression() {
    const source = this.host.getText();
    const pending = [...source.matchAll(/data:image\/png;base64,([A-Za-z0-9+/]+)/g)].filter(
      (m) => m[0].length >= DEFAULT_IMAGE_COMPRESS.minChars && !this.compressedImages.has(m[1])
    ).length;
    if (!pending) return;
    this.post({ type: 'toast', text: `Compressing ${pending} inline PNG${pending > 1 ? 's' : ''}…` });
    const plan = await planImageCompression(
      source,
      DEFAULT_IMAGE_COMPRESS,
      () => new Promise((r) => setImmediate(r)),
      this.compressedImages
    );
    let saved = 0;
    for (const r of [...plan.replacements].reverse()) {
      if (this.host.getText().slice(r.start, r.end) !== r.original) continue;
      if (await this.applySelf(r.start, r.end, r.text)) saved += r.original.length - r.text.length;
    }
    if (saved > 0) {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      this.post({
        type: 'toast',
        text: `Compressed ${plan.images} inline PNG${plan.images > 1 ? 's' : ''} to JPEG: ${mb(source.length)} → ${mb(source.length - saved)} MB`,
      });
    }
  }

  private scheduleExternalReload() {
    clearTimeout(this.externalReloadTimer);
    this.externalReloadTimer = setTimeout(() => {
      this.externalReloadTimer = undefined;
      this.postInit();
      this.post({ type: 'toast', text: 'Deck updated from source' });
    }, 300);
  }

  /**
   * External change (undo/redo, an agent's edit, split source view). If every
   * changed span is confined to one element's inner range, patch that element
   * in place in the webview instead of re-rendering the deck — deck scripts
   * keep running and their state (e.g. the current slide of a slide-mode
   * deck) survives. Returns false when only a full re-render is safe.
   */
  private tryPatch(changes: TextChange[]): boolean {
    const map = this.map;
    if (!map || this.externalReloadTimer !== undefined) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of changes) {
      lo = Math.min(lo, c.start);
      hi = Math.max(hi, c.end);
    }
    if (!Number.isFinite(lo)) return false;
    const target = deepestContaining(map, lo, hi);
    if (!target) return false;

    const rebuilt = rebuildAfterEdit(map, this.host.getText(), regionOf(map, target), {
      baseHref: this.host.baseHref(),
    });
    if (!rebuilt || rebuilt.freshIds.length === 0) return false;

    const oldId = target.id;
    this.map = rebuilt.next;
    this.map.version = ++this.mapVersionCounter;
    this.nextIdCounter = this.map.nextId;

    const rootEntry = this.map.byId.get(rebuilt.freshIds[0]);
    // The region must still be a single element of the same tag (inserted
    // text could in principle close the tag and open siblings).
    if (
      !rootEntry ||
      rootEntry.tag !== target.tag ||
      rootEntry.innerStart < 0 ||
      rootEntry.subtree + 1 !== rebuilt.freshIds.length
    ) {
      this.scheduleExternalReload();
      return true; // map already updated; reload will re-render consistently
    }

    const raw = this.map.source.slice(rootEntry.innerStart, rootEntry.innerEnd);
    // Wrap so fragment content parses in body context; inlineResources only
    // splices attributes, so the wrapper lengths stay fixed.
    const pre = '<html><body>';
    const post = '</body></html>';
    const inlined = inlineResources(pre + raw + post, this.makeResolver());
    const patchHtml = inlined.slice(pre.length, inlined.length - post.length);

    this.post({
      type: 'patch',
      oldId,
      html: patchHtml,
      ids: rebuilt.freshIds,
      mapVersion: this.map.version,
    });
    return true;
  }

  async onMessage(msg: any) {
    switch (msg?.type) {
      case 'ready':
        await this.compressInlineImages();
        this.postInit();
        break;
      case 'edit':
        await this.handleEdit(msg as EditMessage);
        break;
      case 'struct':
        await this.handleStruct(msg);
        break;
      case 'saveImage':
        await this.handleSaveImage(msg);
        break;
      case 'pickImage':
        await this.handlePickImage(msg);
        break;
      case 'reveal':
        await this.reveal(msg.id);
        break;
      case 'aiEdit':
        await this.handleAiEdit(msg);
        break;
      case 'aiCancel':
        this.aiAbort?.abort();
        break;
      case 'selection':
        this.handleSelection(msg);
        break;
      case 'requestReload':
        this.postInit();
        break;
      case 'undo':
        await this.host.undo();
        break;
      case 'redo':
        await this.host.redo();
        break;
      case 'save':
        await this.host.save();
        break;
      case 'openSource':
        await this.host.openSource();
        break;
      case 'openBrowser':
        await this.host.openBrowser();
        break;
      case 'clipboardWrite':
        if (typeof msg.text === 'string') await this.host.clipboardWrite(msg.text);
        this.post({ type: 'clipboardText', reqId: msg.reqId });
        break;
      case 'clipboardRead':
        this.post({ type: 'clipboardText', reqId: msg.reqId, text: await this.host.clipboardRead() });
        break;
      case 'openExternal':
        if (typeof msg.url === 'string' && /^https?:/i.test(msg.url)) {
          await this.host.openExternal(msg.url);
        }
        break;
      case 'log':
        console.log('[livedeck webview]', msg.text);
        break;
    }
  }

  /** Replace a source range as our own edit (the change listener ignores it). */
  private async applySelf(start: number, end: number, text: string): Promise<boolean> {
    this.applyingSelfEdit = true;
    try {
      return await this.host.replace(start, end, text);
    } finally {
      this.applyingSelfEdit = false;
    }
  }

  private async handleEdit(msg: EditMessage) {
    const map = this.map;
    if (!map || msg.mapVersion !== map.version) {
      // Stale edit (raced with an external change). Rebuild and re-render.
      this.postInit();
      return;
    }
    const entry = map.byId.get(msg.id);
    if (!entry || entry.outerStart < 0) {
      this.postInit();
      return;
    }

    let rangeStart: number;
    let rangeEnd: number;
    let newText: string;

    if (msg.mode === 'inner') {
      if (typeof msg.html !== 'string') return;
      if (entry.innerStart >= 0) {
        rangeStart = entry.innerStart;
        rangeEnd = entry.innerEnd;
        newText = msg.html;
      } else {
        // No explicit end tag in source (e.g. `<li>` with implied close):
        // rewrite the whole element, adding an explicit end tag. Start tag is
        // taken from the clean source, so it carries no instrumentation.
        rangeStart = entry.outerStart;
        rangeEnd = entry.outerEnd;
        const startTag = map.source.slice(entry.outerStart, entry.startTagEnd);
        newText = `${startTag}${msg.html}</${entry.tag}>`;
      }
    } else {
      if (!Array.isArray(msg.parts)) return;
      if (msg.parts.length === 0) {
        // element deletion — consume the element's whole line when possible
        const del = deletionRange(map.source, entry.outerStart, entry.outerEnd);
        rangeStart = del.start;
        rangeEnd = del.end;
        newText = '';
      } else {
        rangeStart = entry.outerStart;
        rangeEnd = entry.outerEnd;
        const joiner = '\n' + indentOf(map.source, entry.outerStart);
        newText = msg.parts.join(joiner);
      }
    }

    if (!(await this.applySelf(rangeStart, rangeEnd, newText))) {
      this.postInit();
      return;
    }

    const region = regionOf(map, entry);
    const rebuilt = rebuildAfterEdit(map, this.host.getText(), region, {
      baseHref: this.host.baseHref(),
    });
    if (!rebuilt) {
      this.postInit();
      return;
    }
    this.map = rebuilt.next;
    this.map.version = ++this.mapVersionCounter;
    this.nextIdCounter = this.map.nextId;
    this.post({
      type: 'ack',
      ids: rebuilt.freshIds,
      mapVersion: this.map.version,
    });
    this.postDirty();
  }

  /**
   * Structural op (duplicate / move / style / insertImage). The new text is
   * built from source slices, never from serialized DOM; see structOps.ts.
   * The webview has usually already rearranged its DOM, so on any failure
   * we fully re-render.
   */
  private async handleStruct(msg: any) {
    const map = this.map;
    if (!map || msg.mapVersion !== map.version) {
      this.postInit();
      return;
    }
    let op: StructOp;
    switch (msg.op) {
      case 'duplicate':
        op = { op: 'duplicate', id: String(msg.id) };
        break;
      case 'move':
        op = { op: 'move', id: String(msg.id), targetId: String(msg.targetId), before: !!msg.before };
        break;
      case 'style': {
        const props: Record<string, string | null> = {};
        for (const [k, v] of Object.entries(msg.props ?? {})) {
          if (!/^[a-z-]+$/i.test(k)) continue;
          if (v !== null && (typeof v !== 'string' || /[;"<>{}]/.test(v))) continue;
          props[k] = v as string | null;
        }
        op = { op: 'style', id: String(msg.id), props };
        break;
      }
      case 'insertImage': {
        const src = String(msg.src ?? '');
        const width = Math.round(Number(msg.width));
        if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) return this.failStruct('bad image path');
        const w = Number.isFinite(width) && width > 0 ? ` width="${width}"` : '';
        // placed at a point: absolutely positioned inside its container
        const left = Math.round(Number(msg.left));
        const top = Math.round(Number(msg.top));
        const at = Number.isFinite(left) && Number.isFinite(top)
          ? ` style="position: absolute; left: ${left}px; top: ${top}px"`
          : '';
        op = {
          op: 'insert',
          anchorId: String(msg.anchorId),
          where: msg.where === 'append' ? 'append' : 'after',
          html: `<img src="${attrEscape(src)}" alt=""${w}${at}>`,
        };
        break;
      }
      default:
        return;
    }

    const plan = planStructOp(map, op);
    if ('error' in plan) {
      // "no change" is benign: the webview made no DOM change worth undoing
      if (plan.error === 'no change' || plan.error === 'already in place') {
        this.post({ type: 'structAck', mapVersion: map.version, pairs: [], noop: true });
        return;
      }
      return this.failStruct(plan.error);
    }
    const expected = planSource(map, plan);
    if (!(await this.applyText(plan))) return this.failStruct('edit was not applied');
    if (this.host.getText() !== expected) return this.failStruct('document changed concurrently');

    const res = applyStructPlan(map, plan, expected, { baseHref: this.host.baseHref() });
    if (!res) return this.failStruct('could not verify the result');
    this.map = res.next;
    this.map.version = ++this.mapVersionCounter;
    this.nextIdCounter = this.map.nextId;

    let insertHtml: string | undefined;
    if (op.op === 'insert') {
      const pre = '<html><body>';
      const post = '</body></html>';
      const inlined = inlineResources(
        pre + instrumentFragment(op.html, res.freshIds) + post,
        this.makeResolver()
      );
      insertHtml = inlined.slice(pre.length, inlined.length - post.length);
    }
    this.post({
      type: 'structAck',
      mapVersion: this.map.version,
      pairs: res.pairs,
      insertHtml,
      styleAttr: plan.styleAttr,
    });
    this.postDirty();
  }

  private failStruct(reason: string) {
    this.post({ type: 'toast', text: `LiveDeck: ${reason} — reloaded from source` });
    this.postInit();
  }

  private applyText(plan: StructPlan): Promise<boolean> {
    return this.applySelf(plan.start, plan.end, plan.text);
  }

  // ------------------------------------------------------------- images

  private deckDir(): string | null {
    return this.host.fsPath ? path.dirname(this.host.fsPath) : null;
  }

  /** Deck-relative, URL-encoded path for an absolute file path. */
  private relSrc(abs: string): string {
    const rel = path.relative(this.deckDir()!, abs).split(path.sep).join('/');
    return rel.split('/').map(encodeURIComponent).join('/');
  }

  private async uniquePath(dir: string, base: string, ext: string): Promise<string> {
    for (let n = 1; ; n++) {
      const p = path.join(dir, `${base}${n === 1 ? '' : '-' + n}.${ext}`);
      try {
        await fs.promises.stat(p);
      } catch {
        return p;
      }
    }
  }

  private async writeImage(bytes: Uint8Array, name: string, ext: string): Promise<string> {
    const dir = path.resolve(this.deckDir()!, this.host.config().imageFolder);
    await fs.promises.mkdir(dir, { recursive: true });
    const base = name.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
    const file = await this.uniquePath(dir, base, ext);
    await fs.promises.writeFile(file, bytes);
    return file;
  }

  private imageReply(reqId: unknown, abs: string, bytes: Uint8Array, ext: string) {
    const mime = MIME_TYPES['.' + ext] ?? 'application/octet-stream';
    this.post({
      type: 'imageReady',
      reqId,
      src: this.relSrc(abs),
      dataUri: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    });
  }

  /** Pasted / dropped image bytes from the webview → file next to the deck. */
  private async handleSaveImage(msg: any) {
    const fail = (error: string) => this.post({ type: 'imageReady', reqId: msg.reqId, error });
    if (!this.deckDir()) return fail('save the deck to disk before adding images');
    const ext = EXT_FOR_MIME[String(msg.mime)] ??
      (IMAGE_EXTS.includes(String(msg.name ?? '').split('.').pop()?.toLowerCase() ?? '')
        ? String(msg.name).split('.').pop()!.toLowerCase()
        : '');
    if (!ext) return fail(`unsupported image type ${msg.mime || ''}`.trim());
    const bytes = Buffer.from(String(msg.data ?? ''), 'base64');
    if (!bytes.length || bytes.length > MAX_RESOURCE_BYTES) return fail('image is empty or too large');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    try {
      const file = await this.writeImage(bytes, msg.name ? String(msg.name) : `pasted-${stamp}`, ext);
      this.imageReply(msg.reqId, file, bytes, ext);
    } catch (err) {
      fail(`could not save image: ${(err as Error).message}`);
    }
  }

  /** "Insert image…": pick a file; copy it next to the deck unless it already lives there. */
  private async handlePickImage(msg: any) {
    const dir = this.deckDir();
    if (!dir) {
      this.post({ type: 'imageReady', reqId: msg.reqId, error: 'save the deck to disk before adding images' });
      return;
    }
    // a file dropped from the explorer arrives as a file: uri; otherwise ask
    let src: string | null = null;
    if (typeof msg.uri === 'string' && /^file:/i.test(msg.uri)) {
      try {
        src = fileURLToPath(msg.uri);
      } catch {
        src = null;
      }
    }
    if (!src) src = await this.host.pickImageFile(dir, IMAGE_EXTS);
    if (!src) {
      this.post({ type: 'imageReady', reqId: msg.reqId, cancelled: true });
      return;
    }
    const ext = path.extname(src).slice(1).toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) {
      this.post({ type: 'imageReady', reqId: msg.reqId, error: `unsupported image type .${ext}` });
      return;
    }
    try {
      const bytes = await fs.promises.readFile(src);
      if (bytes.length > MAX_RESOURCE_BYTES) throw new Error('image is too large');
      const rel = path.relative(dir, src);
      const inside = !rel.startsWith('..') && !path.isAbsolute(rel);
      const file = inside ? src : await this.writeImage(bytes, path.basename(src), ext);
      this.imageReply(msg.reqId, file, bytes, ext);
    } catch (err) {
      this.post({ type: 'imageReady', reqId: msg.reqId, error: (err as Error).message });
    }
  }

  /** Open the source beside the deck with the element's start tag selected. */
  private async reveal(id: unknown) {
    const entry = this.map?.byId.get(String(id));
    if (!entry || entry.outerStart < 0) {
      this.post({ type: 'toast', text: 'No source location for this element' });
      return;
    }
    const end = entry.startTagEnd >= 0 ? entry.startTagEnd : entry.outerEnd;
    await this.host.reveal(entry.outerStart, end);
  }

  // ---------------------------------------------------------- selection

  /**
   * The shell's current selection (or the element being edited), published
   * for coding agents: `livedeck mcp`'s get_selection tool reads it, so
   * "tighten this" in Claude Code / Codex targets what was clicked.
   */
  private handleSelection(msg: any) {
    const file = this.host.fsPath;
    const map = this.map;
    if (!file || !map || msg.mapVersion !== map.version) return;
    const items: SelectionItem[] = [];
    for (const sel of Array.isArray(msg.items) ? msg.items : []) {
      const entry = map.byId.get(String(sel?.id));
      if (!entry || entry.outerStart < 0) continue;
      const slide = Number(sel.slide);
      items.push({
        tag: entry.tag,
        start: entry.outerStart,
        end: entry.outerEnd,
        html: map.source.slice(entry.outerStart, entry.outerEnd),
        slide: Number.isInteger(slide) && slide > 0 ? slide : null,
        editing: !!sel.editing,
      });
    }
    try {
      writeSelection(file, items);
    } catch (err) {
      console.log('[livedeck] could not write selection:', (err as Error).message);
    }
  }

  // ------------------------------------------------------- AI this element

  /**
   * Ask Claude to rewrite one element. The reply replaces that element's
   * source range — its inner range when the start tag is unchanged, so the
   * in-place patch path updates just that element in the live DOM.
   */
  private async handleAiEdit(msg: any) {
    const done = (ok: boolean, message: string) =>
      this.post({ type: 'aiDone', reqId: msg.reqId, ok, message });
    const map = this.map;
    const entry = map?.byId.get(String(msg.id));
    const instruction = String(msg.instruction ?? '').trim();
    if (!map || !entry || entry.outerStart < 0) return done(false, 'No source location for this element');
    if (!instruction) return done(false, 'Type an instruction first');

    const elementHtml = map.source.slice(entry.outerStart, entry.outerEnd);
    const slide = msg.slideId ? map.byId.get(String(msg.slideId)) : undefined;
    const slideHtml =
      slide && slide !== entry && slide.outerStart >= 0 && slide.outerStart <= entry.outerStart
        ? map.source.slice(slide.outerStart, slide.outerEnd)
        : null;
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(map.source)?.[1]?.trim() ?? '';

    const client = await this.host.anthropicClient();
    if ('error' in client) return done(false, client.error);
    this.aiAbort?.abort();
    const abort = new AbortController();
    this.aiAbort = abort;

    let result;
    try {
      result = await runAiEdit(client, { instruction, elementHtml, slideHtml, deckTitle: title }, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) return done(false, 'Cancelled');
      if (err instanceof Anthropic.AuthenticationError) return done(false, await this.host.onAuthError());
      if (err instanceof Anthropic.RateLimitError) return done(false, 'Rate limited — try again shortly');
      if (err instanceof Anthropic.APIError) return done(false, `API error ${err.status ?? ''}: ${err.message}`);
      return done(false, `AI request failed: ${(err as Error).message}`);
    } finally {
      if (this.aiAbort === abort) this.aiAbort = null;
    }
    if ('message' in result) return done(false, result.message);
    const invalid = validateReplacement(result.html);
    if (invalid) return done(false, `Not applied: ${invalid}`);

    // The element may have moved or changed while the model was working.
    const now = this.map?.byId.get(entry.id);
    const text = this.host.getText();
    if (!now || text.slice(now.outerStart, now.outerEnd) !== elementHtml) {
      return done(false, 'The element changed while AI was working — not applied');
    }
    const startTag = text.slice(now.outerStart, now.startTagEnd);
    const sameStart = now.innerStart >= 0 && result.html.startsWith(startTag) &&
      result.html.endsWith(`</${now.tag}>`);
    const [from, to, newText] = sameStart
      ? [now.innerStart, now.innerEnd, result.html.slice(startTag.length, result.html.length - `</${now.tag}>`.length)]
      : [now.outerStart, now.outerEnd, result.html];
    if (text.slice(from, to) === newText) return done(true, 'AI made no changes');

    // Applied like any external edit: the change listener patches the
    // element in place (or re-renders when the change crosses its bounds).
    if (!(await this.host.replace(from, to, newText))) return done(false, 'Edit was not applied');
    done(true, 'AI edit applied — ⌘Z to undo');
  }
}
