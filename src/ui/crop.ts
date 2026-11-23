// Crop widget: the outline stays fixed in the middle; the picture pans and zooms underneath.
import type { Region } from '../image/resample';
import type { PlateShape } from '../shapes/outline';

const MAX_ZOOM = 8;
/** Share of the canvas the outline's bounding box may occupy. */
const FILL = 0.86;
/** Longest side of the copy used for on-screen drawing. */
const DISPLAY_SIDE = 1600;

export class CropWidget {
  private c2d: CanvasRenderingContext2D;
  private image: HTMLCanvasElement | null = null;
  private display: HTMLCanvasElement | null = null;
  private shape: PlateShape = { ellipse: false, width: 1, height: 1 };
  /** Centre of the view in image pixels. */
  private cx = 0;
  private cy = 0;
  /** 1 = the picture just covers the outline; larger = zoomed in. */
  private zoomLevel = 1;
  private pointers = new Map<number, { x: number; y: number }>();
  private frame = 0;
  onChange: () => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    this.c2d = canvas.getContext('2d')!;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (e) => this.pointerDown(e));
    canvas.addEventListener('pointermove', (e) => this.pointerMove(e));
    canvas.addEventListener('pointerup', (e) => this.pointerEnd(e));
    canvas.addEventListener('pointercancel', (e) => this.pointerEnd(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('keydown', (e) => this.key(e));
    new ResizeObserver(() => this.requestDraw()).observe(canvas);
  }

  setImage(image: HTMLCanvasElement): void {
    this.image = image;
    const scale = Math.min(1, DISPLAY_SIDE / Math.max(image.width, image.height));
    if (scale < 1) {
      const copy = document.createElement('canvas');
      copy.width = Math.round(image.width * scale);
      copy.height = Math.round(image.height * scale);
      const c2d = copy.getContext('2d')!;
      c2d.imageSmoothingQuality = 'high';
      c2d.drawImage(image, 0, 0, copy.width, copy.height);
      this.display = copy;
    } else {
      this.display = image;
    }
    this.cx = image.width / 2;
    this.cy = image.height / 2;
    this.zoomLevel = 1;
    this.clamp();
    this.requestDraw();
  }

  setShape(shape: PlateShape): void {
    this.shape = shape;
    this.clamp();
    this.requestDraw();
  }

  get zoom(): number {
    return this.zoomLevel;
  }

  set zoom(value: number) {
    this.zoomLevel = Math.min(MAX_ZOOM, Math.max(1, value));
    this.clamp();
    this.requestDraw();
  }

  static readonly maxZoom = MAX_ZOOM;

  /** Width of the outline's bounding box in image pixels at zoom 1 (picture covers outline). */
  private coverWidth(): number {
    if (!this.image) return 1;
    return Math.min(this.image.width, (this.image.height * this.shape.width) / this.shape.height);
  }

  private viewSize(): { width: number; height: number } {
    const width = this.coverWidth() / this.zoomLevel;
    return { width, height: (width * this.shape.height) / this.shape.width };
  }

  private clamp(): void {
    if (!this.image) return;
    const view = this.viewSize();
    this.cx = Math.min(this.image.width - view.width / 2, Math.max(view.width / 2, this.cx));
    this.cy = Math.min(this.image.height - view.height / 2, Math.max(view.height / 2, this.cy));
  }

  /** The part of the image under the outline's bounding box, in image pixels. */
  getRegion(): Region {
    const view = this.viewSize();
    return { x: this.cx - view.width / 2, y: this.cy - view.height / 2, width: view.width, height: view.height };
  }

  /** Outline bounding box on the canvas, in CSS pixels. */
  private outlineBox(): { x: number; y: number; width: number; height: number; scale: number } {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const fit = Math.min((cw * FILL) / this.shape.width, (ch * FILL) / this.shape.height);
    const width = this.shape.width * fit;
    const height = this.shape.height * fit;
    return { x: (cw - width) / 2, y: (ch - height) / 2, width, height, scale: width / this.viewSize().width };
  }

  private requestDraw(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const canvas = this.canvas;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    const c = this.c2d;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cw, ch);
    if (!this.image || !this.display) return;

    const box = this.outlineBox();
    const s = box.scale; // CSS pixels per image pixel
    const left = cw / 2 - this.cx * s;
    const top = ch / 2 - this.cy * s;
    c.imageSmoothingQuality = 'high';
    c.drawImage(this.display, left, top, this.image.width * s, this.image.height * s);

    // Dim everything outside the outline.
    c.beginPath();
    c.rect(0, 0, cw, ch);
    this.tracePath(c, box);
    c.fillStyle = 'rgba(12, 14, 20, 0.62)';
    c.fill('evenodd');

    c.beginPath();
    this.tracePath(c, box);
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    c.stroke();
    c.lineWidth = 1.5;
    c.strokeStyle = '#ffffff';
    c.stroke();
  }

  private tracePath(c: CanvasRenderingContext2D, box: { x: number; y: number; width: number; height: number }): void {
    if (this.shape.ellipse) {
      c.moveTo(box.x + box.width, box.y + box.height / 2);
      c.ellipse(box.x + box.width / 2, box.y + box.height / 2, box.width / 2, box.height / 2, 0, 0, Math.PI * 2);
    } else {
      c.rect(box.x, box.y, box.width, box.height);
    }
  }

  private changed(): void {
    this.clamp();
    this.requestDraw();
    this.onChange();
  }

  /** Zoom by a factor while keeping the image point under (px, py) (CSS pixels) fixed. */
  private zoomAbout(factor: number, px: number, py: number): void {
    const before = this.outlineBox().scale;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const imageX = this.cx + (px - cw / 2) / before;
    const imageY = this.cy + (py - ch / 2) / before;
    this.zoomLevel = Math.min(MAX_ZOOM, Math.max(1, this.zoomLevel * factor));
    const after = this.outlineBox().scale;
    this.cx = imageX - (px - cw / 2) / after;
    this.cy = imageY - (py - ch / 2) / after;
    this.changed();
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private pointerDown(e: PointerEvent): void {
    if (!this.image) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    this.canvas.classList.add('dragging');
  }

  private pointerMove(e: PointerEvent): void {
    const previous = this.pointers.get(e.pointerId);
    if (!previous) return;
    const current = this.local(e);
    const scale = this.outlineBox().scale;
    if (this.pointers.size === 1) {
      this.cx -= (current.x - previous.x) / scale;
      this.cy -= (current.y - previous.y) / scale;
      this.pointers.set(e.pointerId, current);
      this.changed();
      return;
    }
    // Two fingers: zoom by the change in their distance, about their midpoint.
    const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
    const distanceBefore = Math.hypot(previous.x - other.x, previous.y - other.y);
    const distanceAfter = Math.hypot(current.x - other.x, current.y - other.y);
    const midBefore = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
    const midAfter = { x: (current.x + other.x) / 2, y: (current.y + other.y) / 2 };
    this.pointers.set(e.pointerId, current);
    this.cx -= (midAfter.x - midBefore.x) / scale;
    this.cy -= (midAfter.y - midBefore.y) / scale;
    if (distanceBefore > 4) this.zoomAbout(distanceAfter / distanceBefore, midAfter.x, midAfter.y);
    else this.changed();
  }

  private pointerEnd(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.canvas.classList.remove('dragging');
  }

  private wheel(e: WheelEvent): void {
    if (!this.image) return;
    e.preventDefault();
    const point = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomAbout(Math.exp(-delta * 0.0018), point.x, point.y);
  }

  private key(e: KeyboardEvent): void {
    if (!this.image) return;
    const step = this.viewSize().width * 0.04;
    const cw = this.canvas.clientWidth / 2;
    const ch = this.canvas.clientHeight / 2;
    switch (e.key) {
      case 'ArrowLeft':
        this.cx -= step;
        break;
      case 'ArrowRight':
        this.cx += step;
        break;
      case 'ArrowUp':
        this.cy -= step;
        break;
      case 'ArrowDown':
        this.cy += step;
        break;
      case '+':
      case '=':
        e.preventDefault();
        this.zoomAbout(1.15, cw, ch);
        return;
      case '-':
      case '_':
        e.preventDefault();
        this.zoomAbout(1 / 1.15, cw, ch);
        return;
      default:
        return;
    }
    e.preventDefault();
    this.changed();
  }
}
