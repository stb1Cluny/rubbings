// Binary STL writer. STL has no units; slicers read the numbers as millimetres.
import type { PlateMesh } from './plateMesher';

const HEADER_BYTES = 80;
const BYTES_PER_TRIANGLE = 50;
const TRIANGLES_PER_CHUNK = 100_000;

/**
 * Encode a mesh as binary STL, returned in chunks so a large plate never needs one huge buffer.
 * Shared vertices are written from the same Float32 values, so slicers can weld them exactly.
 */
export function writeBinaryStl(mesh: PlateMesh, title = 'Rubbing plate (mm)'): ArrayBuffer[] {
  const { positions, indices } = mesh;
  const triangles = indices.length / 3;
  const parts: ArrayBuffer[] = [];

  const header = new ArrayBuffer(HEADER_BYTES + 4);
  const headerBytes = new Uint8Array(header);
  // A binary STL header must not begin with "solid", or some readers treat the file as ASCII.
  const text = `Binary STL - ${title}`.slice(0, HEADER_BYTES);
  for (let i = 0; i < text.length; i++) headerBytes[i] = text.charCodeAt(i) & 0x7f;
  new DataView(header).setUint32(HEADER_BYTES, triangles, true);
  parts.push(header);

  for (let start = 0; start < triangles; start += TRIANGLES_PER_CHUNK) {
    const count = Math.min(TRIANGLES_PER_CHUNK, triangles - start);
    const chunk = new ArrayBuffer(count * BYTES_PER_TRIANGLE);
    const view = new DataView(chunk);
    for (let t = 0; t < count; t++) {
      const i = (start + t) * 3;
      const a = indices[i] * 3;
      const b = indices[i + 1] * 3;
      const c = indices[i + 2] * 3;
      const ux = positions[b] - positions[a];
      const uy = positions[b + 1] - positions[a + 1];
      const uz = positions[b + 2] - positions[a + 2];
      const vx = positions[c] - positions[a];
      const vy = positions[c + 1] - positions[a + 1];
      const vz = positions[c + 2] - positions[a + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length;
      ny /= length;
      nz /= length;
      let o = t * BYTES_PER_TRIANGLE;
      view.setFloat32(o, nx, true);
      view.setFloat32(o + 4, ny, true);
      view.setFloat32(o + 8, nz, true);
      o += 12;
      for (const vertex of [a, b, c]) {
        view.setFloat32(o, positions[vertex], true);
        view.setFloat32(o + 4, positions[vertex + 1], true);
        view.setFloat32(o + 8, positions[vertex + 2], true);
        o += 12;
      }
      view.setUint16(o, 0, true);
    }
    parts.push(chunk);
  }
  return parts;
}

export function stlByteLength(triangles: number): number {
  return HEADER_BYTES + 4 + triangles * BYTES_PER_TRIANGLE;
}

/** Read a binary STL back into an indexed mesh, welding vertices with identical coordinates. */
export function parseBinaryStl(buffer: ArrayBuffer): PlateMesh {
  const view = new DataView(buffer);
  const triangles = view.getUint32(HEADER_BYTES, true);
  const ids = new Map<string, number>();
  const positions: number[] = [];
  const indices = new Uint32Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    let o = HEADER_BYTES + 4 + t * BYTES_PER_TRIANGLE + 12;
    for (let k = 0; k < 3; k++) {
      const x = view.getFloat32(o, true);
      const y = view.getFloat32(o + 4, true);
      const z = view.getFloat32(o + 8, true);
      o += 12;
      const key = `${x},${y},${z}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = positions.length / 3;
        ids.set(key, id);
        positions.push(x, y, z);
      }
      indices[t * 3 + k] = id;
    }
  }
  return { positions: new Float32Array(positions), indices };
}
