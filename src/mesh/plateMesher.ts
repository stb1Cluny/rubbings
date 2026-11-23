// Builds a closed, printable solid from a height field: relief on top, a perimeter wall and a
// flat bottom. Grid vertices are the height samples themselves, so fine lines are not resampled.
import { ellipseValue, type PlateShape } from '../shapes/outline';

export interface HeightField {
  /** Samples across (columns) and down (rows). Row 0 is the top of the image (+Y). */
  nx: number;
  ny: number;
  /** Relief height in mm above the base, row-major. */
  data: Float32Array;
}

export interface PlateMesh {
  /** xyz triples in mm. */
  positions: Float32Array;
  /** Triangles, counter-clockwise seen from outside. */
  indices: Uint32Array;
}

/** Crossing points are kept this far (as a fraction of a cell edge) from grid vertices. */
const CUT_MARGIN = 0.1;
/** The bottom face is a fan over at most about this many ring vertices. */
const MAX_BOTTOM_RING = 512;

class Builder {
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount = 0;
  indexCount = 0;

  constructor(vertexCapacity: number, triangleCapacity: number) {
    this.positions = new Float32Array(vertexCapacity * 3);
    this.indices = new Uint32Array(triangleCapacity * 3);
  }

  vertex(x: number, y: number, z: number): number {
    if (this.vertexCount * 3 + 3 > this.positions.length) {
      const grown = new Float32Array(Math.ceil(this.positions.length * 1.5) + 3);
      grown.set(this.positions);
      this.positions = grown;
    }
    const o = this.vertexCount * 3;
    this.positions[o] = x;
    this.positions[o + 1] = y;
    this.positions[o + 2] = z;
    return this.vertexCount++;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.indices.length) {
      const grown = new Uint32Array(Math.ceil(this.indices.length * 1.5) + 3);
      grown.set(this.indices);
      this.indices = grown;
    }
    this.indices[this.indexCount++] = a;
    this.indices[this.indexCount++] = b;
    this.indices[this.indexCount++] = c;
  }

  finish(): PlateMesh {
    return {
      positions: this.positions.slice(0, this.vertexCount * 3),
      indices: this.indices.slice(0, this.indexCount),
    };
  }
}

/**
 * @param field relief heights (mm) sampled on a grid that spans the shape's bounding box
 * @param shape plate outline
 * @param baseThickness solid thickness under the relief, mm
 */
