export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Render a region of the source canvas at a new size. Large reductions are done in halving
 * steps, because a single big downscale is poorly filtered in some browsers.
 */
export function renderRegion(source: HTMLCanvasElement, region: Region, outWidth: number, outHeight: number): ImageData {
  let current: CanvasImageSource = source;
  let sx = region.x;
  let sy = region.y;
  let sw = region.width;
  let sh = region.height;

  while (sw / outWidth > 2 && sh / outHeight > 2) {
    const halfWidth = Math.max(outWidth, Math.ceil(sw / 2));
    const halfHeight = Math.max(outHeight, Math.ceil(sh / 2));
    const step = document.createElement('canvas');
    step.width = halfWidth;
    step.height = halfHeight;
    const c2d = step.getContext('2d')!;
    c2d.imageSmoothingQuality = 'high';
    c2d.drawImage(current, sx, sy, sw, sh, 0, 0, halfWidth, halfHeight);
    current = step;
    sx = 0;
    sy = 0;
    sw = halfWidth;
    sh = halfHeight;
  }

  const out = document.createElement('canvas');
  out.width = outWidth;
  out.height = outHeight;
  const c2d = out.getContext('2d', { willReadFrequently: true })!;
  c2d.fillStyle = '#ffffff';
  c2d.fillRect(0, 0, outWidth, outHeight);
  c2d.imageSmoothingQuality = 'high';
  c2d.drawImage(current, sx, sy, sw, sh, 0, 0, outWidth, outHeight);
  return c2d.getImageData(0, 0, outWidth, outHeight);
}
