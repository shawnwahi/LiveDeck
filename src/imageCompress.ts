/**
 * Shrink large inline PNG data: URIs (pasted screenshots, AI-generated
 * illustrations) to JPEG. Opaque PNGs only — anything with transparency is
 * left alone, since JPEG has no alpha. Pure JS (pngjs + jpeg-js) so the
 * extension stays platform-independent.
 *
 * planImageCompression() only plans: it returns one replacement per data:
 * URI occurrence, each confined to the URI's own source range, so the
 * session can apply them as ordinary single-range edits.
 */
import { PNG } from 'pngjs';
import * as jpeg from 'jpeg-js';

export interface ImageCompressOptions {
  /** Longest side after downscaling, px. */
  maxDimension: number;
  /** JPEG quality, 1–100. */
  quality: number;
  /** Leave URIs shorter than this many characters alone. */
  minChars: number;
  /** Keep the original unless the JPEG is at most this fraction of its size. */
  maxRatio: number;
}

export const DEFAULT_IMAGE_COMPRESS: ImageCompressOptions = {
  maxDimension: 1600,
  quality: 86,
  minChars: 150_000,
  maxRatio: 0.8,
};

export interface ImageReplacement {
  start: number;
  end: number;
  /** Exact source text expected in [start, end) — verified before writing. */
  original: string;
  text: string;
}

export interface CompressionPlan {
  replacements: ImageReplacement[];
  /** Distinct images converted. */
  images: number;
  bytesBefore: number;
  bytesAfter: number;
}

const PNG_URI = /data:image\/png;base64,([A-Za-z0-9+/]+={0,2})/g;

/** Compress one PNG to a JPEG data: URI, or null when it should stay as is. */
export function compressPng(
  base64: string,
  opts: ImageCompressOptions = DEFAULT_IMAGE_COMPRESS
): string | null {
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(base64, 'base64'));
  } catch {
    return null; // not a PNG we can decode: never touch it
  }
  const { width, height, data } = png;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return null; // transparency would be lost
  }
  const scale = Math.min(1, opts.maxDimension / Math.max(width, height));
  const img = scale < 1 ? downscale(data, width, height, scale) : { data, width, height };
  const out = jpeg.encode(img, opts.quality).data;
  const uri = 'data:image/jpeg;base64,' + Buffer.from(out).toString('base64');
  const before = 'data:image/png;base64,'.length + base64.length;
  return uri.length <= before * opts.maxRatio ? uri : null;
}

/** Area-average (box filter) downscale of RGBA pixels. */
function downscale(src: Buffer, w: number, h: number, scale: number) {
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const out = Buffer.alloc(W * H * 4);
  const fx = w / W;
  const fy = h / H;
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor(Y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((Y + 1) * fy));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor(X * fx);
      const x1 = Math.max(x0 + 1, Math.floor((X + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1 && y < h; y++) {
        for (let x = x0; x < x1 && x < w; x++) {
          const i = (y * w + x) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (Y * W + X) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

/**
 * Find every large inline PNG in `source` and plan its JPEG replacement.
 * Identical images are compressed once. `yieldEvery` lets a caller keep the
 * event loop responsive between images.
 */
export async function planImageCompression(
  source: string,
  opts: ImageCompressOptions = DEFAULT_IMAGE_COMPRESS,
  yieldEvery: () => Promise<void> = () => Promise.resolve(),
  /** Results by base64 payload; pass one in to remember declined images across calls. */
  results = new Map<string, string | null>()
): Promise<CompressionPlan> {
  const plan: CompressionPlan = { replacements: [], images: 0, bytesBefore: 0, bytesAfter: 0 };
  for (const m of source.matchAll(PNG_URI)) {
    if (m[0].length < opts.minChars) continue;
    let next = results.get(m[1]);
    if (next === undefined) {
      await yieldEvery();
      next = compressPng(m[1], opts);
      results.set(m[1], next);
      if (next) plan.images++;
    }
    if (!next) continue;
    plan.replacements.push({ start: m.index!, end: m.index! + m[0].length, original: m[0], text: next });
    plan.bytesBefore += m[0].length;
    plan.bytesAfter += next.length;
  }
  return plan;
}
