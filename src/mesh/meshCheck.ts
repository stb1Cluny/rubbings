// Checks that an indexed triangle mesh is a closed, consistently oriented solid.
import type { PlateMesh } from './plateMesher';

export interface MeshReport {
  triangles: number;
  vertices: number;
  edges: number;
  /** Edges used by one triangle only, or by more than two. Zero for a closed manifold. */
  badEdges: number;
  /** Edges whose two triangles disagree on orientation. Zero when normals are consistent. */
  flippedEdges: number;
  /** Triangles with a repeated vertex. */
  degenerate: number;
  /** vertices - edges + triangles; 2 for a solid with no holes or handles. */
  eulerCharacteristic: number;
  /** Signed volume in mm^3; positive when triangles face outward. */
  volume: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export function checkMesh(mesh: PlateMesh): MeshReport {
  const { positions, indices } = mesh;
  const vertexTotal = positions.length / 3;
  const triangles = indices.length / 3;

  // Every undirected edge must appear exactly once in each direction. Encode each directed edge
  // as min*V+max and sort the "forward" (a<b) and "backward" (a>b) lists separately.
  const forward = new Float64Array(indices.length);
  const backward = new Float64Array(indices.length);
  let nf = 0;
  let nb = 0;
  let degenerate = 0;
  const used = new Uint8Array(vertexTotal);
  let volume = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    used[a] = used[b] = used[c] = 1;
    if (a === b || b === c || c === a) {
      degenerate++;
      continue;
    }
    const tri = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const p = tri[k];
      const q = tri[(k + 1) % 3];
      if (p < q) forward[nf++] = p * vertexTotal + q;
      else backward[nb++] = q * vertexTotal + p;
    }
    const ax = positions[a * 3];
    const ay = positions[a * 3 + 1];
    const az = positions[a * 3 + 2];
    const bx = positions[b * 3];
    const by = positions[b * 3 + 1];
    const bz = positions[b * 3 + 2];
    const cx = positions[c * 3];
    const cy = positions[c * 3 + 1];
    const cz = positions[c * 3 + 2];
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }

  let vertices = 0;
  for (let v = 0; v < vertexTotal; v++) {
    if (!used[v]) continue;
    vertices++;
    for (let k = 0; k < 3; k++) {
      const value = positions[v * 3 + k];
      if (value < min[k]) min[k] = value;
      if (value > max[k]) max[k] = value;
    }
  }

  const f = forward.subarray(0, nf).sort();
  const b = backward.subarray(0, nb).sort();
  let i = 0;
  let j = 0;
  let edges = 0;
  let badEdges = 0;
  let flippedEdges = 0;
  while (i < f.length || j < b.length) {
    const key = i < f.length && (j >= b.length || f[i] <= b[j]) ? f[i] : b[j];
    let countForward = 0;
    let countBackward = 0;
    while (i < f.length && f[i] === key) {
      i++;
      countForward++;
    }
    while (j < b.length && b[j] === key) {
      j++;
      countBackward++;
    }
    edges++;
    if (countForward + countBackward !== 2) badEdges++;
    else if (countForward !== 1) flippedEdges++;
  }

  return {
    triangles,
    vertices,
    edges,
    badEdges,
    flippedEdges,
    degenerate,
    eulerCharacteristic: vertices - edges + (triangles - degenerate),
    volume,
    bounds: { min, max },
  };
}

export function isClosedSolid(report: MeshReport): boolean {
  return (
    report.badEdges === 0 &&
    report.flippedEdges === 0 &&
    report.degenerate === 0 &&
    report.eulerCharacteristic === 2 &&
    report.volume > 0
  );
}
