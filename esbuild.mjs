import { build } from 'esbuild';

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
    entryPoints: ['tests/sourceMap.test.ts', 'tests/resources.test.ts', 'tests/structOps.test.ts', 'tests/aiEdit.test.ts'],
    outdir: 'out-tests',
    outExtension: { '.js': '.cjs' },
  });
} else {
  await build({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
  });
}
