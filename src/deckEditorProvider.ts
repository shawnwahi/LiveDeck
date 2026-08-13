import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  buildDeck,
  rebuildAfterEdit,
  regionOf,
  indentOf,
  deepestContaining,
  DeckMap,
} from './sourceMap';
import { inlineResources, ResourceResolver, ResolvedResource } from './resources';

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
      if (!Array.isArray(msg.parts) || msg.parts.length === 0) return;
      rangeStart = entry.outerStart;
      rangeEnd = entry.outerEnd;
      const joiner = '\n' + indentOf(map.source, entry.outerStart);
      newText = msg.parts.join(joiner);
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
}