export function buildPlateMesh(field: HeightField, shape: PlateShape, baseThickness: number): PlateMesh {
  const { nx, ny, data } = field;
  if (nx < 3 || ny < 3) throw new Error('Height field must be at least 3 x 3 samples');
  if (data.length !== nx * ny) throw new Error('Height field size does not match its dimensions');
  if (!(baseThickness > 0)) throw new Error('Base thickness must be positive');

  const dx = shape.width / (nx - 1);
  const dy = shape.height / (ny - 1);
  const xAt = (i: number) => -shape.width / 2 + i * dx;
  const yAt = (j: number) => shape.height / 2 - j * dy;

  const cells = (nx - 1) * (ny - 1);
  const builder = new Builder(nx * ny + 4 * (nx + ny) + 1024, 2 * cells + 12 * (nx + ny) + 2048);

  // --- Top grid vertices -------------------------------------------------------------------
  const vertexId = new Int32Array(nx * ny).fill(-1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xAt(i);
      const y = yAt(j);
      if (shape.ellipse && ellipseValue(shape, x, y) >= 1 - 1e-9) continue;
      const h = Math.max(0, data[j * nx + i]);
      vertexId[j * nx + i] = builder.vertex(x, y, baseThickness + h);
    }
  }
  const zOf = (id: number) => builder.positions[id * 3 + 2];

  /** Split a full cell along the diagonal with the smaller height step (cleaner ridges). */
  const fullCell = (v00: number, v01: number, v11: number, v10: number) => {
    if (Math.abs(zOf(v00) - zOf(v11)) <= Math.abs(zOf(v01) - zOf(v10))) {
      builder.triangle(v00, v01, v11);
      builder.triangle(v00, v11, v10);
    } else {
      builder.triangle(v00, v01, v10);
      builder.triangle(v01, v11, v10);
    }
  };

  /** Top-surface perimeter, counter-clockwise seen from above. */
  let loop: number[];
  /** Loop positions that must stay in the bottom ring (rectangle corners). */
  const keep = new Set<number>();

  if (!shape.ellipse) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        fullCell(
          vertexId[j * nx + i],
          vertexId[(j + 1) * nx + i],
          vertexId[(j + 1) * nx + i + 1],
          vertexId[j * nx + i + 1],
        );
      }
    }
    loop = [];
    keep.add(0);
    for (let j = 0; j < ny; j++) loop.push(vertexId[j * nx]); // left side, going down
    keep.add(loop.length - 1);
    for (let i = 1; i < nx; i++) loop.push(vertexId[(ny - 1) * nx + i]); // bottom, going right
    keep.add(loop.length - 1);
    for (let j = ny - 2; j >= 0; j--) loop.push(vertexId[j * nx + nx - 1]); // right side, going up
    keep.add(loop.length - 1);
    for (let i = nx - 2; i >= 1; i--) loop.push(vertexId[i]); // top, going left
  } else {
    // Vertices where the outline crosses a grid edge, shared by the two cells on that edge.
    const hEdge = new Int32Array(nx * ny).fill(-1); // edge (i,j)-(i+1,j)
    const vEdge = new Int32Array(nx * ny).fill(-1); // edge (i,j)-(i,j+1)
    const crossing = (i0: number, j0: number, i1: number, j1: number): number => {
      const horizontal = j0 === j1;
      const table = horizontal ? hEdge : vEdge;
      const slot = Math.min(j0, j1) * nx + Math.min(i0, i1);
      if (table[slot] >= 0) return table[slot];
      // (i0,j0) is the inside end. Bisect for the outline along the edge.
      const ax = xAt(i0);
      const ay = yAt(j0);
      const bx = xAt(i1);
      const by = yAt(j1);
      let lo = 0;
      let hi = 1;
      for (let step = 0; step < 40; step++) {
        const mid = (lo + hi) / 2;
        if (ellipseValue(shape, ax + (bx - ax) * mid, ay + (by - ay) * mid) < 1) lo = mid;
        else hi = mid;
      }
      const t = Math.min(1 - CUT_MARGIN, Math.max(CUT_MARGIN, (lo + hi) / 2));
      const id = builder.vertex(ax + (bx - ax) * t, ay + (by - ay) * t, baseThickness);
      table[slot] = id;
      return id;
    };

    const next = new Map<number, number>();
    const polygon: number[] = [];
    const cornerI = [0, 0, 1, 1];
    const cornerJ = [0, 1, 1, 0];
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const v00 = vertexId[j * nx + i];
        const v01 = vertexId[(j + 1) * nx + i];
        const v11 = vertexId[(j + 1) * nx + i + 1];
        const v10 = vertexId[j * nx + i + 1];
        const insideCount = (v00 >= 0 ? 1 : 0) + (v01 >= 0 ? 1 : 0) + (v11 >= 0 ? 1 : 0) + (v10 >= 0 ? 1 : 0);
        if (insideCount === 0) continue;
        if (insideCount === 4) {
          fullCell(v00, v01, v11, v10);
          continue;
        }
        // Walk the corners counter-clockwise: top-left, bottom-left, bottom-right, top-right.
        const corner = [v00, v01, v11, v10];
        polygon.length = 0;
        // `order` records crossings in walk order: positive = exit (in -> out), negative = entry.
        const order: number[] = [];
        for (let k = 0; k < 4; k++) {
          const a = corner[k];
          const b = corner[(k + 1) % 4];
          const ai = i + cornerI[k];
          const aj = j + cornerJ[k];
          const bi = i + cornerI[(k + 1) % 4];
          const bj = j + cornerJ[(k + 1) % 4];
          if (a >= 0) polygon.push(a);
          if (a >= 0 && b < 0) {
            const x = crossing(ai, aj, bi, bj);
            polygon.push(x);
            order.push(x + 1);
          } else if (a < 0 && b >= 0) {
            const x = crossing(bi, bj, ai, aj);
            polygon.push(x);
            order.push(-(x + 1));
          }
        }
        // Each exit is followed (cyclically) by the entry that closes that outline segment.
        for (let k = 0; k < order.length; k++) {
          if (order[k] > 0) {
            const entry = order[(k + 1) % order.length];
            next.set(order[k] - 1, -entry - 1);
          }
        }
        for (let k = 1; k + 1 < polygon.length; k++) builder.triangle(polygon[0], polygon[k], polygon[k + 1]);
      }
    }
    if (next.size < 3) throw new Error('Outline is too small for this grid');
    loop = [];
    const start = next.keys().next().value as number;
    let current = start;
    do {
      loop.push(current);
      const following = next.get(current);
      if (following === undefined) throw new Error('Outline loop is broken');
      current = following;
    } while (current !== start && loop.length <= next.size);
    if (loop.length !== next.size) throw new Error('Outline is not a single closed loop');
  }

  // --- Bottom ring (a thinned copy of the perimeter), wall and bottom face -----------------
  const m = loop.length;
  const stride = Math.max(1, Math.ceil(m / MAX_BOTTOM_RING));
  const ringAt: number[] = [];
  for (let s = 0; s < m; s++) if (s % stride === 0 || keep.has(s)) ringAt.push(s);
  const ringVertex = ringAt.map((s) => {
    const o = loop[s] * 3;
    return builder.vertex(builder.positions[o], builder.positions[o + 1], 0);
  });
  const centre = builder.vertex(0, 0, 0);

  for (let r = 0; r < ringAt.length; r++) {
    const a = ringAt[r];
    const b = r + 1 < ringAt.length ? ringAt[r + 1] : m; // loop position, may equal m (wraps to 0)
    const below = ringVertex[r];
    const belowNext = ringVertex[(r + 1) % ringAt.length];
    for (let s = a; s < b; s++) builder.triangle(loop[(s + 1) % m], loop[s], below);
    builder.triangle(below, belowNext, loop[b % m]);
    builder.triangle(centre, belowNext, below);
  }

  return builder.finish();
}

