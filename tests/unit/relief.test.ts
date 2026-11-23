import { describe, expect, it } from 'vitest';
import { depthHistogram, foregroundWeight, guidedFilter, normaliseDepth, otsuSplit, resampleDepth } from '../../src/relief/bands';
import {
  DEFAULT_PARAMS,
  ZONE_BORDER,
  ZONE_FLAT,
  ZONE_PICTURE,
  amplitude,
  buildZones,
  compose,
  detailQuantiles,
  rasterFor,
  snapHeight,
  type ReliefMaps,
  type ReliefParams,
} from '../../src/relief/compose';
import { boxBlur, computeDetail, gaussianBlur, quantile, stretchContrast } from '../../src/relief/detail';
import { close, open, removeSmallIslands } from '../../src/relief/morphology';
import { simulateRubbing } from '../../src/relief/rubbingSim';
import { plateShape } from '../../src/shapes/outline';

function filled(n: number, value: number): Float32Array {
  return new Float32Array(n).fill(value);
}

function pseudoRandom(i: number): number {
  const v = Math.sin(i * 127.1) * 43758.5453;
  return v - Math.floor(v);
}

describe('blurs', () => {
  it('leave a constant image unchanged', () => {
    const src = filled(40 * 30, 0.37);
    for (const radius of [1, 3, 8, 25]) {
      const out = boxBlur(src, 40, 30, radius);
      for (const v of out) expect(v).toBeCloseTo(0.37, 5);
    }
    for (const sigma of [0.6, 1.5, 3, 9]) {
      const out = gaussianBlur(src, 40, 30, sigma);
      for (const v of out) expect(v).toBeCloseTo(0.37, 5);
    }
  });

  it('box blur averages exactly over its window', () => {
    const w = 9;
    const src = new Float32Array(w);
    src[4] = 9;
    const out = boxBlur(src, w, 1, 1);
    expect(Array.from(out)).toEqual([0, 0, 0, 3, 3, 3, 0, 0, 0]);
  });

  it('preserve the mean and spread an impulse symmetrically', () => {
    const w = 61;
    const src = new Float32Array(w * w);
    src[30 * w + 30] = 1;
    for (const sigma of [1.2, 4]) {
      const out = gaussianBlur(src, w, w, sigma);
      let sum = 0;
      for (const v of out) sum += v;
      expect(sum).toBeCloseTo(1, 3);
      expect(out[30 * w + 25]).toBeCloseTo(out[30 * w + 35], 6);
      expect(out[25 * w + 30]).toBeCloseTo(out[35 * w + 30], 6);
      expect(out[30 * w + 30]).toBeGreaterThan(out[30 * w + 33]);
    }
  });
});

describe('quantile and contrast', () => {
  it('finds quantiles of a ramp', () => {
    const ramp = Float32Array.from({ length: 1001 }, (_, i) => i / 1000);
    expect(quantile(ramp, 0.5)).toBeCloseTo(0.5, 2);
    expect(quantile(ramp, 0.9)).toBeCloseTo(0.9, 2);
  });

  it('stretches a narrow range to 0..1', () => {
    const src = Float32Array.from({ length: 1000 }, (_, i) => 0.4 + (i / 999) * 0.2);
    const out = stretchContrast(src);
    expect(Math.min(...out)).toBe(0);
    expect(Math.max(...out)).toBe(1);
  });
});

