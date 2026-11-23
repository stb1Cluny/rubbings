import { describe, expect, it } from 'vitest';
import { checkMesh, isClosedSolid } from '../../src/mesh/meshCheck';
import { buildPlateMesh, countPlateTriangles, type HeightField } from '../../src/mesh/plateMesher';
import { parseBinaryStl, stlByteLength, writeBinaryStl } from '../../src/mesh/stlWriter';
import { plateShape, type PlateShape } from '../../src/shapes/outline';

const BASE = 2;

function field(nx: number, ny: number, fill: (i: number, j: number) => number): HeightField {
  const data = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[j * nx + i] = fill(i, j);
  return { nx, ny, data };
}

/** Deterministic pseudo-random relief in 0..1 mm. */
function noisy(i: number, j: number): number {
  const v = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

function concat(parts: ArrayBuffer[]): ArrayBuffer {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(new Uint8Array(part), offset);
    offset += part.byteLength;
  }
  return out.buffer;
}

const shapes: Array<[string, PlateShape, number, number]> = [
  ['square', plateShape('square', 40, false), 81, 81],
  ['A5 portrait', plateShape('a5', 0, false), 75, 106],
  ['Letter landscape', plateShape('letter', 0, true), 113, 87],
  ['circle', plateShape('circle', 50, false), 101, 101],
  ['circle on an even grid', plateShape('circle', 50, false), 100, 100],
  ['oval portrait', plateShape('oval', 60, false), 91, 121],
  ['oval landscape', plateShape('oval', 60, true), 121, 91],
];