export function triangleCount(mesh: PlateMesh): number {
  return mesh.indices.length / 3;
}

/**
 * Number of triangles buildPlateMesh will produce for a shape and grid. It depends only on the
 * outline and the grid, not on the heights, so the STL size is known before the mesh is built.
 */
export function countPlateTriangles(shape: PlateShape, nx: number, ny: number): number {
  const ringSize = (loopLength: number, kept: number[] = []): number => {
    const stride = Math.max(1, Math.ceil(loopLength / MAX_BOTTOM_RING));
    let count = Math.ceil(loopLength / stride);
    for (const s of kept) if (s % stride !== 0) count++;
    return count;
  };

  if (!shape.ellipse) {
    const loopLength = 2 * (nx - 1) + 2 * (ny - 1);
    const corners = [0, ny - 1, ny - 1 + nx - 1, ny - 1 + nx - 1 + ny - 1];
    const ring = ringSize(loopLength, corners);
    // Top: two per cell. Wall: one per perimeter edge plus one per ring segment. Bottom: a fan.
    return 2 * (nx - 1) * (ny - 1) + loopLength + 2 * ring;
  }

  const dx = shape.width / (nx - 1);
  const dy = shape.height / (ny - 1);
  const inside = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const y = shape.height / 2 - j * dy;
    for (let i = 0; i < nx; i++) {
      inside[j * nx + i] = ellipseValue(shape, -shape.width / 2 + i * dx, y) >= 1 - 1e-9 ? 0 : 1;
    }
  }
  let top = 0;
  let loopLength = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      // Corners in the mesher's walk order: top-left, bottom-left, bottom-right, top-right.
      const a = inside[j * nx + i];
      const b = inside[(j + 1) * nx + i];
      const c = inside[(j + 1) * nx + i + 1];
      const d = inside[j * nx + i + 1];
      const count = a + b + c + d;
      if (count === 0) continue;
      if (count === 4) {
        top += 2;
        continue;
      }
      const crossings = (a ^ b) + (b ^ c) + (c ^ d) + (d ^ a);
      top += count + crossings - 2; // a fan over the clipped cell's polygon
      loopLength += crossings / 2; // one outline segment per exit crossing
    }
  }
  return top + loopLength + 2 * ringSize(loopLength);
}