describe('detail', () => {
  it('is positive on a dark line and near zero in flat areas', () => {
    // A 1 mm dark line down the middle of a 100 mm wide strip (0.25 mm per sample).
    const w = 400;
    const h = 60;
    const lum = filled(w * h, 0.9);
    for (let y = 0; y < h; y++) for (let x = 198; x <= 201; x++) lum[y * w + x] = 0.1;
    const detail = computeDetail(lum, w, h, 0.25);
    expect(detail[30 * w + 200]).toBeGreaterThan(1);
    // Far from the line (beyond the widest blur) nothing is raised.
    expect(Math.abs(detail[30 * w + 8])).toBeLessThan(0.01);
    // Just beside the line the surroundings are darker than the sample, so detail is negative.
    expect(detail[30 * w + 205]).toBeLessThan(0);
  });

  it('fills a wide dark shape instead of leaving only its outline', () => {
    // An 8 mm dark bar: its middle is 4 mm from either edge.
    const w = 400;
    const h = 60;
    const lum = filled(w * h, 0.9);
    for (let y = 0; y < h; y++) for (let x = 184; x < 216; x++) lum[y * w + x] = 0.1;
    const detail = computeDetail(lum, w, h, 0.25);
    expect(detail[30 * w + 200]).toBeGreaterThan(0.3);
    expect(detail[30 * w + 240]).toBeLessThan(0);
  });
});

describe('morphology', () => {
  const w = 30;
  const h = 20;
  const mask = () => new Uint8Array(w * h);

  it('opening removes thin lines and keeps wide ones in place', () => {
    const m = mask();
    for (let y = 2; y < 18; y++) {
      m[y * w + 5] = 1; // 1 wide
      for (let x = 12; x < 16; x++) m[y * w + x] = 1; // 4 wide
    }
    const out = open(m, w, h, 3);
    expect(out[10 * w + 5]).toBe(0);
    for (let x = 12; x < 16; x++) expect(out[10 * w + x]).toBe(1);
    expect(out[10 * w + 11]).toBe(0);
    expect(out[10 * w + 16]).toBe(0);
  });

  it('closing fills thin gaps and leaves wide ones', () => {
    const m = mask().fill(1);
    for (let y = 0; y < h; y++) {
      m[y * w + 6] = 0; // 1-wide gap
      for (let x = 15; x < 20; x++) m[y * w + x] = 0; // 5-wide gap
    }
    const out = close(m, w, h, 3);
    expect(out[10 * w + 6]).toBe(1);
    for (let x = 15; x < 20; x++) expect(out[10 * w + x]).toBe(0);
  });

  it('drops small islands and keeps large ones', () => {
    const m = mask();
    m[3 * w + 3] = 1;
    m[4 * w + 4] = 1; // 2 samples, touching diagonally
    for (let y = 10; y < 14; y++) for (let x = 10; x < 14; x++) m[y * w + x] = 1; // 16 samples
    removeSmallIslands(m, w, h, 5);
    expect(m[3 * w + 3]).toBe(0);
    expect(m[4 * w + 4]).toBe(0);
    expect(m[11 * w + 11]).toBe(1);
  });

  it('opening never adds and closing never removes', () => {
    const m = mask();
    for (let i = 0; i < m.length; i++) m[i] = pseudoRandom(i) > 0.5 ? 1 : 0;
    const opened = open(m, w, h, 2);
    const closed = close(m, w, h, 2);
    for (let i = 0; i < m.length; i++) {
      expect(opened[i]).toBeLessThanOrEqual(m[i]);
      expect(closed[i]).toBeGreaterThanOrEqual(m[i]);
    }
  });
});

