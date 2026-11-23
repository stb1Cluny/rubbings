// Binary morphology on 0/1 masks, used to enforce printable line and gap widths.

function pass(src: Uint8Array, dst: Uint8Array, w: number, h: number, before: number, after: number, horizontal: boolean, takeMin: boolean): void {
  const lines = horizontal ? h : w;
  const length = horizontal ? w : h;
  const step = horizontal ? 1 : w;
  for (let line = 0; line < lines; line++) {
    const start = horizontal ? line * w : line;
    for (let k = 0; k < length; k++) {
      const lo = k - before < 0 ? 0 : k - before;
      const hi = k + after >= length ? length - 1 : k + after;
      let value = takeMin ? 1 : 0;
      for (let q = lo; q <= hi; q++) {
        const v = src[start + q * step];
        if (takeMin ? v === 0 : v !== 0) {
          value = takeMin ? 0 : 1;
          break;
        }
      }
      dst[start + k * step] = value;
    }
  }
}

/** Erode with a size x size square whose origin is its top-left sample. */
function erode(src: Uint8Array, w: number, h: number, size: number, tmp: Uint8Array, out: Uint8Array): void {
  pass(src, tmp, w, h, 0, size - 1, true, true);
  pass(tmp, out, w, h, 0, size - 1, false, true);
}

/** Dilate with the reflected square, so erode-then-dilate is a true opening. */
function dilate(src: Uint8Array, w: number, h: number, size: number, tmp: Uint8Array, out: Uint8Array): void {
  pass(src, tmp, w, h, size - 1, 0, true, false);
  pass(tmp, out, w, h, size - 1, 0, false, false);
}

/** Remove raised features narrower than `size` samples. */
export function open(mask: Uint8Array, w: number, h: number, size: number): Uint8Array {
  if (size <= 1) return mask.slice();
  const tmp = new Uint8Array(mask.length);
  const eroded = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  erode(mask, w, h, size, tmp, eroded);
  dilate(eroded, w, h, size, tmp, out);
  return out;
}

/**
 * Clear raised islands smaller than `minArea` samples (8-connected), in place. Isolated specks
 * print as blobs and rub as noise.
 */
export function removeSmallIslands(mask: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  if (minArea <= 1) return mask;
  const visited = new Uint8Array(mask.length);
  const stack = new Int32Array(mask.length);
  const members = new Int32Array(mask.length);
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || visited[seed]) continue;
    let top = 0;
    let count = 0;
    stack[top++] = seed;
    visited[seed] = 1;
    while (top > 0) {
      const i = stack[--top];
      members[count++] = i;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !visited[j]) {
            visited[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
    if (count < minArea) for (let k = 0; k < count; k++) mask[members[k]] = 0;
  }
  return mask;
}

/** Fill gaps narrower than `size` samples. */
export function close(mask: Uint8Array, w: number, h: number, size: number): Uint8Array {
  if (size <= 1) return mask.slice();
  const tmp = new Uint8Array(mask.length);
  const dilated = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  dilate(mask, w, h, size, tmp, dilated);
  erode(dilated, w, h, size, tmp, out);
  return out;
}
