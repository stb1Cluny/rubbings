import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32, encodeGreyAlphaPng, heightsToGrey } from '../../src/image/png';

interface Decoded {
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  grey: Uint8Array;
  alpha: Uint8Array;
  chunkTypes: string[];
}

/** Just enough of a PNG reader to check our own output: verifies every CRC and inflates IDAT. */
function decode(png: Uint8Array): Decoded {
  expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunkTypes: string[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const data: Uint8Array[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    expect(view.getUint32(offset + 8 + length)).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
    chunkTypes.push(type);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = body[8];
      colourType = body[9];
    } else if (type === 'IDAT') {
      data.push(body);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = 1 + width * 2;
  expect(raw.length).toBe(stride * height);
  const grey = new Uint8Array(width * height);
  const alpha = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0);
    for (let x = 0; x < width; x++) {
      grey[y * width + x] = raw[y * stride + 1 + x * 2];
      alpha[y * width + x] = raw[y * stride + 2 + x * 2];
    }
  }
  return { width, height, bitDepth, colourType, grey, alpha, chunkTypes };
}

describe('encodeGreyAlphaPng', () => {
  it('matches the standard CRC-32 check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips grey and alpha exactly', async () => {
    const width = 37;
    const height = 23;
    const grey = Uint8Array.from({ length: width * height }, (_, i) => (i * 7) % 256);
    const alpha = Uint8Array.from({ length: width * height }, (_, i) => (i % 5 === 0 ? 0 : 255));
    const decoded = decode(await encodeGreyAlphaPng(grey, alpha, width, height));
    expect(decoded.chunkTypes).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect([decoded.width, decoded.height, decoded.bitDepth, decoded.colourType]).toEqual([width, height, 8, 4]);
    expect(Array.from(decoded.grey)).toEqual(Array.from(grey));
    expect(Array.from(decoded.alpha)).toEqual(Array.from(alpha));
  });

  it('is fully opaque when no alpha is given, and compresses flat areas well', async () => {
    const width = 400;
    const height = 300;
    const png = await encodeGreyAlphaPng(new Uint8Array(width * height).fill(128), null, width, height);
    const decoded = decode(png);
    expect(decoded.alpha.every((a) => a === 255)).toBe(true);
    expect(png.length).toBeLessThan(5000);
  });

  it('rejects a size mismatch', async () => {
    await expect(encodeGreyAlphaPng(new Uint8Array(10), null, 4, 4)).rejects.toThrow();
  });
});

describe('heightsToGrey', () => {
  it('maps flat to black and full relief to white', () => {
    const grey = heightsToGrey(Float32Array.from([0, 0.4, 0.8, 1.2]), 0.8);
    expect(Array.from(grey)).toEqual([0, 128, 255, 255]);
    expect(Array.from(heightsToGrey(Float32Array.from([0, 0.5]), 0))).toEqual([0, 0]);
  });
});
