// Plate outlines. All dimensions are millimetres; the plate is centred on the origin with
// +X to the right and +Y up, the same way round as the image.

export type OutlineKind = 'none' | 'circle' | 'oval' | 'square' | 'letter' | 'a4' | 'a5';

export interface OutlineSpec {
  kind: OutlineKind;
  label: string;
  /** Ellipse outlines are cut from their bounding box; the rest are plain rectangles. */
  ellipse: boolean;
  /** Fixed paper size (portrait, mm), or null when the user chooses the size. */
  paper: { width: number; height: number } | null;
  /** Height divided by width in portrait orientation, for user-sized outlines. */
  aspect: number;
  /** The plate takes the picture's own proportions, so nothing is cropped away. */
  followsPicture?: boolean;
}

export const OUTLINES: OutlineSpec[] = [
  { kind: 'none', label: 'None', ellipse: false, paper: null, aspect: 1, followsPicture: true },
  { kind: 'circle', label: 'Circle', ellipse: true, paper: null, aspect: 1 },
  { kind: 'oval', label: 'Oval', ellipse: true, paper: null, aspect: 4 / 3 },
  { kind: 'square', label: 'Square', ellipse: false, paper: null, aspect: 1 },
  { kind: 'a5', label: 'A5', ellipse: false, paper: { width: 148, height: 210 }, aspect: 210 / 148 },
  { kind: 'a4', label: 'A4', ellipse: false, paper: { width: 210, height: 297 }, aspect: 297 / 210 },
  { kind: 'letter', label: 'Letter', ellipse: false, paper: { width: 215.9, height: 279.4 }, aspect: 279.4 / 215.9 },
];

export const MIN_SIZE_MM = 30;
export const MAX_SIZE_MM = 300;
export const DEFAULT_SIZE_MM = 100;
/** A plate that follows a very long, thin picture is never narrower than this. */
export const MIN_SHORT_SIDE_MM = 10;

/** The physical plate: its bounding box and whether the outline is the inscribed ellipse. */
export interface PlateShape {
  ellipse: boolean;
  width: number;
  height: number;
}

export function outlineSpec(kind: OutlineKind): OutlineSpec {
  const spec = OUTLINES.find((o) => o.kind === kind);
  if (!spec) throw new Error(`Unknown outline: ${kind}`);
  return spec;
}

/**
 * Resolve an outline to a plate shape. `sizeMm` is the longest side (or diameter) and only
 * applies to outlines without a fixed paper size. `pictureAspect` (width / height of the
 * picture) is used by the "none" outline, whose plate has the picture's own proportions.
 */
export function plateShape(kind: OutlineKind, sizeMm: number, landscape: boolean, pictureAspect = 1): PlateShape {
  const spec = outlineSpec(kind);
  if (spec.followsPicture) {
    const aspect = pictureAspect > 0 && Number.isFinite(pictureAspect) ? pictureAspect : 1;
    const elongation = Math.max(aspect, 1 / aspect);
    let long = Math.min(MAX_SIZE_MM, Math.max(MIN_SIZE_MM, sizeMm));
    // Very long, thin pictures: grow the plate (up to the maximum) rather than print a sliver.
    if (long / elongation < MIN_SHORT_SIDE_MM) long = Math.min(MAX_SIZE_MM, MIN_SHORT_SIDE_MM * elongation);
    const short = long / elongation;
    return aspect >= 1 ? { ellipse: false, width: long, height: short } : { ellipse: false, width: short, height: long };
  }
  let short: number;
  let long: number;
  if (spec.paper) {
    short = spec.paper.width;
    long = spec.paper.height;
  } else {
    long = Math.min(MAX_SIZE_MM, Math.max(MIN_SIZE_MM, sizeMm));
    short = long / spec.aspect;
  }
  return landscape
    ? { ellipse: spec.ellipse, width: long, height: short }
    : { ellipse: spec.ellipse, width: short, height: long };
}

/** Implicit ellipse value: below 1 inside, 1 on the outline. */
export function ellipseValue(shape: PlateShape, x: number, y: number): number {
  const rx = shape.width / 2;
  const ry = shape.height / 2;
  return (x * x) / (rx * rx) + (y * y) / (ry * ry);
}

/**
 * Distance in mm from a point to the outline, positive inside. Exact for rectangles and a
 * first-order estimate for ellipses (accurate near the outline, which is where it is used).
 */
export function edgeDistance(shape: PlateShape, x: number, y: number): number {
  const rx = shape.width / 2;
  const ry = shape.height / 2;
  if (!shape.ellipse) return Math.min(rx - Math.abs(x), ry - Math.abs(y));
  const f = (x * x) / (rx * rx) + (y * y) / (ry * ry);
  const gx = (2 * x) / (rx * rx);
  const gy = (2 * y) / (ry * ry);
  const gradient = Math.hypot(gx, gy);
  if (gradient < 1e-9) return Math.min(rx, ry);
  // (1 - f) / |grad f| over-estimates far from the outline, so cap it at the smaller radius.
  return Math.min((1 - f) / gradient, Math.min(rx, ry));
}

export function describeShape(shape: PlateShape): string {
  const fmt = (v: number) => (Math.round(v * 10) / 10).toString();
  return `${fmt(shape.width)} × ${fmt(shape.height)} mm`;
}
