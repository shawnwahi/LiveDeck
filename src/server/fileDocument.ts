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
    if (!e) return 'empty';
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
    this.emit([{ start: d.start, end: d.endA }]);
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
