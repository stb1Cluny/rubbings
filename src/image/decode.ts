// Image decoding. Everything goes through <img> + canvas, which applies EXIF rotation reliably.

/** Longest side of the working copy. Larger images are scaled down on load. */
export const MAX_WORKING_SIDE = 4096;

export class ImageLoadError extends Error {
  constructor(
    message: string,
    /** 'blocked': the image could not be read (often a cross-origin block). 'decode': not an image. */
    readonly kind: 'blocked' | 'decode',
  ) {
    super(message);
  }
}

function loadElement(src: string, crossOrigin: boolean): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) {
      // Ask the other site for permission to read pixels, and send it no referrer or cookies.
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
    }
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

/** Draw onto white (so transparency becomes paper) at no more than the working size. */
function toWorkingCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new ImageLoadError('That file has no pixels to read.', 'decode');
  const scale = Math.min(1, MAX_WORKING_SIDE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
  c2d.fillStyle = '#ffffff';
  c2d.fillRect(0, 0, canvas.width, canvas.height);
  c2d.imageSmoothingQuality = 'high';
  c2d.drawImage(img, 0, 0, canvas.width, canvas.height);
  // Reading a pixel throws if the browser refused cross-origin access.
  c2d.getImageData(0, 0, 1, 1);
  return canvas;
}

export async function decodeBlob(blob: Blob): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadElement(url, false);
    return toWorkingCanvas(img);
  } catch (error) {
    if (error instanceof ImageLoadError) throw error;
    throw new ImageLoadError('That file could not be read as an image.', 'decode');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Load an image from a link, straight from the browser. This only works when the image's host
 * allows other sites to read it; otherwise the browser blocks access and we report 'blocked'.
 */
export async function decodeLink(link: string): Promise<HTMLCanvasElement> {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new ImageLoadError('That does not look like a link.', 'decode');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'data:') {
    throw new ImageLoadError('Only web links (https://…) can be loaded.', 'decode');
  }
  try {
    const img = await loadElement(url.href, true);
    return toWorkingCanvas(img);
  } catch (error) {
    if (error instanceof ImageLoadError) throw error;
    throw new ImageLoadError('The browser could not read that image.', 'blocked');
  }
}
