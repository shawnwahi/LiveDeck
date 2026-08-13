/**
 * Inline local resources (images, stylesheets, fonts, scripts) as data: URIs
 * in the *rendered* copy of a deck.
 *
 * Why: webview service-worker resource loading (vscode-resource URIs) does
 * not reliably reach documents nested inside the webview, so relative
 * `src="assets/x.png"` references render as broken images. data: URIs render
 * unconditionally. The user's file is never touched — inlining happens on the
 * instrumented markup only, and every rewritten attribute on a <body> element
 * gets a `data-ld-orig-*` twin so the webview restores the original value
 * when serializing an edit back to the file. Head elements are never part of
 * an editable region, so they are rewritten without stamps.
 */
import { parse } from 'parse5';

export interface ResolvedResource {
  mime: string;
  data: Uint8Array;
}

/** Resolve a deck-relative URL to file contents, or null if unavailable. */
export type ResourceResolver = (url: string) => ResolvedResource | null;

interface Splice {
  start: number;
  end: number;
  text: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type P5Node = any;

/** URLs we must not rewrite: absolute, protocol-relative, fragments, empty. */
const SKIP_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|$)/i;

function toDataUri(r: ResolvedResource): string {
  return `data:${r.mime};base64,${Buffer.from(r.data).toString('base64')}`;
}

function attrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Directory prefix of a deck-relative path ('styles/m.css' → 'styles/'). */
function dirPrefix(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i + 1) : '';
}

/**
 * Rewrite url(...) references in CSS text to data: URIs. `prefix` is the
 * directory of the CSS text itself relative to the deck, so refs inside a
 * stylesheet resolve from the stylesheet's location.
 */
export function rewriteCssUrls(css: string, resolve: ResourceResolver, prefix = ''): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (match, _q, url) => {
    const u = String(url).trim();
    if (SKIP_URL.test(u)) return match;
    const r = resolve(prefix + u);
    return r ? `url('${toDataUri(r)}')` : match;
  });
}

const URL_ATTRS: Record<string, string[]> = {
  img: ['src'],
  source: ['src'],
  video: ['src', 'poster'],
  audio: ['src'],
  embed: ['src'],
  script: ['src'],
  image: ['href', 'xlink:href'], // svg <image>
  use: ['href', 'xlink:href'],
};

export function inlineResources(html: string, resolve: ResourceResolver): string {
  const doc: P5Node = parse(html, { sourceCodeLocationInfo: true });
  const splices: Splice[] = [];

  const process = (el: P5Node, inBody: boolean) => {
    const loc = el.sourceCodeLocation;
    const startTag = loc?.startTag;
    if (!startTag) return;
    const attrLocs = loc.attrs ?? startTag.attrs ?? {};
    const tag = String(el.tagName).toLowerCase();
    const getAttr = (n: string) => el.attrs?.find((a: P5Node) => a.name === n)?.value;
    const stamps: string[] = [];

    const replaceAttr = (name: string, value: string): boolean => {
      const al = attrLocs[name];
      if (!al) return false;
      splices.push({
        start: al.startOffset,
        end: al.endOffset,
        text: `${name}="${attrEscape(value)}"`,
      });
      return true;
    };

    const stamp = (name: string, original: string) => {
      if (inBody) stamps.push(` data-ld-orig-${name}="${attrEscape(original)}"`);
    };

    const inlineUrlAttr = (name: string, transform?: (r: ResolvedResource) => string) => {
      const v = getAttr(name);
      if (typeof v !== 'string' || SKIP_URL.test(v.trim())) return;
      const r = resolve(v.trim());
      if (!r) return;
      const uri = transform ? transform(r) : toDataUri(r);
      if (replaceAttr(name, uri)) stamp(name.replace(/^xlink:/, 'xlink-'), v);
    };

    for (const name of URL_ATTRS[tag] ?? []) inlineUrlAttr(name);

    if (tag === 'img' || tag === 'source') {
      // data: URIs contain commas, which break srcset's comma-separated
      // syntax — blank it out and let the rewritten src win.
      const srcset = getAttr('srcset');
      if (typeof srcset === 'string' && srcset && !SKIP_URL.test(srcset.trim())) {
        if (replaceAttr('srcset', '')) stamp('srcset', srcset);
      }
    }

    if (tag === 'link') {
      const rel = (getAttr('rel') ?? '').toLowerCase();
      if (/\bstylesheet\b/.test(rel)) {
        const href = getAttr('href');
        inlineUrlAttr('href', (r) => {
          // refs inside the stylesheet resolve from the stylesheet's dir
          const css = Buffer.from(r.data).toString('utf8');
          const rewritten = rewriteCssUrls(css, resolve, dirPrefix(String(href).trim()));
          return `data:text/css;base64,${Buffer.from(rewritten, 'utf8').toString('base64')}`;
        });
      } else if (/\bicon\b/.test(rel)) {
        inlineUrlAttr('href');
      }
    }

    if (tag === 'style' && startTag && loc.endTag) {
      const css = html.slice(startTag.endOffset, loc.endTag.startOffset);
      const rewritten = rewriteCssUrls(css, resolve);
      if (rewritten !== css) {
        splices.push({ start: startTag.endOffset, end: loc.endTag.startOffset, text: rewritten });
        stamp('css', css);
      }
    }

    const styleAttr = getAttr('style');
    if (typeof styleAttr === 'string' && /url\(/i.test(styleAttr)) {
      const rewritten = rewriteCssUrls(styleAttr, resolve);
      if (rewritten !== styleAttr && replaceAttr('style', rewritten)) stamp('style', styleAttr);
    }

    if (stamps.length) {
      const selfClosing = html.slice(startTag.endOffset - 2, startTag.endOffset) === '/>';
      const pos = selfClosing ? startTag.endOffset - 2 : startTag.endOffset - 1;
      splices.push({ start: pos, end: pos, text: stamps.join('') });
    }
  };

  const visit = (node: P5Node, inBody: boolean) => {
    for (const c of node.childNodes ?? []) {
      if (!c.tagName) continue;
      const childInBody = inBody || c.tagName === 'body';
      process(c, childInBody && c.tagName !== 'body');
      if (c.tagName !== 'template') visit(c, childInBody);
    }
  };
  visit(doc, false);

  // Apply back-to-front; an insertion at an attr's end offset must land after
  // that attr's replacement, which sorting by descending start guarantees.
  splices.sort((a, b) => b.start - a.start);
  let out = html;
  for (const s of splices) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
}
