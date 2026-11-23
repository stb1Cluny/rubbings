/// <reference lib="webworker" />
// Relief worker: builds the per-crop maps once, then recomposes heights on every slider change.
import { edgeDistance, type PlateShape } from '../shapes/outline';
import {
  depthEdges,
  depthHistogram,
  foregroundWeight,
  guidedFilter,
  normaliseDepth,
  otsuSplit,
  resampleDepth,
  type DepthSource,
} from './bands';
import {
  BAND_SOFTNESS,
  ZONE_PICTURE,
  buildZones,
  compose,
  detailQuantiles,
  type ReliefMaps,
  type ReliefParams,
} from './compose';
import { computeDetail, stretchContrast } from './detail';
import { simulateRubbing } from './rubbingSim';

export type ReliefRequest =
  | {
      type: 'prepare';
      id: number;
      /** The cropped picture at raster resolution, RGBA. */
      rgba: Uint8ClampedArray;
      nx: number;
      ny: number;
      pitch: number;
      shape: PlateShape;
      depth: DepthSource | null;
    }
  | { type: 'compose'; id: number; params: ReliefParams; rubbing: boolean; tint: boolean };

export type ReliefResponse =
  | { type: 'prepared'; id: number; histogram: Float32Array; split: number; hasDepth: boolean }
  | {
      type: 'composed';
      id: number;
      heights: Float32Array;
      rubbing: Uint8ClampedArray | null;
      tint: Uint8ClampedArray | null;
      /** Share of the picture area that is raised, 0..1. */
      raisedShare: number;
    }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: ReliefResponse, transfer: Transferable[] = []) => ctx.postMessage(message, transfer);

let maps: ReliefMaps | null = null;
let plate: Uint8Array | null = null;

function prepare(request: Extract<ReliefRequest, { type: 'prepare' }>): void {
  const { rgba, nx, ny, pitch, shape } = request;
  const n = nx * ny;
  const luminance = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    luminance[i] = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
  }
  const picture = stretchContrast(luminance);
  const zone = buildZones(shape, nx, ny);

  plate = new Uint8Array(n);
  const dx = shape.width / (nx - 1);
  const dy = shape.height / (ny - 1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      plate[j * nx + i] = edgeDistance(shape, -shape.width / 2 + i * dx, shape.height / 2 - j * dy) >= 0 ? 1 : 0;
    }
  }

  const detail = computeDetail(picture, nx, ny, pitch);
  const pictureZone = new Uint8Array(n);
  for (let i = 0; i < n; i++) pictureZone[i] = zone[i] === ZONE_PICTURE ? 1 : 0;

  let depth: Float32Array;
  let edge: Float32Array;
  const hasDepth = request.depth !== null;
  if (request.depth) {
    const coarse = normaliseDepth(resampleDepth(request.depth, nx, ny), plate);
    // Snap the depth map's soft edges onto the picture's own outlines (2 mm window).
    const sharpened = guidedFilter(picture, coarse, nx, ny, Math.max(2, Math.round(2 / pitch)), 0.002);
    depth = normaliseDepth(sharpened, plate);
    edge = depthEdges(depth, nx, ny, 0.6 / pitch);
  } else {
    depth = new Float32Array(n).fill(1);
    edge = new Float32Array(n);
  }

  maps = { nx, ny, pitch, detail, depth, edge, zone, quantiles: detailQuantiles(detail, pictureZone) };
  const histogram = depthHistogram(depth, plate);
  post({ type: 'prepared', id: request.id, histogram, split: hasDepth ? otsuSplit(histogram) : 0.5, hasDepth });
}

const BACKGROUND_TINT = [70, 130, 200];
const FOREGROUND_TINT = [240, 150, 60];

function run(request: Extract<ReliefRequest, { type: 'compose' }>): void {
  if (!maps || !plate) throw new Error('Relief maps are not ready');
  const { params } = request;
  const heights = compose(maps, params);
  const n = heights.length;

  let raised = 0;
  let picture = 0;
  for (let i = 0; i < n; i++) {
    if (maps.zone[i] !== ZONE_PICTURE) continue;
    picture++;
    if (heights[i] > 0) raised++;
  }

  const rubbing = request.rubbing
    ? simulateRubbing(heights, plate, maps.nx, maps.ny, maps.pitch, params.reliefHeight)
    : null;

  let tint: Uint8ClampedArray | null = null;
  if (request.tint) {
    tint = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const weight = foregroundWeight(maps.depth[i], params.split, BAND_SOFTNESS);
      for (let c = 0; c < 3; c++) tint[i * 4 + c] = BACKGROUND_TINT[c] + (FOREGROUND_TINT[c] - BACKGROUND_TINT[c]) * weight;
      tint[i * 4 + 3] = 255;
    }
  }

  const transfer: Transferable[] = [heights.buffer];
  if (rubbing) transfer.push(rubbing.buffer);
  if (tint) transfer.push(tint.buffer);
  post({ type: 'composed', id: request.id, heights, rubbing, tint, raisedShare: picture ? raised / picture : 0 }, transfer);
}

ctx.onmessage = (event: MessageEvent<ReliefRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'prepare') prepare(request);
    else run(request);
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
};
