/**
 * The deck file as the standalone server sees it: text in memory, every edit
 * written straight to disk (coding agents read the file, so an unsaved buffer
 * would hide edits from them), its own undo/redo, and a watcher that turns
 * other writers' changes (an agent, git, an editor) into change events.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Disposable, TextChange } from '../deckSession';

interface UndoEntry {
  start: number;
  oldText: string;
  newText: string;
}

const BOM = '﻿';

/** Smallest single range that turns `a` into `b`: [start, endA) of a → [start, endB) of b. */
export function diffRange(a: string, b: string): { start: number; endA: number; endB: number } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { start, endA, endB };
}

export class FileDocument {
  private text: string;
  private bom: boolean;
  private readonly undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  /** An outside change cut the undo history; tell the user when they reach it. */
  private historyCut = false;
  private readonly listeners = new Set<(changes: TextChange[]) => void>();
  private watcher: fs.FSWatcher | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly file: string) {
    const raw = fs.readFileSync(file, 'utf8');
    this.bom = raw.startsWith(BOM);
    this.text = this.bom ? raw.slice(1) : raw;
  }

  getText() {
    return this.text;
  }

  onDidChange(cb: (changes: TextChange[]) => void): Disposable {
    this.listeners.add(cb);
    return { dispose: () => this.listeners.delete(cb) };
  }

  private emit(changes: TextChange[]) {
    for (const cb of [...this.listeners]) cb(changes);
  }

  private write() {
    fs.writeFileSync(this.file, (this.bom ? BOM : '') + this.text);
  }

  private splice(start: number, end: number, text: string) {
    this.text = this.text.slice(0, start) + text + this.text.slice(end);
    this.write();
    this.emit([{ start, end }]);
  }

  /** Replace [start, end) as one undo step; written to disk immediately. */
  replace(start: number, end: number, text: string): boolean {
    if (start < 0 || end < start || end > this.text.length) return false;
    this.undoStack.push({ start, oldText: this.text.slice(start, end), newText: text });
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack = [];
    this.splice(start, end, text);
    return true;
  }

  /**
   * Undo our last edit. Edits made by others are not on the stack; if one
   * touched the range we would revert, refuse rather than guess.
   */
  undo(): 'ok' | 'empty' | 'conflict' {
    const e = this.undoStack.pop();
    if (!e) {
      if (!this.historyCut) return 'empty';
      this.historyCut = false;
      return 'conflict';
    }
    if (this.text.slice(e.start, e.start + e.newText.length) !== e.newText) {
      this.undoStack.length = 0;
      return 'conflict';
    }
    this.redoStack.push(e);
    this.splice(e.start, e.start + e.newText.length, e.oldText);
    return 'ok';
  }

  redo(): 'ok' | 'empty' | 'conflict' {
    const e = this.redoStack.pop();
    if (!e) return 'empty';
    if (this.text.slice(e.start, e.start + e.oldText.length) !== e.oldText) {
      this.redoStack = [];
      return 'conflict';
    }
    this.undoStack.push(e);
    this.splice(e.start, e.start + e.oldText.length, e.newText);
    return 'ok';
  }

  /** Pick up a change someone else wrote to the file. */
  checkDisk() {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {
      return; // mid-rename by an atomic writer; the next event catches it
    }
    this.bom = raw.startsWith(BOM);
    const next = this.bom ? raw.slice(1) : raw;
    const d = diffRange(this.text, next);
    if (!d) return; // our own write, or no-op
    this.text = next;
    this.rebaseHistory(d);
    this.emit([{ start: d.start, end: d.endA }]);
  }

  /**
   * Keep our undo steps usable across someone else's change: shift each step
   * the change sits before, walking down the stack (each step's offsets are
   * in the text as it was right after that step). The first step the change
   * overlaps, and everything older, is dropped rather than reverted over it.
   * Redo is cleared, as after any new edit.
   */
  private rebaseHistory(d: { start: number; endA: number; endB: number }) {
    const delta = d.endB - d.endA;
    let start = d.start;
    let end = d.endA;
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const e = this.undoStack[i];
      if (end <= e.start) {
        e.start += delta;
      } else if (start >= e.start + e.newText.length) {
        // map the change back to before this step
        const shift = e.oldText.length - e.newText.length;
        start += shift;
        end += shift;
      } else {
        this.undoStack.splice(0, i + 1);
        this.historyCut = true;
        break;
      }
    }
    this.redoStack = [];
  }

  /** Watch the directory, not the file: atomic writers replace the inode. */
  watch() {
    const name = path.basename(this.file);
    this.watcher = fs.watch(path.dirname(this.file), (_event, changed) => {
      if (changed && changed.toString() !== name) return;
      clearTimeout(this.checkTimer);
      this.checkTimer = setTimeout(() => this.checkDisk(), 50);
    });
  }

  dispose() {
    clearTimeout(this.checkTimer);
    this.watcher?.close();
    this.listeners.clear();
  }
}