describe('buildPlateMesh', () => {
  for (const [name, shape, nx, ny] of shapes) {
    it(`makes a closed solid for ${name} with rough relief`, () => {
      const mesh = buildPlateMesh(field(nx, ny, noisy), shape, BASE);
      const report = checkMesh(mesh);
      expect(report.badEdges).toBe(0);
      expect(report.flippedEdges).toBe(0);
      expect(report.degenerate).toBe(0);
      expect(report.eulerCharacteristic).toBe(2);
      expect(report.volume).toBeGreaterThan(0);
      expect(isClosedSolid(report)).toBe(true);
    });

    it(`matches the requested size for ${name}`, () => {
      const mesh = buildPlateMesh(field(nx, ny, () => 0), shape, BASE);
      const report = checkMesh(mesh);
      const pitch = Math.max(shape.width / (nx - 1), shape.height / (ny - 1));
      // Rectangles are exact; ellipse crossings are kept slightly off grid vertices.
      const tolerance = shape.ellipse ? pitch * 0.25 : 1e-4;
      expect(Math.abs(report.bounds.max[0] - shape.width / 2)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(report.bounds.min[0] + shape.width / 2)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(report.bounds.max[1] - shape.height / 2)).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(report.bounds.min[1] + shape.height / 2)).toBeLessThanOrEqual(tolerance);
      expect(report.bounds.min[2]).toBe(0);
      expect(report.bounds.max[2]).toBeCloseTo(BASE, 5);

      const area = shape.ellipse ? (Math.PI * shape.width * shape.height) / 4 : shape.width * shape.height;
      expect(report.volume / (area * BASE)).toBeGreaterThan(shape.ellipse ? 0.985 : 0.99999);
      expect(report.volume / (area * BASE)).toBeLessThan(1.00001);
    });
  }

  for (const [name, shape, nx, ny] of shapes) {
    it(`predicts the triangle count for ${name} without building the mesh`, () => {
      const mesh = buildPlateMesh(field(nx, ny, noisy), shape, BASE);
      expect(countPlateTriangles(shape, nx, ny)).toBe(mesh.indices.length / 3);
    });
  }

  it('predicts the triangle count for large plates whose bottom ring is thinned', () => {
    for (const shape of [plateShape('square', 150, false), plateShape('circle', 150, false), plateShape('none', 200, false, 16 / 9)]) {
      const nx = Math.round(shape.width / 0.25) + 1;
      const ny = Math.round(shape.height / 0.25) + 1;
      const mesh = buildPlateMesh(field(nx, ny, () => 0), shape, BASE);
      expect(countPlateTriangles(shape, nx, ny)).toBe(mesh.indices.length / 3);
    }
  });

  it('adds the relief volume on top of the base', () => {
    const shape = plateShape('square', 40, false);
    const flat = checkMesh(buildPlateMesh(field(41, 41, () => 0), shape, BASE)).volume;
    // A 20 mm square block, 1 mm high, in the middle (sloped sides one cell wide).
    const raised = checkMesh(
      buildPlateMesh(field(41, 41, (i, j) => (i >= 10 && i <= 30 && j >= 10 && j <= 30 ? 1 : 0)), shape, BASE),
    ).volume;
    expect(raised - flat).toBeGreaterThan(20 * 20);
    expect(raised - flat).toBeLessThan(22 * 22);
  });

  it('does not mirror the image: top-left of the picture is at -X, +Y', () => {
    const shape = plateShape('square', 40, false);
    // One raised sample near the top-left corner of the image (small column, small row).
    const mesh = buildPlateMesh(field(41, 41, (i, j) => (i === 5 && j === 8 ? 1 : 0)), shape, BASE);
    let peak = -1;
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      if (peak < 0 || mesh.positions[v * 3 + 2] > mesh.positions[peak * 3 + 2]) peak = v;
    }
    expect(mesh.positions[peak * 3 + 2]).toBeCloseTo(BASE + 1, 5);
    expect(mesh.positions[peak * 3]).toBeCloseTo(-20 + 5, 5); // left of centre
    expect(mesh.positions[peak * 3 + 1]).toBeCloseTo(20 - 8, 5); // above centre
  });

  it('faces the relief upward and the bottom downward', () => {
    const shape = plateShape('square', 40, false);
    const mesh = buildPlateMesh(field(11, 11, () => 0), shape, BASE);
    const p = mesh.positions;
    for (let t = 0; t < mesh.indices.length; t += 3) {
      const [a, b, c] = [mesh.indices[t] * 3, mesh.indices[t + 1] * 3, mesh.indices[t + 2] * 3];
      const nz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
      const zs = [p[a + 2], p[b + 2], p[c + 2]];
      if (zs.every((z) => z === BASE)) expect(nz).toBeGreaterThan(0);
      if (zs.every((z) => z === 0)) expect(nz).toBeLessThan(0);
    }
  });

  it('rejects bad input', () => {
    const shape = plateShape('square', 40, false);
    expect(() => buildPlateMesh(field(2, 2, () => 0), shape, BASE)).toThrow();
    expect(() => buildPlateMesh(field(10, 10, () => 0), shape, 0)).toThrow();
  });
});

describe('writeBinaryStl', () => {
  it('round-trips to the same closed solid', () => {
    const shape = plateShape('oval', 60, false);
    const mesh = buildPlateMesh(field(91, 121, noisy), shape, BASE);
    const buffer = concat(writeBinaryStl(mesh));
    expect(buffer.byteLength).toBe(stlByteLength(mesh.indices.length / 3));

    const parsed = parseBinaryStl(buffer);
    const before = checkMesh(mesh);
    const after = checkMesh(parsed);
    expect(after.triangles).toBe(before.triangles);
    expect(after.vertices).toBe(before.vertices);
    expect(isClosedSolid(after)).toBe(true);
    expect(after.volume).toBeCloseTo(before.volume, 1);
  });

  it('does not start with "solid" and spans several chunks for big meshes', () => {
    const shape = plateShape('square', 100, false);
    const mesh = buildPlateMesh(field(301, 301, noisy), shape, BASE);
    const parts = writeBinaryStl(mesh);
    expect(parts.length).toBeGreaterThan(2);
    const header = new TextDecoder().decode(new Uint8Array(parts[0], 0, 5));
    expect(header).not.toBe('solid');
    expect(isClosedSolid(checkMesh(parseBinaryStl(concat(parts))))).toBe(true);
  });
});
