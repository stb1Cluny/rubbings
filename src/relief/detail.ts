// Image detail for the relief: which samples are darker (or lighter) than their surroundings.

/** One running-sum box blur pass along rows or columns, with clamped edges. */
function boxPass(src: Float32Array, dst: Float32Array, w: number, h: number, radius: number, horizontal: boolean): void {
  const lines = horizontal ? h : w;
  const length = horizontal ? w : h;
  const step = horizontal ? 1 : w;
  const scale = 1 / (2 * radius + 1);
  for (let line = 0; line < lines; line++) {
    const start = horizontal ? line * w : line;
    const first = src[start];
    const last = src[start + (length - 1) * step];
    // Window for position -1 clamped to the line: `radius` copies of the first sample (for the
    // positions left of the line) plus samples 0 .. radius-1.
    let sum = first * radius;
    for (let k = 0; k < radius; k++) sum += src[start + Math.min(k, length - 1) * step];
    for (let k = 0; k < length; k++) {
      const add = k + radius < length ? src[start + (k + radius) * step] : last;
      sum += add;
      dst[start + k * step] = sum * scale;
      const remove = k - radius >= 0 ? src[start + (k - radius) * step] : first;
      sum -= remove;
    }
  }
}

/** Box blur with the given radius in samples (window = 2r + 1). */
export function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return src.slice();
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  boxPass(src, tmp, w, h, r, true);
  boxPass(tmp, out, w, h, r, false);
  return out;
}

function exactGaussian(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(2 * radius + 1);
  let total = 0;
  for (let k = -radius; k <= radius; k++) {
    kernel[k + radius] = Math.exp((-k * k) / (2 * sigma * sigma));
    total += kernel[k + radius];
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= total;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
        sum += src[row + xx] * kernel[k + radius];
      }
      tmp[row + x] = sum;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
        sum += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = sum;
    }
  }
  return out;
}

/** Gaussian blur. Small sigmas use the exact kernel; larger ones three box blurs (much faster). */
export function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0.05) return src.slice();
  if (sigma < 2.5) return exactGaussian(src, w, h, sigma);
  // Box sizes that approximate a Gaussian after three passes.
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lower = Math.floor(ideal);
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const lowerCount = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
  const bufferA = new Float32Array(src.length);
  const bufferB = new Float32Array(src.length);
  const tmp = new Float32Array(src.length);
  let current = src;
  for (let pass = 0; pass < 3; pass++) {
    const radius = ((pass < lowerCount ? lower : upper) - 1) / 2;
    const target = pass % 2 === 0 ? bufferA : bufferB;
    boxPass(current, tmp, w, h, radius, true);
    boxPass(tmp, target, w, h, radius, false);
    current = target;
  }
  return current;
}

/** Value below which the given fraction of samples fall (approximate, histogram based). */
export function quantile(values: Float32Array, fraction: number, include?: Uint8Array): number {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    if (include && !include[i]) continue;
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (count === 0 || !(max > min)) return count === 0 ? 0 : min;
  const bins = 2048;
  const histogram = new Uint32Array(bins);
  const scale = (bins - 1) / (max - min);
  for (let i = 0; i < values.length; i++) {
    if (include && !include[i]) continue;
    histogram[Math.round((values[i] - min) * scale)]++;
  }
  const target = Math.min(1, Math.max(0, fraction)) * count;
  let running = 0;
  for (let b = 0; b < bins; b++) {
    running += histogram[b];
    if (running >= target) return min + b / scale;
  }
  return max;
}

/** Stretch luminance so the 1st..99th percentiles span 0..1. */
export function stretchContrast(luminance: Float32Array): Float32Array {
  const lo = quantile(luminance, 0.01);
  const hi = quantile(luminance, 0.99);
  const out = new Float32Array(luminance.length);
  const span = hi - lo;
  if (span < 1e-4) return out.fill(0.5);
  for (let i = 0; i < out.length; i++) {
    const v = (luminance[i] - lo) / span;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

/**
 * Physical scales (mm) of the difference-of-Gaussians bands that make up the detail:
 * fine lines, broader strokes, and "mass" - whole dark shapes, which fill in solid the way a
 * linocut does instead of leaving only their outline.
 */
export const DETAIL_SCALES = {
  fine: { inner: 0.25, outer: 1.0 },
  broad: { inner: 0.8, outer: 3.2, weight: 0.6 },
  mass: { inner: 1.5, outer: 12, weight: 0.5 },
};

function robustScale(values: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i] * values[i];
  return Math.sqrt(sum / values.length) || 1;
}

/**
 * Signed detail: positive where a sample is darker than its surroundings. Fine lines and
 * broader shapes are each normalised by their own strength, so low-contrast photos still work.
 *
 * @param luminance 0..1, row-major
 * @param pitch millimetres per sample
 */
export function computeDetail(luminance: Float32Array, w: number, h: number, pitch: number): Float32Array {
  const { fine, broad, mass } = DETAIL_SCALES;
  const fineInner = gaussianBlur(luminance, w, h, fine.inner / pitch);
  const fineOuter = gaussianBlur(luminance, w, h, fine.outer / pitch);
  const broadInner = gaussianBlur(luminance, w, h, broad.inner / pitch);
  const broadOuter = gaussianBlur(luminance, w, h, broad.outer / pitch);
  const massInner = gaussianBlur(luminance, w, h, mass.inner / pitch);
  const massOuter = gaussianBlur(luminance, w, h, mass.outer / pitch);
  const d1 = new Float32Array(luminance.length);
  const d2 = new Float32Array(luminance.length);
  const d3 = new Float32Array(luminance.length);
  for (let i = 0; i < d1.length; i++) {
    d1[i] = fineOuter[i] - fineInner[i];
    d2[i] = broadOuter[i] - broadInner[i];
    d3[i] = massOuter[i] - massInner[i];
  }
  const s1 = robustScale(d1);
  const s2 = robustScale(d2);
  const s3 = robustScale(d3);
  for (let i = 0; i < d1.length; i++) {
    d1[i] = d1[i] / s1 + (broad.weight * d2[i]) / s2 + (mass.weight * d3[i]) / s3;
  }
  return d1;
}