describe('depth bands', () => {
  it('resamples the cropped part of a depth map', () => {
    // 4 x 2 map whose value is its column index.
    const data = Float32Array.from([0, 1, 2, 3, 0, 1, 2, 3]);
    const out = resampleDepth({ data, width: 4, height: 2, crop: { x: 2, y: 0, width: 2, height: 2 } }, 2, 2);
    expect(Array.from(out)).toEqual([2, 3, 2, 3]);
  });

  it('normalises to 0..1 and handles a flat map', () => {
    const ramp = Float32Array.from({ length: 500 }, (_, i) => 3 + i * 0.01);
    const out = normaliseDepth(ramp);
    expect(out[0]).toBe(0);
    expect(out[499]).toBe(1);
    expect(normaliseDepth(filled(100, 2))[5]).toBe(0.5);
  });

  it('guided filter keeps values in range and follows the guide edge', () => {
    const w = 60;
    const h = 40;
    // Guide: sharp step at x = 30. Source: the same step, but blurred and shifted to x = 34.
    const guide = new Float32Array(w * h);
    const step = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        guide[y * w + x] = x < 30 ? 0.2 : 0.8;
        step[y * w + x] = x < 34 ? 0 : 1;
      }
    }
    const soft = gaussianBlur(step, w, h, 3);
    const out = guidedFilter(guide, soft, w, h, 8, 0.002);
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(-0.2);
      expect(v).toBeLessThan(1.2);
    }
    // The transition now happens across the guide's edge.
    const jumpAtGuide = out[20 * w + 31] - out[20 * w + 28];
    const jumpInSource = soft[20 * w + 31] - soft[20 * w + 28];
    expect(jumpAtGuide).toBeGreaterThan(jumpInSource * 1.5);
  });

  it('Otsu splits two groups between them', () => {
    const depth = new Float32Array(1000);
    for (let i = 0; i < 1000; i++) depth[i] = i < 600 ? 0.15 + pseudoRandom(i) * 0.1 : 0.7 + pseudoRandom(i) * 0.15;
    const split = otsuSplit(depthHistogram(depth, new Uint8Array(1000).fill(1)));
    expect(split).toBeGreaterThan(0.26);
    expect(split).toBeLessThan(0.7);
  });

  it('foreground weight goes smoothly from 0 to 1 across the split', () => {
    expect(foregroundWeight(0.2, 0.5, 0.06)).toBe(0);
    expect(foregroundWeight(0.5, 0.5, 0.06)).toBeCloseTo(0.5, 5);
    expect(foregroundWeight(0.8, 0.5, 0.06)).toBe(1);
  });
});

/** A 30 mm square plate: left half far, right half near, with a grid of dark lines all over. */
function testMaps(): ReliefMaps {
  const shape = plateShape('square', 30, false);
  const { nx, ny, pitch } = rasterFor(shape);
  const lum = filled(nx * ny, 0.9);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (x % 16 < 4 || y % 16 < 4) lum[y * nx + x] = 0.15;
    }
  }
  const detail = computeDetail(lum, nx, ny, pitch);
  const depth = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) depth[y * nx + x] = x < nx / 2 ? 0.1 : 0.9;
  const zone = buildZones(shape, nx, ny);
  const picture = Uint8Array.from(zone, (z) => (z === ZONE_PICTURE ? 1 : 0));
  return { nx, ny, pitch, detail, depth, edge: new Float32Array(nx * ny), zone, quantiles: detailQuantiles(detail, picture) };
}

function raisedIn(maps: ReliefMaps, heights: Float32Array, near: boolean): { count: number; max: number } {
  let count = 0;
  let max = 0;
  for (let i = 0; i < heights.length; i++) {
    if (maps.zone[i] !== ZONE_PICTURE || maps.depth[i] > 0.5 !== near) continue;
    if (heights[i] > 0) count++;
    if (heights[i] > max) max = heights[i];
  }
  return { count, max };
}

