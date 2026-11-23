// A rough picture of what a rubbing of the plate would look like.
//
// Model: paper rests on the highest points nearby. Pigment lands where the paper is supported
// (ridge tops, and flat areas far from any ridge), most heavily where a feature stands proud of
// its surroundings, and not at all in the unsupported strip beside a ridge.
import { boxBlur } from './detail';

/** How far unsupported paper spans beside a raised feature, mm. */
const BRIDGE_MM = 1.4;

function localMax(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - radius);
      const hi = Math.min(w - 1, x + radius);
      let best = src[row + lo];
      for (let q = lo + 1; q <= hi; q++) if (src[row + q] > best) best = src[row + q];
      tmp[row + x] = best;
    }
  }
  for (let y = 0; y < h; y++) {
    const lo = Math.max(0, y - radius);
    const hi = Math.min(h - 1, y + radius);
    for (let x = 0; x < w; x++) {
      let best = tmp[lo * w + x];
      for (let q = lo + 1; q <= hi; q++) if (tmp[q * w + x] > best) best = tmp[q * w + x];
      out[y * w + x] = best;
    }
  }
  return out;
}

function hash(x: number, y: number): number {
  let n = (x * 374761393 + y * 668265263) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function smooth(t: number): number {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

export interface RubbingOptions {
  /** Crayon colour, 0..255 per channel. */
  crayon: [number, number, number];
  paper: [number, number, number];
}

export const DEFAULT_RUBBING: RubbingOptions = { crayon: [38, 52, 110], paper: [250, 247, 240] };

/**
 * @param heights relief heights in mm
 * @param inside 1 where the plate exists (pigment only lands on the plate)
 * @returns RGBA pixels, nx * ny * 4
 */
export function simulateRubbing(
  heights: Float32Array,
  inside: Uint8Array,
  nx: number,
  ny: number,
  pitch: number,
  reliefHeight: number,
  options: RubbingOptions = DEFAULT_RUBBING,
): Uint8ClampedArray {
  const radius = Math.max(1, Math.round(BRIDGE_MM / pitch));
  // The square max window leaves blocky corners; a light blur rounds them off.
  const highest = boxBlur(localMax(heights, nx, ny, radius), nx, ny, Math.max(1, Math.round(radius / 3)));
  const average = boxBlur(heights, nx, ny, radius);
  const out = new Uint8ClampedArray(nx * ny * 4);
  const scale = Math.max(0.2, reliefHeight);
  const grainStep = Math.max(1, Math.round(0.35 / pitch));
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const i = y * nx + x;
      let pigment = 0;
      if (inside[i]) {
        const h = heights[i];
        // Supported when within a hair of the highest point nearby.
        const contact = smooth(1 - (highest[i] - h) / (0.2 * scale));
        // Pressure concentrates on features that stand above the local average.
        const proud = smooth((h - average[i]) / (0.45 * scale));
        pigment = contact * (0.22 + 0.78 * proud);
        // Paper tooth and stroke direction.
        const grain = hash(Math.floor(x / grainStep), Math.floor(y / grainStep));
        const stroke = hash(Math.floor((x + y) / (grainStep * 3)), 7);
        pigment *= 0.62 + 0.38 * grain;
        pigment *= 0.86 + 0.14 * stroke;
      }
      const o = i * 4;
      for (let c = 0; c < 3; c++) out[o + c] = options.paper[c] + (options.crayon[c] - options.paper[c]) * pigment;
      out[o + 3] = 255;
    }
  }
  return out;
}
