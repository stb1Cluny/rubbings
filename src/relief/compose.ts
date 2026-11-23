// Turns the precomputed maps plus the slider values into plate heights. This one function feeds
// both the preview and the exported mesh, so the two cannot disagree.
import { edgeDistance, type PlateShape } from '../shapes/outline';
import { foregroundWeight } from './bands';
import { close, open, removeSmallIslands } from './morphology';

/** Layout of the plate edge, mm, measured inward from the outline. */
export const RIM_MM = 1.2; // always flat, so the perimeter prints cleanly
export const BORDER_MM = 1.0; // optional raised frame line
export const BORDER_GAP_MM = 0.8; // flat gap between the frame line and the picture

/** Narrowest raised line or gap the plate will contain, mm (0.4 mm nozzle). */
export const MIN_FEATURE_MM = 0.5;
/** Raised islands smaller than this are dropped, mm^2. */
export const MIN_ISLAND_MM2 = 1.0;

/** Width of the soft transition between depth bands, in normalised depth. */
export const BAND_SOFTNESS = 0.06;

export const ZONE_FLAT = 0;
export const ZONE_PICTURE = 1;
export const ZONE_BORDER = 2;
export const ZONE_GAP = 3;

export interface ReliefMaps {
  nx: number;
  ny: number;
  /** Millimetres per sample. */
  pitch: number;
  /** Signed detail: positive where the image is darker than its surroundings. */
  detail: Float32Array;
  /** Normalised depth, 0 far .. 1 near. All 1 when no depth is available. */
  depth: Float32Array;
  /** Depth-edge strength 0..1 (zero without depth). */
  edge: Float32Array;
  /** ZONE_* per sample. */
  zone: Uint8Array;
  /** Detail value at evenly spaced quantiles 0..1 inside the picture zone. */
  quantiles: Float32Array;
}

export interface ReliefParams {
  /** 0..1; 0 turns the band off, higher raises more of the band's detail, and taller. */
  foreground: number;
  background: number;
  /** Normalised depth where background ends and foreground begins. */
  split: number;
  /** 0..1 boost for lines that sit on depth edges. */
  outline: number;
  /** Maximum relief height, mm. */
  reliefHeight: number;
  /** Heights snap to multiples of this, mm (0 = no snapping). */
  layerHeight: number;
  /** true: dark parts of the image are raised and rub dark. false: the reverse. */
  raiseDark: boolean;
  /** Raised frame line just inside the outline. */
  border: boolean;
}

export const DEFAULT_PARAMS: ReliefParams = {
  foreground: 0.75,
  background: 0.35,
  split: 0.5,
  outline: 0.5,
  reliefHeight: 0.8,
  layerHeight: 0.2,
  raiseDark: true,
  border: true,
};

/** Share of a band's area that is raised at bumpiness b (before width clean-up). */
export function coverage(bumpiness: number): number {
  return 0.04 + 0.4 * bumpiness;
}

/** Relative height of a band's features at bumpiness b. */
export function amplitude(bumpiness: number): number {
  return bumpiness <= 0 ? 0 : 0.5 + 0.5 * Math.min(1, bumpiness);
}

export function snapHeight(height: number, layerHeight: number): number {
  if (height <= 0) return 0;
  if (!(layerHeight > 0)) return height;
  return Math.max(layerHeight, Math.round(height / layerHeight) * layerHeight);
}

/** Classify every sample by where it sits relative to the plate edge. */
export function buildZones(shape: PlateShape, nx: number, ny: number): Uint8Array {
  const zone = new Uint8Array(nx * ny);
  const dx = shape.width / (nx - 1);
  const dy = shape.height / (ny - 1);
  for (let j = 0; j < ny; j++) {
    const y = shape.height / 2 - j * dy;
    for (let i = 0; i < nx; i++) {
      const d = edgeDistance(shape, -shape.width / 2 + i * dx, y);
      zone[j * nx + i] =
        d < RIM_MM
          ? ZONE_FLAT
          : d < RIM_MM + BORDER_MM
            ? ZONE_BORDER
            : d < RIM_MM + BORDER_MM + BORDER_GAP_MM
              ? ZONE_GAP
              : ZONE_PICTURE;
    }
  }
  return zone;
}

