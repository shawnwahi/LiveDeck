/**
 * The deck selection, published for coding agents.
 *
 * Every open deck writes what is selected (or being edited) in its editor to
 * ~/.livedeck/selection/<hash of path>.json — outside the user's project, so
 * nothing lands in their repo. `livedeck mcp` reads it back for the agent and
 * re-anchors each item against the file as it is now: offsets go stale as
 * soon as anything above the element changes.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SelectionItem {
  tag: string;
  /** outer source range of the element when it was selected */
  start: number;
  end: number;
  /** the element's exact source (outerHTML as written in the file) */
  html: string;
  /** 1-based slide number, when the deck has detectable slides */
  slide: number | null;
  /** true when this is the text element being edited, not a selection */
  editing: boolean;
}

export interface SelectionFile {
  file: string;
  updatedAt: string;
  items: SelectionItem[];
}

export function selectionDir(): string {
  return process.env.LIVEDECK_HOME
    ? path.join(process.env.LIVEDECK_HOME, 'selection')
    : path.join(os.homedir(), '.livedeck', 'selection');
}

function selectionPath(deckFile: string): string {
  const hash = crypto.createHash('sha1').update(path.resolve(deckFile)).digest('hex').slice(0, 16);
  return path.join(selectionDir(), `${hash}.json`);
}

export function writeSelection(deckFile: string, items: SelectionItem[]) {
  const data: SelectionFile = {
    file: path.resolve(deckFile),
    updatedAt: new Date().toISOString(),
    items,
  };
  fs.mkdirSync(selectionDir(), { recursive: true });
  const target = selectionPath(deckFile);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

/** All published selections, most recently updated first. */
export function readSelections(): SelectionFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(selectionDir()).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: SelectionFile[] = [];
  for (const n of names) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(selectionDir(), n), 'utf8'));
      if (typeof data?.file === 'string' && Array.isArray(data.items)) out.push(data);
    } catch {
      /* half-written or foreign file */
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export type Anchored =
  | { status: 'current'; start: number; end: number }
  | { status: 'moved'; start: number; end: number }
  | { status: 'stale' };

/**
 * Where `item` is in `text` now: at its recorded offsets, or — if text above
 * it changed — at the one place its exact source still occurs. Ambiguous or
 * missing means stale: the element was edited, or duplicated, since.
 */
export function anchor(item: SelectionItem, text: string): Anchored {
  if (text.slice(item.start, item.end) === item.html) {
    return { status: 'current', start: item.start, end: item.end };
  }
  const first = text.indexOf(item.html);
  if (first < 0 || text.indexOf(item.html, first + 1) >= 0) return { status: 'stale' };
  return { status: 'moved', start: first, end: first + item.html.length };
}

/** 1-based line and column of an offset, for agents that edit by line. */
export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    last = i;
  }
  return { line, column: offset - last };
}
