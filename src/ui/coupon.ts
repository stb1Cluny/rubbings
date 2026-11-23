// Calibration coupon: a small test plate with lines of known widths at known heights.
// Print it, rub it, and see which widths and heights come through cleanly.
import type { PlateShape } from '../shapes/outline';

export const COUPON_SHAPE: PlateShape = { ellipse: false, width: 78, height: 50 };
export const COUPON_PITCH = 0.2;
export const COUPON_BASE = 1.6;

const WIDTHS = [0.4, 0.5, 0.6, 0.8, 1.0, 1.2];
const HEIGHTS = [0.4, 0.6, 0.8, 1.2];
const MAX_HEIGHT = 1.2;

/** Returns relief heights (mm) for the coupon, sampled every COUPON_PITCH. */
export function buildCoupon(): { heights: Float32Array; nx: number; ny: number } {
  const nx = Math.round(COUPON_SHAPE.width / COUPON_PITCH) + 1;
  const ny = Math.round(COUPON_SHAPE.height / COUPON_PITCH) + 1;
  const canvas = document.createElement('canvas');
  canvas.width = nx;
  canvas.height = ny;
  const c = canvas.getContext('2d', { willReadFrequently: true })!;
  c.fillStyle = '#000';
  c.fillRect(0, 0, nx, ny);
  const px = (mm: number) => mm / COUPON_PITCH;
  const grey = (height: number) => {
    const v = Math.round((height / MAX_HEIGHT) * 255);
    return `rgb(${v},${v},${v})`;
  };

  const left = 11; // room for the row labels
  const top = 8; // room for the column labels
  const cellWidth = (COUPON_SHAPE.width - left - 3) / WIDTHS.length;
  const cellHeight = (COUPON_SHAPE.height - top - 3) / HEIGHTS.length;

  c.textBaseline = 'middle';
  c.textAlign = 'center';
  c.font = `bold ${px(3.6)}px system-ui, Arial, sans-serif`;
  c.fillStyle = grey(0.8);
  WIDTHS.forEach((width, column) => {
    c.fillText(width.toFixed(1), px(left + cellWidth * (column + 0.5)), px(top / 2 + 0.6));
  });
  HEIGHTS.forEach((height, row) => {
    c.fillText(height.toFixed(1), px(left / 2 + 0.4), px(top + cellHeight * (row + 0.5)));
  });

  HEIGHTS.forEach((height, row) => {
    WIDTHS.forEach((width, column) => {
      c.fillStyle = grey(height);
      const x0 = left + cellWidth * column + 1;
      const y0 = top + cellHeight * row + 1;
      const usableHeight = cellHeight - 2;
      // Three vertical lines with gaps equal to their width, then a row of dots.
      const lineLength = usableHeight * 0.6;
      for (let k = 0; k < 3; k++) {
        c.fillRect(Math.round(px(x0 + k * 2 * width)), Math.round(px(y0)), Math.max(1, Math.round(px(width))), Math.round(px(lineLength)));
      }
      const dotsY = y0 + lineLength + (usableHeight - lineLength) / 2;
      for (let k = 0; k < 4; k++) {
        c.beginPath();
        c.arc(px(x0 + width / 2 + k * 2 * width), px(dotsY), px(width / 2), 0, Math.PI * 2);
        c.fill();
      }
    });
  });

  const rgba = c.getImageData(0, 0, nx, ny).data;
  const heights = new Float32Array(nx * ny);
  for (let i = 0; i < heights.length; i++) {
    // Grey level is height; antialiased edges become short slopes.
    heights[i] = (rgba[i * 4] / 255) * MAX_HEIGHT;
  }
  return { heights, nx, ny };
}
