/**
 * The editor shell page (toolbar, overlay, popups) that hosts media/shell.js.
 * Shared by the VS Code webview and the standalone `livedeck serve` page;
 * the hosts differ only in how media URLs and the CSP source are spelled.
 */

export interface ShellHtmlOptions {
  /** URL of a file in media/ */
  media(file: string): string;
  /** CSP source allowed for local resources (webview.cspSource, or 'self') */
  cspSource: string;
  /** scripts loaded before shell.js (the standalone host's bridge) */
  preScripts?: string[];
  /** toolbar buttons this host has no use for */
  hide?: Array<'save' | 'source'>;
}

export function shellHtml(opts: ShellHtmlOptions): string {
  const hide = (b: 'save' | 'source') => (opts.hide?.includes(b) ? ' hidden' : '');
  // The deck iframe inherits this CSP. Decks routinely use inline scripts,
  // CDN libraries, Google Fonts and data-URI images, so it is deliberately
  // permissive for a local authoring tool. 'unsafe-inline' means no nonce —
  // a nonce would disable unsafe-inline and break deck inline scripts.
  const src = opts.cspSource;
  const csp = [
    `default-src 'none'`,
    `img-src ${src} https: http: data: blob:`,
    `media-src ${src} https: data: blob:`,
    `script-src ${src} https: data: 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${src} https: data: 'unsafe-inline'`,
    `font-src ${src} https: data:`,
    `connect-src ${src} https: data: blob:`,
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
<link rel="stylesheet" href="${opts.media('shell.css')}">
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
  <button id="btn-save" title="Save (⌘S)"${hide('save')}>Save</button>
  <button id="btn-src" title="Open the HTML source beside this editor"${hide('source')}>Source</button>
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
${(opts.preScripts ?? []).map((s) => `<script src="${s}"></script>`).join('')}
<script src="${opts.media('shell.js')}"></script>
</body>
</html>`;
}
