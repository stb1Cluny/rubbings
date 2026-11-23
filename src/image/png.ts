// Minimal PNG encoder for 8-bit greyscale + alpha. Writing the file ourselves (rather than
// through a canvas) keeps every grey level exact: no colour management, no alpha premultiply.

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** zlib-wrapped deflate, which is exactly what a PNG's IDAT chunk holds. */
async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param grey one byte per pixel, row-major, 0 = black .. 255 = white
 * @param alpha one byte per pixel (0 = transparent), or null for fully opaque
 */
export async function encodeGreyAlphaPng(
  grey: Uint8Array,
  alpha: Uint8Array | null,
  width: number,
  height: number,
): Promise<Uint8Array> {
  if (grey.length !== width * height) throw new Error('Pixel count does not match the image size');
  // Each row: a filter byte (0 = none), then grey and alpha for every pixel.
  const stride = 1 + width * 2;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    let o = y * stride + 1;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      raw[o++] = grey[i];
      raw[o++] = alpha ? alpha[i] : 255;
    }
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 4; // colour type: greyscale with alpha
  header[10] = 0; // compression: deflate
  header[11] = 0; // filter method
  header[12] = 0; // no interlace

  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', header),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Plate heights as a greyscale image: black is the plate's flat surface, white the tallest
 * relief.
 */
export function heightsToGrey(heights: Float32Array, reliefHeight: number): Uint8Array {
  const grey = new Uint8Array(heights.length);
  const scale = reliefHeight > 0 ? 255 / reliefHeight : 0;
  for (let i = 0; i < grey.length; i++) grey[i] = Math.max(0, Math.min(255, Math.round(heights[i] * scale)));
  return grey;
}
