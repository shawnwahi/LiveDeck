/**
 * `livedeck mcp`: a stdio MCP server that tells a coding agent (Claude Code,
 * Codex) what is selected in LiveDeck, so "tighten this" or "make these two
 * bullets shorter" targets what the user clicked. Read-only: the agent edits
 * the file with its own tools, so every write stays a normal, reviewable edit.
 *
 * Newline-delimited JSON-RPC 2.0 over stdin/stdout, which is all MCP's stdio
 * transport needs; written by hand to keep the CLI dependency-free.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { anchor, lineCol, readSelections, SelectionFile } from './selection';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  {
    name: 'get_selection',
    title: 'Get LiveDeck selection',
    description:
      'Returns the element(s) the user has selected, or the text element they are editing, in a deck open in ' +
      'LiveDeck (the HTML slide-deck editor in VS Code/Cursor, the Claude desktop Preview pane or the Codex ' +
      'browser). Call this whenever the user refers to "this", "these", "the selected …" or "here" while working ' +
      'on an HTML deck. Each item has the file path, its exact current source (html), its location (start/end ' +
      'offsets and line/column) and its slide number. Edit only that source range with your normal file tools; ' +
      'items marked stale were changed after being selected and should be re-identified with the user.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Deck file path. Omit to use the deck the user interacted with most recently.',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
];

function describe(sel: SelectionFile) {
  let text: string;
  try {
    text = fs.readFileSync(sel.file, 'utf8').replace(/^﻿/, '');
  } catch {
    return { file: sel.file, error: 'deck file not found' };
  }
  return {
    file: sel.file,
    selectedAt: sel.updatedAt,
    items: sel.items.map((item) => {
      const a = anchor(item, text);
      const base = { tag: item.tag, slide: item.slide, editing: item.editing };
      if (a.status === 'stale') return { ...base, status: 'stale', htmlWhenSelected: item.html };
      return {
        ...base,
        status: a.status,
        start: a.start,
        end: a.end,
        startLine: lineCol(text, a.start).line,
        endLine: lineCol(text, a.end).line,
        html: item.html,
      };
    }),
  };
}

function getSelection(args: any): string {
  const all = readSelections();
  let sel: SelectionFile | undefined;
  if (typeof args?.file === 'string' && args.file) {
    const want = path.resolve(args.file);
    sel = all.find((s) => s.file === want);
    if (!sel) return JSON.stringify({ file: want, items: [], note: 'This deck is not open in LiveDeck.' });
  } else {
    sel = all[0];
  }
  if (!sel) {
    return JSON.stringify({
      items: [],
      note:
        'No deck is open in LiveDeck. Open it with "Open with LiveDeck" in VS Code/Cursor, or run ' +
        '`livedeck serve <deck.html>` and open the printed URL.',
    });
  }
  const out = describe(sel);
  if (out.items?.length === 0) {
    return JSON.stringify({ ...out, note: 'Nothing is selected in the deck right now.' });
  }
  return JSON.stringify(out, null, 2);
}

export function handleRequest(req: any, version: string): any | undefined {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: req.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: req.id, error: { code, message } });
  const isRequest = req && req.id !== undefined && req.id !== null;

  switch (req?.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'livedeck', title: 'LiveDeck', version },
        instructions:
          'When the user says "this", "these" or "the selected …" about an HTML slide deck, call get_selection ' +
          'to find what they selected in LiveDeck, then edit just that source range.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      if (req.params?.name !== 'get_selection') return error(-32602, `Unknown tool: ${req.params?.name}`);
      try {
        return reply({ content: [{ type: 'text', text: getSelection(req.params?.arguments) }] });
      } catch (err) {
        return reply({ content: [{ type: 'text', text: (err as Error).message }], isError: true });
      }
    }
    default:
      // notifications (initialized, cancelled, …) get no reply
      return isRequest ? error(-32601, `Method not found: ${req?.method}`) : undefined;
  }
}

export function runMcp(version: string) {
  const rl = readline.createInterface({ input: process.stdin });
  const write = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let req: any;
    try {
      req = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const res = handleRequest(req, version);
    if (res) write(res);
  });
  rl.on('close', () => process.exit(0));
}