/** Detail values at `count` evenly spaced quantiles, over the samples flagged in `include`. */
export function detailQuantiles(detail: Float32Array, include: Uint8Array, count = 513): Float32Array {
  const values: number[] = [];
  // A sample of the detail is plenty for a threshold table and keeps the sort cheap.
  const stride = Math.max(1, Math.floor(detail.length / 200_000));
  for (let i = 0; i < detail.length; i += stride) if (include[i]) values.push(detail[i]);
  const sorted = Float32Array.from(values).sort();
  const out = new Float32Array(count);
  if (sorted.length === 0) return out;
  for (let q = 0; q < count; q++) out[q] = sorted[Math.min(sorted.length - 1, Math.round((q / (count - 1)) * (sorted.length - 1)))];
  return out;
}

function quantileAt(quantiles: Float32Array, fraction: number): number {
  const position = Math.min(1, Math.max(0, fraction)) * (quantiles.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(quantiles.length - 1, lower + 1);
  return quantiles[lower] + (quantiles[upper] - quantiles[lower]) * (position - lower);
}

/** Per-sample bumpiness after blending the two depth bands. */
export function bumpinessField(maps: ReliefMaps, params: ReliefParams, out?: Float32Array): Float32Array {
  const field = out ?? new Float32Array(maps.depth.length);
  for (let i = 0; i < field.length; i++) {
    const weight = foregroundWeight(maps.depth[i], params.split, BAND_SOFTNESS);
    field[i] = params.background + (params.foreground - params.background) * weight;
  }
  return field;
}

/**
 * Compose plate relief heights (mm above the base).
 * Order matters: decide what is raised, clean it up to printable widths, and only then apply
 * each band's height - so a quiet band keeps its features instead of fading below a threshold.
 */
export function compose(maps: ReliefMaps, params: ReliefParams): Float32Array {
  const { nx, ny, detail, edge, zone, quantiles } = maps;
  const n = nx * ny;
  const bump = bumpinessField(maps, params);
  const raised = new Uint8Array(n);
  const sign = params.raiseDark ? 1 : -1;

  // Thresholds for a few bumpiness levels, interpolated per sample.
  const LEVELS = 64;
  const thresholds = new Float32Array(LEVELS + 1);
  for (let level = 0; level <= LEVELS; level++) {
    const c = coverage(level / LEVELS);
    // Raising darks: the top c of the detail. Raising lights: the bottom c, sign-flipped.
    thresholds[level] = params.raiseDark ? quantileAt(quantiles, 1 - c) : -quantileAt(quantiles, c);
  }
  // How far a full-strength depth edge lowers the bar, in units of the detail's spread.
  const spread = quantileAt(quantiles, 0.9) - quantileAt(quantiles, 0.1);
  const edgeGain = params.outline * 1.5 * spread;

  for (let i = 0; i < n; i++) {
    const z = zone[i];
    if (z === ZONE_FLAT || (params.border && z !== ZONE_PICTURE)) continue;
    const b = bump[i];
    if (b <= 0.005) continue;
    const position = Math.min(1, b) * LEVELS;
    const lower = Math.floor(position);
    const upper = Math.min(LEVELS, lower + 1);
    const threshold = thresholds[lower] + (thresholds[upper] - thresholds[lower]) * (position - lower);
    if (sign * detail[i] > threshold - edgeGain * edge[i]) raised[i] = 1;
  }

  const size = Math.max(2, Math.round(MIN_FEATURE_MM / maps.pitch));
  const cleaned = close(open(raised, nx, ny, size), nx, ny, size);
  removeSmallIslands(cleaned, nx, ny, Math.round(MIN_ISLAND_MM2 / (maps.pitch * maps.pitch)));

  const heights = new Float32Array(n);
  const borderHeight = snapHeight(params.reliefHeight, params.layerHeight);
  for (let i = 0; i < n; i++) {
    const z = zone[i];
    if (z === ZONE_FLAT) continue;
    if (params.border && z !== ZONE_PICTURE) {
      if (z === ZONE_BORDER) heights[i] = borderHeight;
      continue;
    }
    if (cleaned[i] && bump[i] > 0.005) {
      heights[i] = snapHeight(params.reliefHeight * amplitude(bump[i]), params.layerHeight);
    }
  }
  return heights;
}

/** Sample grid for a plate: about 0.25 mm pitch, coarser only when needed to cap triangles. */
export const MIN_PITCH_MM = 0.25;
export const MAX_CELLS = 720_000;

export function rasterFor(shape: PlateShape): { nx: number; ny: number; pitch: number } {
  const pitch = Math.max(MIN_PITCH_MM, Math.sqrt((shape.width * shape.height) / MAX_CELLS));
  const nx = Math.max(3, Math.round(shape.width / pitch) + 1);
  const ny = Math.max(3, Math.round(shape.height / pitch) + 1);
  return { nx, ny, pitch: Math.max(shape.width / (nx - 1), shape.height / (ny - 1)) };
}
