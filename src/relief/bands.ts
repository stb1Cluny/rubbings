// Depth handling: resampling the model's output onto the plate raster, sharpening it against
// the image, and splitting it into foreground and background.
import { boxBlur, quantile } from './detail';

export interface DepthSource {
  /** Raw model output, larger = nearer. */
  data: Float32Array;
  width: number;
  height: number;
  /** The part of the depth map that the plate covers, in depth-map pixels. */
  crop: { x: number; y: number; width: number; height: number };
}

/** Bilinearly resample the cropped region of a depth map to nx x ny samples. */
export function resampleDepth(source: DepthSource, nx: number, ny: number): Float32Array {
  const out = new Float32Array(nx * ny);
  const { data, width, height, crop } = source;
  for (let j = 0; j < ny; j++) {
    const fy = Math.min(height - 1, Math.max(0, crop.y + ((j + 0.5) / ny) * crop.height - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const ty = fy - y0;
    for (let i = 0; i < nx; i++) {
      const fx = Math.min(width - 1, Math.max(0, crop.x + ((i + 0.5) / nx) * crop.width - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const tx = fx - x0;
      const top = data[y0 * width + x0] * (1 - tx) + data[y0 * width + x1] * tx;
      const bottom = data[y1 * width + x0] * (1 - tx) + data[y1 * width + x1] * tx;
      out[j * nx + i] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

/** Rescale so the 1st..99th percentiles (inside the plate) span 0 (far) .. 1 (near). */
export function normaliseDepth(depth: Float32Array, inside?: Uint8Array): Float32Array {
  const lo = quantile(depth, 0.01, inside);
  const hi = quantile(depth, 0.99, inside);
  const out = new Float32Array(depth.length);
  const span = hi - lo;
  if (!(span > 1e-6)) return out.fill(0.5);
  for (let i = 0; i < out.length; i++) {
    const v = (depth[i] - lo) / span;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}

/**
 * Guided filter (He et al.): smooths `src` while snapping its edges to edges in `guide`.
 * Used to pull the low-resolution depth map's soft boundaries onto the image's own outlines.
 */
export function guidedFilter(guide: Float32Array, src: Float32Array, w: number, h: number, radius: number, epsilon: number): Float32Array {
  const n = guide.length;
  const gp = new Float32Array(n);
  const gg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    gp[i] = guide[i] * src[i];
    gg[i] = guide[i] * guide[i];
  }
  const meanG = boxBlur(guide, w, h, radius);
  const meanP = boxBlur(src, w, h, radius);
  const meanGP = boxBlur(gp, w, h, radius);
  const meanGG = boxBlur(gg, w, h, radius);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const variance = meanGG[i] - meanG[i] * meanG[i];
    const covariance = meanGP[i] - meanG[i] * meanP[i];
    a[i] = covariance / (variance + epsilon);
    b[i] = meanP[i] - a[i] * meanG[i];
  }
  const meanA = boxBlur(a, w, h, radius);
  const meanB = boxBlur(b, w, h, radius);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = meanA[i] * guide[i] + meanB[i];
  return out;
}

export const HISTOGRAM_BINS = 64;

export function depthHistogram(depth: Float32Array, inside: Uint8Array): Float32Array {
  const histogram = new Float32Array(HISTOGRAM_BINS);
  for (let i = 0; i < depth.length; i++) {
    if (!inside[i]) continue;
    histogram[Math.min(HISTOGRAM_BINS - 1, Math.floor(depth[i] * HISTOGRAM_BINS))]++;
  }
  return histogram;
}

/** Otsu's threshold on a histogram over 0..1: the split that best separates two groups. */
export function otsuSplit(histogram: Float32Array): number {
  const bins = histogram.length;
  let total = 0;
  let weighted = 0;
  for (let b = 0; b < bins; b++) {
    total += histogram[b];
    weighted += histogram[b] * b;
  }
  if (total === 0) return 0.5;
  // When the two groups are well separated, every split in the gap scores the same; take the
  // middle of that run so the handle sits between the groups rather than against one of them.
  let firstBest = -1;
  let lastBest = -1;
  let bestVariance = -1;
  let countBelow = 0;
  let sumBelow = 0;
  for (let b = 0; b < bins - 1; b++) {
    countBelow += histogram[b];
    sumBelow += histogram[b] * b;
    const countAbove = total - countBelow;
    if (countBelow === 0 || countAbove === 0) continue;
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (weighted - sumBelow) / countAbove;
    const variance = countBelow * countAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance * (1 + 1e-9)) {
      bestVariance = variance;
      firstBest = lastBest = b;
    } else if (variance >= bestVariance * (1 - 1e-9)) {
      lastBest = b;
    }
  }
  if (firstBest < 0) return 0.5;
  const best = ((firstBest + lastBest) / 2 + 1) / bins;
  // Keep the handle away from the ends so both bands stay reachable.
  return Math.min(0.9, Math.max(0.1, best));
}

/**
 * Strength of depth discontinuities, 0..1, widened so image lines that sit near a depth edge
 * (rather than exactly on it) are covered too.
 */
export function depthEdges(depth: Float32Array, w: number, h: number, spreadSamples: number): Float32Array {
  const magnitude = new Float32Array(depth.length);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = depth[i + 1] - depth[i - 1];
      const gy = depth[i + w] - depth[i - w];
      magnitude[i] = Math.hypot(gx, gy);
    }
  }
  const strong = quantile(magnitude, 0.985);
  if (!(strong > 1e-6)) return magnitude.fill(0);
  for (let i = 0; i < magnitude.length; i++) {
    const v = magnitude[i] / strong;
    magnitude[i] = v > 1 ? 1 : v < 0.25 ? 0 : v;
  }
  const spread = boxBlur(magnitude, w, h, Math.max(1, Math.round(spreadSamples)));
  const peak = quantile(spread, 0.995) || 1;
  for (let i = 0; i < spread.length; i++) spread[i] = Math.min(1, spread[i] / peak);
  return spread;
}

/** Foreground weight for a depth value: 0 in the background, 1 in the foreground. */
export function foregroundWeight(depth: number, split: number, softness: number): number {
  const t = (depth - (split - softness)) / (2 * softness);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}
