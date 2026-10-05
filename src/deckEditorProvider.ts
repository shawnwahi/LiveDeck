import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
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

export const API_KEY_SECRET = 'livedeck.anthropicApiKey';

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
};

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

export class DeckEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = 'livedeck.editor';

  public static register(ctx: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      DeckEditorProvider.viewType,
      new DeckEditorProvider(ctx),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
    const roots = [
      vscode.Uri.joinPath(this.ctx.extensionUri, 'media'),
      ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
    ];
    if (document.uri.scheme === 'file') {
      roots.push(docDir, vscode.Uri.file(path.dirname(docDir.fsPath)));
    }
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = this.shellHtml(panel.webview);

    new DeckSession(document, panel, this.ctx);
  }

  private shellHtml(webview: vscode.Webview): string {
    const media = (f: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    // The deck iframe inherits this CSP. Decks routinely use inline scripts,
    // CDN libraries, Google Fonts and data-URI images, so it is deliberately
    // permissive for a local authoring tool. 'unsafe-inline' means no nonce —
    // a nonce would disable unsafe-inline and break deck inline scripts.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: http: data: blob:`,
      `media-src ${webview.cspSource} https: data: blob:`,
      `script-src ${webview.cspSource} https: data: 'unsafe-inline' 'unsafe-eval'`,
      `style-src ${webview.cspSource} https: data: 'unsafe-inline'`,
      `font-src ${webview.cspSource} https: data:`,
      `connect-src ${webview.cspSource} https: data: blob:`,
    ].join('; ');

    const icon = {
      ul: `<svg viewBox="0 0 16 16"><circle cx="2.5" cy="3.5" r="1.4"/><rect x="6" y="2.7" width="9" height="1.6" rx="0.8"/><circle cx="2.5" cy="8" r="1.4"/><rect x="6" y="7.2" width="9" height="1.6" rx="0.8"/><circle cx="2.5" cy="12.5" r="1.4"/><rect x="6" y="11.7" width="9" height="1.6" rx="0.8"/></svg>`,
      ol: `<svg viewBox="0 0 16 16"><text x="0.5" y="5.4" font-size="6" font-family="monospace">1</text><rect x="6" y="2.7" width="9" height="1.6" rx="0.8"/><text x="0.5" y="9.9" font-size="6" font-family="monospace">2</text><rect x="6" y="7.2" width="9" height="1.6" rx="0.8"/><text x="0.5" y="14.4" font-size="6" font-family="monospace">3</text><rect x="6" y="11.7" width="9" height="1.6" rx="0.8"/></svg>`,
      outdent: `<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="1.6" rx="0.8"/><path d="M4.5 8 L1 8 M2.8 6.2 L1 8 L2.8 9.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="7" y="7.2" width="8" height="1.6" rx="0.8"/><rect x="1" y="12.4" width="14" height="1.6" rx="0.8"/></svg>`,
      indent: `<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="1.6" rx="0.8"/><path d="M1 8 L4.5 8 M2.7 6.2 L4.5 8 L2.7 9.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="7" y="7.2" width="8" height="1.6" rx="0.8"/><rect x="1" y="12.4" width="14" height="1.6" rx="0.8"/></svg>`,
      alignleft: `<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="1.6" rx="0.8"/><rect x="1" y="5.5" width="9" height="1.6" rx="0.8"/><rect x="1" y="9" width="14" height="1.6" rx="0.8"/><rect x="1" y="12.5" width="9" height="1.6" rx="0.8"/></svg>`,
      aligncenter: `<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="1.6" rx="0.8"/><rect x="3.5" y="5.5" width="9" height="1.6" rx="0.8"/><rect x="1" y="9" width="14" height="1.6" rx="0.8"/><rect x="3.5" y="12.5" width="9" height="1.6" rx="0.8"/></svg>`,
      alignright: `<svg viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="1.6" rx="0.8"/><rect x="6" y="5.5" width="9" height="1.6" rx="0.8"/><rect x="1" y="9" width="14" height="1.6" rx="0.8"/><rect x="6" y="12.5" width="9" height="1.6" rx="0.8"/></svg>`,
      link: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.5 9.5 L9.5 6.5"/><path d="M7.5 4.5 L9 3 a2.8 2.8 0 0 1 4 4 L11.5 8.5"/><path d="M8.5 11.5 L7 13 a2.8 2.8 0 0 1 -4 -4 L4.5 7.5"/></svg>`,
      undo: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 L2.5 7 L6 10.5"/><path d="M2.5 7 H10 a3.5 3.5 0 0 1 0 7 H7"/></svg>`,
      redo: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 L13.5 7 L10 10.5"/><path d="M13.5 7 H6 a3.5 3.5 0 0 0 0 7 H9"/></svg>`,
      fit: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 H2 V6"/><path d="M10 2 H14 V6"/><path d="M6 14 H2 V10"/><path d="M10 14 H14 V10"/></svg>`,
    };

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${media('shell.css')}">
</head>
<body>
<header id="toolbar">
  <div class="tb-group" data-needs-edit>
    <button data-cmd="bold" title="Bold (⌘B)"><span class="glyph gb">B</span></button>
    <button data-cmd="italic" title="Italic (⌘I)"><span class="glyph gi">I</span></button>
    <button data-cmd="underline" title="Underline (⌘U)"><span class="glyph gu">U</span></button>
    <button data-cmd="strike" title="Strikethrough"><span class="glyph gs">S</span></button>
    <button data-cmd="code" title="Inline code"><span class="glyph gm">&lt;/&gt;</span></button>
    <button data-cmd="link" title="Link (⌘K)">${icon.link}</button>
    <button data-cmd="clear" title="Clear formatting"><span class="glyph">T<sub>✕</sub></span></button>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-group" data-needs-edit>
    <button data-cmd="ul" title="Bulleted list">${icon.ul}</button>
    <button data-cmd="ol" title="Numbered list">${icon.ol}</button>
    <button data-cmd="outdent" title="Outdent (⇧Tab)">${icon.outdent}</button>
    <button data-cmd="indent" title="Indent (Tab)">${icon.indent}</button>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-group" data-needs-edit>
    <button data-cmd="alignleft" title="Align left">${icon.alignleft}</button>
    <button data-cmd="aligncenter" title="Align center">${icon.aligncenter}</button>
    <button data-cmd="alignright" title="Align right">${icon.alignright}</button>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-group">
    <button data-cmd="undo" title="Undo (⌘Z)">${icon.undo}</button>
    <button data-cmd="redo" title="Redo (⇧⌘Z)">${icon.redo}</button>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-group">
    <button id="slide-prev" title="Previous slide (PgUp)">‹</button>
    <span id="slide-ind">–</span>
    <button id="slide-next" title="Next slide (PgDn)">›</button>
  </div>
  <div class="tb-sep"></div>
  <div class="tb-group">
    <button id="zoom-out" title="Zoom out">−</button>
    <button id="zoom-ind" title="Reset zoom">100%</button>
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="zoom-fit" title="Fit width">${icon.fit}</button>
  </div>
  <span id="crumb"></span>
  <div class="tb-spacer"></div>
  <span id="dirty-dot" title="Unsaved changes" hidden>●</span>
  <button id="btn-save" title="Save (⌘S)">Save</button>
  <button id="btn-src" title="Open the HTML source beside this editor">Source</button>
  <button id="btn-browser" title="Open in external browser">Browser</button>
</header>
<div id="link-pop" hidden>
  <input id="link-url" type="text" placeholder="https://…" spellcheck="false">
  <button id="link-apply">Apply</button>
  <button id="link-remove">Remove</button>
</div>
<div id="frame-holder">
  <div id="splash">Loading deck…</div>
  <div id="overlay">
    <div id="sel-box" hidden>
      <div class="h" data-dir="w" title="Drag to resize"></div>
      <div class="h" data-dir="e" title="Drag to resize"></div>
      <div class="h" data-dir="s" title="Drag to resize"></div>
      <div class="h" data-dir="se" title="Drag to resize"></div>
    </div>
    <div id="drop-ind" hidden></div>
    <div id="marquee" hidden></div>
  </div>
</div>
<div id="ctx-menu" role="menu" hidden></div>
<div id="ai-pop" hidden>
  <div class="ai-head"><span>AI this element <span id="ai-target"></span></span><button id="ai-close" title="Close (Esc)">✕</button></div>
  <textarea id="ai-input" rows="3" spellcheck="true" placeholder="e.g. tighten the phrasing · add a citation for this claim · make this two bullets"></textarea>
  <div class="ai-foot"><span id="ai-status"></span><button id="ai-run">Run ↵</button></div>
</div>
<div id="toast" hidden></div>
<script src="${media('shell.js')}"></script>
</body>
</html>`;
  }
}

class DeckSession {
  private map: DeckMap | null = null;
  private mapVersionCounter = 0;
  private nextIdCounter = 1;
  private applyingSelfEdit = false;
  private externalReloadTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private aiAbort: AbortController | null = null;

  constructor(
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly ctx: vscode.ExtensionContext
  ) {
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== document.uri.toString()) return;
        this.postDirty();
        if (this.applyingSelfEdit) return;
        if (e.contentChanges.length === 0) return;
        if (!this.tryPatch(e)) this.scheduleExternalReload();
      }),
      vscode.workspace.onDidSaveTextDocument((d) => {
        if (d.uri.toString() === document.uri.toString()) this.postDirty();
      })
    );
    panel.onDidDispose(() => {
      clearTimeout(this.externalReloadTimer);
      this.disposables.forEach((d) => d.dispose());
    });
  }

  private readonly resourceCache = new Map<
    string,
    { mtimeMs: number; res: ResolvedResource | null }
  >();

  /** Resolve deck-relative URLs to file contents for data:-URI inlining. */
  private makeResolver(): ResourceResolver {
    if (this.document.uri.scheme !== 'file') return () => null;
    const dir = path.dirname(this.document.uri.fsPath);
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
            mime: MIME_TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream',
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

  private get baseHref(): string {
    if (this.document.uri.scheme !== 'file') return '';
    const dir = vscode.Uri.file(path.dirname(this.document.uri.fsPath));
    return this.panel.webview.asWebviewUri(dir).toString() + '/';
  }

  private config() {
    const c = vscode.workspace.getConfiguration('livedeck', this.document.uri);
    return {
      slideSelectors: c.get<string[]>('slideSelectors') ?? [],
      editDebounceMs: c.get<number>('editDebounceMs') ?? 400,
      pastePlainText: c.get<boolean>('pastePlainText') ?? true,
      normalizeMarkup: c.get<boolean>('normalizeMarkup') ?? true,
    };
  }

  private imageFolder(): string {
    const c = vscode.workspace.getConfiguration('livedeck', this.document.uri);
    return c.get<string>('imageFolder') ?? 'images';
  }

  private post(msg: unknown) {
    void this.panel.webview.postMessage(msg);
  }

  private postDirty() {
    this.post({ type: 'dirty', dirty: this.document.isDirty });
  }

  /** Build a fresh map and (re)render the deck in the webview. */
  private postInit() {
    this.map = buildDeck(this.document.getText(), {
      baseHref: this.baseHref,
      version: ++this.mapVersionCounter,
      startId: this.nextIdCounter,
    });
    this.nextIdCounter = this.map.nextId;
    this.post({
      type: 'init',
      html: inlineResources(this.map.instrumented, this.makeResolver()),
      mapVersion: this.map.version,
      config: this.config(),
    });
    this.postDirty();
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
  private tryPatch(e: vscode.TextDocumentChangeEvent): boolean {
    const map = this.map;
    if (!map || this.externalReloadTimer !== undefined) return false;
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of e.contentChanges) {
      lo = Math.min(lo, c.rangeOffset);
      hi = Math.max(hi, c.rangeOffset + c.rangeLength);
    }
    if (!Number.isFinite(lo)) return false;
    const target = deepestContaining(map, lo, hi);
    if (!target) return false;

    const rebuilt = rebuildAfterEdit(map, this.document.getText(), regionOf(map, target), {
      baseHref: this.baseHref,
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

  private async onMessage(msg: any) {
    switch (msg?.type) {
      case 'ready':
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
      case 'requestReload':
        this.postInit();
        break;
      case 'undo':
        await vscode.commands.executeCommand('undo');
        break;
      case 'redo':
        await vscode.commands.executeCommand('redo');
        break;
      case 'save':
        await vscode.commands.executeCommand('workbench.action.files.save');
        break;
      case 'openSource':
        await vscode.commands.executeCommand(
          'vscode.openWith',
          this.document.uri,
          'default',
          vscode.ViewColumn.Beside
        );
        break;
      case 'openBrowser':
        if (this.document.uri.scheme === 'file') {
          await vscode.env.openExternal(this.document.uri);
        }
        break;
      case 'clipboardWrite':
        if (typeof msg.text === 'string') await vscode.env.clipboard.writeText(msg.text);
        this.post({ type: 'clipboardText', reqId: msg.reqId });
        break;
      case 'clipboardRead':
        this.post({ type: 'clipboardText', reqId: msg.reqId, text: await vscode.env.clipboard.readText() });
        break;
      case 'openExternal':
        if (typeof msg.url === 'string' && /^https?:/i.test(msg.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        }
        break;
      case 'log':
        console.log('[livedeck webview]', msg.text);
        break;
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

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.document.uri,
      new vscode.Range(
        this.document.positionAt(rangeStart),
        this.document.positionAt(rangeEnd)
      ),
      newText
    );

    this.applyingSelfEdit = true;
    let ok = false;
    try {
      ok = await vscode.workspace.applyEdit(edit);
    } finally {
      this.applyingSelfEdit = false;
    }
    if (!ok) {
      this.postInit();
      return;
    }

    const region = regionOf(map, entry);
    const rebuilt = rebuildAfterEdit(map, this.document.getText(), region, {
      baseHref: this.baseHref,
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
    if (this.document.getText() !== expected) return this.failStruct('document changed concurrently');

    const res = applyStructPlan(map, plan, expected, { baseHref: this.baseHref });
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

  private async applyText(plan: StructPlan): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.document.uri,
      new vscode.Range(this.document.positionAt(plan.start), this.document.positionAt(plan.end)),
      plan.text
    );
    this.applyingSelfEdit = true;
    try {
      return await vscode.workspace.applyEdit(edit);
    } finally {
      this.applyingSelfEdit = false;
    }
  }

  // ------------------------------------------------------------- images

  private deckDir(): string | null {
    return this.document.uri.scheme === 'file' ? path.dirname(this.document.uri.fsPath) : null;
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
        await vscode.workspace.fs.stat(vscode.Uri.file(p));
      } catch {
        return p;
      }
    }
  }

  private async writeImage(bytes: Uint8Array, name: string, ext: string): Promise<string> {
    const dir = path.resolve(this.deckDir()!, this.imageFolder());
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
    const base = name.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
    const file = await this.uniquePath(dir, base, ext);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(file), bytes);
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
    // a file dropped from the explorer arrives as a uri; otherwise ask
    const dropped = typeof msg.uri === 'string' ? vscode.Uri.parse(msg.uri) : null;
    const picked = dropped?.scheme === 'file'
      ? [dropped]
      : await vscode.window.showOpenDialog({
          canSelectMany: false,
          defaultUri: vscode.Uri.file(dir),
          filters: { Images: IMAGE_EXTS },
          openLabel: 'Insert image',
        });
    if (!picked?.length) {
      this.post({ type: 'imageReady', reqId: msg.reqId, cancelled: true });
      return;
    }
    const src = picked[0].fsPath;
    const ext = path.extname(src).slice(1).toLowerCase();
    if (!IMAGE_EXTS.includes(ext)) {
      this.post({ type: 'imageReady', reqId: msg.reqId, error: `unsupported image type .${ext}` });
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
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
    await vscode.window.showTextDocument(this.document, {
      viewColumn: vscode.ViewColumn.Beside,
      selection: new vscode.Range(
        this.document.positionAt(entry.outerStart),
        this.document.positionAt(end)
      ),
    });
  }

  // ------------------------------------------------------- AI this element

  private async anthropicClient(): Promise<Anthropic | null> {
    let key = await this.ctx.secrets.get(API_KEY_SECRET);
    if (!key && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      key = await vscode.window.showInputBox({
        title: 'LiveDeck: Anthropic API key',
        prompt: 'Needed for "AI this element". Stored in VS Code secret storage.',
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return null;
      await this.ctx.secrets.store(API_KEY_SECRET, key.trim());
    }
    return key ? new Anthropic({ apiKey: key.trim() }) : new Anthropic();
  }

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

    const client = await this.anthropicClient();
    if (!client) return done(false, 'No API key — cancelled');
    this.aiAbort?.abort();
    const abort = new AbortController();
    this.aiAbort = abort;

    let result;
    try {
      result = await runAiEdit(client, { instruction, elementHtml, slideHtml, deckTitle: title }, abort.signal);
    } catch (err) {
      if (abort.signal.aborted) return done(false, 'Cancelled');
      if (err instanceof Anthropic.AuthenticationError) {
        await this.ctx.secrets.delete(API_KEY_SECRET);
        return done(false, 'Invalid API key — run the command again to enter a new one');
      }
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
    const text = this.document.getText();
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

    // Applied like any external edit: onDidChangeTextDocument patches the
    // element in place (or re-renders when the change crosses its bounds).
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      this.document.uri,
      new vscode.Range(this.document.positionAt(from), this.document.positionAt(to)),
      newText
    );
    if (!(await vscode.workspace.applyEdit(edit))) return done(false, 'Edit was not applied');
    done(true, 'AI edit applied — ⌘Z to undo');
  }
}