describe('compose', () => {
  const maps = testMaps();
  const params = (overrides: Partial<ReliefParams>): ReliefParams => ({ ...DEFAULT_PARAMS, ...overrides });

  it('keeps the rim flat and never exceeds the relief height', () => {
    const heights = compose(maps, params({}));
    for (let i = 0; i < heights.length; i++) {
      if (maps.zone[i] === ZONE_FLAT) expect(heights[i]).toBe(0);
      expect(heights[i]).toBeLessThanOrEqual(DEFAULT_PARAMS.reliefHeight + 1e-6);
      expect(heights[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it('turns a band off at zero bumpiness without touching the other band', () => {
    const heights = compose(maps, params({ foreground: 0.8, background: 0 }));
    expect(raisedIn(maps, heights, false).count).toBe(0);
    expect(raisedIn(maps, heights, true).count).toBeGreaterThan(100);
  });

  it('keeps a quiet band visible: lower and sparser, but not gone', () => {
    const heights = compose(maps, params({ foreground: 1, background: 0.3 }));
    const near = raisedIn(maps, heights, true);
    const far = raisedIn(maps, heights, false);
    expect(far.count).toBeGreaterThan(50);
    expect(far.count).toBeLessThan(near.count);
    expect(far.max).toBeLessThan(near.max);
    expect(far.max).toBeGreaterThanOrEqual(DEFAULT_PARAMS.layerHeight);
  });

  it('raises more as bumpiness goes up', () => {
    const low = raisedIn(maps, compose(maps, params({ foreground: 0.2, background: 0.2 })), true).count;
    const high = raisedIn(maps, compose(maps, params({ foreground: 0.9, background: 0.9 })), true).count;
    expect(high).toBeGreaterThan(low);
  });

  it('snaps heights to whole layers', () => {
    const heights = compose(maps, params({ layerHeight: 0.2, reliefHeight: 0.9 }));
    for (const h of heights) expect(Math.abs(h / 0.2 - Math.round(h / 0.2))).toBeLessThan(1e-4);
  });

  it('raises the opposite samples when asked to raise light areas', () => {
    const dark = compose(maps, params({ foreground: 0.5, background: 0.5, border: false }));
    const light = compose(maps, params({ foreground: 0.5, background: 0.5, border: false, raiseDark: false }));
    let both = 0;
    let either = 0;
    for (let i = 0; i < dark.length; i++) {
      if (dark[i] > 0 && light[i] > 0) both++;
      if (dark[i] > 0 || light[i] > 0) either++;
    }
    expect(either).toBeGreaterThan(1000);
    expect(both / either).toBeLessThan(0.05);
  });

  it('draws the border line only when asked', () => {
    const withBorder = compose(maps, params({ border: true }));
    const without = compose(maps, params({ border: false, foreground: 0, background: 0 }));
    const borderIndex = maps.zone.indexOf(ZONE_BORDER);
    expect(withBorder[borderIndex]).toBeCloseTo(DEFAULT_PARAMS.reliefHeight, 5);
    expect(without[borderIndex]).toBe(0);
  });
});

describe('helpers', () => {
  it('amplitude is zero when off and at least half height when on', () => {
    expect(amplitude(0)).toBe(0);
    expect(amplitude(0.01)).toBeGreaterThanOrEqual(0.5);
    expect(amplitude(1)).toBe(1);
  });

  it('snapHeight never rounds a raised feature down to nothing', () => {
    expect(snapHeight(0, 0.2)).toBe(0);
    expect(snapHeight(0.05, 0.2)).toBeCloseTo(0.2, 6);
    expect(snapHeight(0.5, 0.2)).toBeCloseTo(0.6, 6);
    expect(snapHeight(0.5, 0)).toBe(0.5);
  });

  it('rasterFor keeps about 0.25 mm pitch and caps large plates', () => {
    const small = rasterFor(plateShape('circle', 100, false));
    expect(small.pitch).toBeCloseTo(0.25, 2);
    const a4 = rasterFor(plateShape('a4', 0, false));
    expect((a4.nx - 1) * (a4.ny - 1)).toBeLessThanOrEqual(730_000);
    expect(a4.pitch).toBeLessThan(0.3);
  });
});

describe('simulateRubbing', () => {
  it('puts the most pigment on ridge tops and none in the strip beside them', () => {
    const nx = 80;
    const ny = 40;
    const heights = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) for (let x = 38; x <= 41; x++) heights[y * nx + x] = 0.8;
    const rgba = simulateRubbing(heights, new Uint8Array(nx * ny).fill(1), nx, ny, 0.25, 0.8, {
      crayon: [0, 0, 0],
      paper: [255, 255, 255],
    });
    const darkness = (x: number) => {
      let sum = 0;
      for (let y = 10; y < 30; y++) sum += 255 - rgba[(y * nx + x) * 4];
      return sum / 20;
    };
    expect(darkness(40)).toBeGreaterThan(90); // on the ridge
    expect(darkness(44)).toBeLessThan(5); // unsupported paper next to it
    expect(darkness(5)).toBeGreaterThan(10); // flat area far away picks up a light tone
    expect(darkness(5)).toBeLessThan(darkness(40));
  });
});
