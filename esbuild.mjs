import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
};

if (tests) {
  await build({
    ...common,
    entryPoints: [
      'tests/sourceMap.test.ts',
      'tests/resources.test.ts',
      'tests/structOps.test.ts',
      'tests/aiEdit.test.ts',
      'tests/fileDocument.test.ts',
      'tests/selection.test.ts',
      'tests/serve.test.ts',
    ],
    outdir: 'out-tests',
    outExtension: { '.js': '.cjs' },
  });
} else {
  // Keep the version in the "Open with LiveDeck" title in sync with package.json
  // (contributed command titles can't be templated).
  const pkgText = readFileSync('package.json', 'utf8');
  const { version } = JSON.parse(pkgText);
  const synced = pkgText.replace(
    /"title": "Open with LiveDeck[^"]*"/,
    `"title": "Open with LiveDeck v${version}"`
  );
  if (synced !== pkgText) writeFileSync('package.json', synced);

  await build({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
  });

  // `livedeck` CLI: the editor outside VS Code (serve) and the MCP server
  await build({
    ...common,
    entryPoints: ['src/cli.ts'],
    outfile: 'dist/livedeck.js',
    banner: { js: '#!/usr/bin/env node' },
    define: { LIVEDECK_VERSION: JSON.stringify(version) },
  });
}
