/**
 * `livedeck` command line: run the editor outside VS Code.
 *
 *   livedeck serve <deck.html> [--port N] [--open]
 *   livedeck mcp
 *   livedeck init-claude <deck.html> [--port N]
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { serve } from './server/serve';
import { runMcp } from './mcp';

declare const LIVEDECK_VERSION: string;
const VERSION = typeof LIVEDECK_VERSION === 'string' ? LIVEDECK_VERSION : 'dev';
const DEFAULT_PORT = 4321;

const USAGE = `LiveDeck ${VERSION} — edit HTML slide decks in place

Usage:
  livedeck serve <deck.html> [--port N] [--open]
      Open the deck in the LiveDeck editor at http://localhost:N/ (default ${DEFAULT_PORT}).
      Every edit is written straight to the file; changes others make to the
      file (Claude, Codex, git) show up live.
  livedeck init-claude <deck.html> [--port N]
      Add a "LiveDeck" entry to .claude/launch.json so the Claude desktop app's
      Preview pane can open the deck.
  livedeck mcp
      MCP server (stdio) with a get_selection tool, so Claude Code or Codex can
      see what you selected in the deck.
`;

function fail(msg: string): never {
  process.stderr.write(`livedeck: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (k === 'port') flags[k] = argv[++i] ?? '';
      else flags[k] = true;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function portFlag(flags: Record<string, string | true>): number | undefined {
  if (flags.port === undefined) return undefined;
  const n = Number(flags.port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`invalid port: ${flags.port}`);
  return n;
}

function deckArg(positional: string[]): string {
  const file = positional[0];
  if (!file) fail('which deck? e.g. livedeck serve slides.html');
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) fail(`no such file: ${file}`);
  return abs;
}

function openUrl(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

async function cmdServe(positional: string[], flags: Record<string, string | true>) {
  const file = deckArg(positional);
  const port = portFlag(flags);
  const server = await serve({
    file,
    port: port ?? DEFAULT_PORT,
    // an explicit port (e.g. from launch.json) must be exact; the default may move
    portFallback: port === undefined,
    mediaDir: path.join(__dirname, '..', 'media'),
    log: (line) => process.stderr.write(`livedeck: ${line}\n`),
  });
  process.stdout.write(`LiveDeck ${VERSION}: editing ${path.relative(process.cwd(), file) || file}\n  ${server.url}\n`);
  if (flags.open) openUrl(server.url);
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

/** Add or update a "LiveDeck" configuration in ./.claude/launch.json. */
function cmdInitClaude(positional: string[], flags: Record<string, string | true>) {
  const file = deckArg(positional);
  const port = portFlag(flags) ?? DEFAULT_PORT;
  const launchPath = path.join(process.cwd(), '.claude', 'launch.json');
  let launch: any = { version: '0.0.1', configurations: [] };
  if (fs.existsSync(launchPath)) {
    try {
      launch = JSON.parse(fs.readFileSync(launchPath, 'utf8'));
    } catch {
      fail(`${launchPath} is not valid JSON; fix or remove it first`);
    }
    if (!Array.isArray(launch.configurations)) launch.configurations = [];
  }
  const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
  const config = {
    name: 'LiveDeck',
    runtimeExecutable: 'livedeck',
    runtimeArgs: ['serve', rel, '--port', String(port)],
    port,
    // the deck changes under Claude's edits by design; screenshots after every edit add nothing
    autoVerify: false,
  };
  const i = launch.configurations.findIndex((c: any) => c?.name === 'LiveDeck');
  if (i >= 0) launch.configurations[i] = config;
  else launch.configurations.push(config);
  fs.mkdirSync(path.dirname(launchPath), { recursive: true });
  fs.writeFileSync(launchPath, JSON.stringify(launch, null, 2) + '\n');
  process.stdout.write(
    `${i >= 0 ? 'Updated' : 'Added'} "LiveDeck" in ${path.relative(process.cwd(), launchPath)} (${rel}, port ${port}).\n` +
      'In the Claude desktop app, open this folder in a Code session and start "LiveDeck" from the Preview menu.\n'
  );
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'serve':
      return cmdServe(positional, flags);
    case 'init-claude':
      return cmdInitClaude(positional, flags);
    case 'mcp':
      return runMcp(VERSION);
    case '--version':
    case '-v':
      process.stdout.write(VERSION + '\n');
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    default:
      fail(`unknown command "${cmd}"\n\n${USAGE}`);
  }
}

main().catch((err) => fail((err as Error).message));
