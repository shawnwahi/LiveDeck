import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';
import { compressPng, planImageCompression, DEFAULT_IMAGE_COMPRESS } from '../src/imageCompress';

/** A photo-like PNG (smooth gradients + noise) that PNG compresses poorly. */
function pngBase64(width: number, height: number, alpha = 255): string {
  const png = new PNG({ width, height });
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 40);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      png.data[i] = (x * 255) / width + rand();
      png.data[i + 1] = (y * 255) / height + rand();
      png.data[i + 2] = 128 + rand();
      png.data[i + 3] = alpha;
    }
  }
  return PNG.sync.write(png).toString('base64');
}

const uri = (b64: string) => `data:image/png;base64,${b64}`;
const small = { ...DEFAULT_IMAGE_COMPRESS, minChars: 0 };

test('opaque PNG becomes a smaller JPEG, downscaled to maxDimension', () => {
  const b64 = pngBase64(400, 200);
  const out = compressPng(b64, { ...small, maxDimension: 100 });
  assert.ok(out && out.startsWith('data:image/jpeg;base64,'));
  assert.ok(out.length < uri(b64).length * 0.8);
  const img = jpeg.decode(Buffer.from(out.split(',')[1], 'base64'));
  assert.equal(img.width, 100);
  assert.equal(img.height, 50);
});

test('PNGs with transparency are left alone', () => {
  assert.equal(compressPng(pngBase64(64, 64, 200), small), null);
});

test('undecodable data is left alone', () => {
  assert.equal(compressPng(Buffer.from('not a png').toString('base64'), small), null);
});

test('plan replaces each occurrence in place and skips small or transparent images', async () => {
  const big = pngBase64(300, 200);
  const clear = pngBase64(300, 200, 0);
  const tiny = pngBase64(4, 4);
  const source =
    `<img src="${uri(big)}"><div style="background:url(${uri(big)})"></div>` +
    `<img src="${uri(clear)}"><img src="${uri(tiny)}">`;
  const plan = await planImageCompression(source, { ...DEFAULT_IMAGE_COMPRESS, minChars: 1000 });
  assert.equal(plan.images, 1); // the duplicate is compressed once
  assert.equal(plan.replacements.length, 2);
  for (const r of plan.replacements) {
    assert.equal(source.slice(r.start, r.end), r.original);
    assert.equal(r.original, uri(big));
  }
  // applied last-to-first, the result keeps all markup and only swaps the URIs
  let out = source;
  for (const r of [...plan.replacements].reverse()) out = out.slice(0, r.start) + r.text + out.slice(r.end);
  assert.ok(!out.includes(uri(big)));
  assert.ok(out.includes(uri(clear)) && out.includes(uri(tiny)));
  assert.ok(out.includes('<div style="background:url(data:image/jpeg;base64,'));
  assert.equal(plan.bytesBefore - plan.bytesAfter, source.length - out.length);
});

test('a shared results map remembers declined images', async () => {
  const clear = pngBase64(100, 100, 0);
  const results = new Map<string, string | null>();
  await planImageCompression(`<img src="${uri(clear)}">`, small, undefined, results);
  assert.equal(results.get(clear), null);
});
