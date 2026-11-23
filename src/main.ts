import { DepthClient, type DepthMap } from './depth/depthClient';
import { ImageLoadError, decodeBlob, decodeLink } from './image/decode';
import { encodeGreyAlphaPng, heightsToGrey } from './image/png';
import { renderRegion, type Region } from './image/resample';
import { downloadBlob, exportStl } from './mesh/exportClient';
import { countPlateTriangles } from './mesh/plateMesher';
import { stlByteLength } from './mesh/stlWriter';
import type { DepthSource } from './relief/bands';
import { DEFAULT_PARAMS, rasterFor, type ReliefParams } from './relief/compose';
import { ReliefClient, type ComposedRelief } from './relief/reliefClient';
import {
  DEFAULT_SIZE_MM,
  MAX_SIZE_MM,
  MIN_SIZE_MM,
  OUTLINES,
  describeShape,
  ellipseValue,
  outlineSpec,
  plateShape,
  type OutlineKind,
  type PlateShape,
} from './shapes/outline';
import { COUPON_BASE, COUPON_SHAPE, buildCoupon } from './ui/coupon';
import { CropWidget } from './ui/crop';
import { PlatePreview } from './ui/preview3d';

type Step = 'image' | 'frame' | 'plate';

interface Plate {
  kind: OutlineKind;
  shape: PlateShape;
  nx: number;
  ny: number;
  pitch: number;
  region: Region;
  /** Depth estimated on just this crop, when the crop is a small part of the picture. */
  cropDepth: DepthMap | null;
  hasDepth: boolean;
  histogram: Float32Array | null;
  /** Once the user moves the split handle, new depth data no longer resets it. */
  splitChosen: boolean;
}

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

const state = {
  step: 'image' as Step,
  source: null as HTMLCanvasElement | null,
  imageVersion: 0,
  depth: null as DepthMap | null,
  depthText: '',
  depthBusy: false,
  kind: 'none' as OutlineKind,
  size: DEFAULT_SIZE_MM,
  landscape: false,
  params: { ...DEFAULT_PARAMS } as ReliefParams,
  base: 2,
  view: 'plate' as 'plate' | 'rubbing',
  tint: false,
  plate: null as Plate | null,
  /** The frame changed since the plate was last made. */
  frameDirty: true,
  heights: null as Float32Array | null,
};

const depthClient = new DepthClient();
const relief = new ReliefClient();
const crop = new CropWidget($<HTMLCanvasElement>('crop'));
let preview: PlatePreview | null = null;
let previewFailed = false;

// ---------------------------------------------------------------- Steps

const stepButtons = [...document.querySelectorAll<HTMLButtonElement>('.step')];

function showStep(step: Step): void {
  state.step = step;
  for (const name of ['image', 'frame', 'plate'] as Step[]) $(`step-${name}`).hidden = name !== step;
  for (const button of stepButtons) {
    const name = button.dataset.step as Step;
    if (name === step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    button.disabled = name === 'image' ? false : name === 'frame' ? !state.source : !state.plate;
  }
}

for (const button of stepButtons) {
  button.addEventListener('click', () => {
    const step = button.dataset.step as Step;
    if (step === 'plate' && state.frameDirty) void makePlate();
    else showStep(step);
  });
}

// ---------------------------------------------------------------- Step 1: image

const loadMessage = $('load-message');

function setMessage(element: HTMLElement, text: string, kind: 'info' | 'busy' | 'error' = 'info'): void {
  element.textContent = text;
  element.classList.toggle('busy', kind === 'busy');
  element.classList.toggle('error', kind === 'error');
}

async function loadFrom(task: () => Promise<HTMLCanvasElement>): Promise<void> {
  setMessage(loadMessage, 'Reading picture', 'busy');
  try {
    const canvas = await task();
    setMessage(loadMessage, '');
    onImage(canvas);
  } catch (error) {
    const blocked = error instanceof ImageLoadError && error.kind === 'blocked';
    setMessage(
      loadMessage,
      blocked
        ? 'That site does not let other pages read its pictures (or the link is not a direct picture link). Open the picture, copy it, then paste it here.'
        : error instanceof Error
          ? error.message
          : 'That picture could not be read.',
      'error',
    );
  }
}

function onImage(canvas: HTMLCanvasElement): void {
  state.source = canvas;
  state.imageVersion++;
  state.depth = null;
  state.plate = null;
  state.heights = null;
  state.frameDirty = true;
  crop.setImage(canvas);
  // The "None" outline follows the picture's proportions, so the frame depends on the picture.
  updateFrame();
  showStep('frame');
  void startDepth();
}

const fileInput = $<HTMLInputElement>('file');
$('choose').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void loadFrom(() => decodeBlob(file));
  fileInput.value = '';
});

const drop = $('drop');
for (const type of ['dragenter', 'dragover'] as const) {
  document.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
}
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) drop.classList.remove('over');
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('over');
  const transfer = event.dataTransfer;
  if (!transfer) return;
  const file = [...transfer.files].find((f) => f.type.startsWith('image/'));
  if (file) {
    showStep('image');
    void loadFrom(() => decodeBlob(file));
    return;
  }
  // Dragging a picture from another tab usually gives only its address.
  const link = transfer.getData('text/uri-list') || transfer.getData('text/plain');
  if (link && /^https?:\/\//i.test(link.trim())) {
    showStep('image');
    void loadFrom(() => decodeLink(link.split('\n')[0]));
  }
});

document.addEventListener('paste', (event) => {
  const target = event.target as HTMLElement | null;
  const data = event.clipboardData;
  if (!data) return;
  const file = [...data.files].find((f) => f.type.startsWith('image/'));
  if (file) {
    event.preventDefault();
    showStep('image');
    void loadFrom(() => decodeBlob(file));
    return;
  }
  // A pasted address loads as a link, unless the user is typing in a field.
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
  const text = data.getData('text/plain').trim();
  if (/^https?:\/\/\S+$/i.test(text)) {
    event.preventDefault();
    showStep('image');
    void loadFrom(() => decodeLink(text));
  }
});

$<HTMLFormElement>('link-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const link = $<HTMLInputElement>('link').value.trim();
  if (link) void loadFrom(() => decodeLink(link));
});

// ---------------------------------------------------------------- Depth

const depthStatus = $('depth-status');

function showDepthStatus(): void {
  setMessage(depthStatus, state.depthText, state.depthBusy ? 'busy' : 'info');
}

depthClient.onStatus = (status) => {
  state.depthBusy = true;
  state.depthText = status.progress === null ? status.text : `${status.text} ${Math.round(status.progress * 100)}%`;
  showDepthStatus();
};

async function startDepth(): Promise<void> {
  const version = state.imageVersion;
  const source = state.source!;
  state.depthBusy = true;
  state.depthText = 'Preparing depth';
  showDepthStatus();
  try {
    const map = await depthClient.estimate(source);
    if (version !== state.imageVersion) return;
    state.depth = map;
    state.depthBusy = false;
    state.depthText = `Depth ready (${map.backend === 'webgpu' ? 'GPU' : 'CPU'}, ${(map.ms / 1000).toFixed(1)} s)`;
    showDepthStatus();
    // A plate made before depth arrived gets its foreground/background split now.
    if (state.plate && !state.plate.hasDepth) void prepare(state.plate);
  } catch (error) {
    if (version !== state.imageVersion) return;
    console.warn('Depth estimation failed', error);
    state.depthBusy = false;
    state.depthText = 'Depth is not available in this browser, so the whole picture is treated as foreground.';
    showDepthStatus();
  }
}

// ---------------------------------------------------------------- Step 2: frame

const OUTLINE_ICONS: Record<OutlineKind, string> = {
  none: '<rect x="4.5" y="7.5" width="23" height="17" stroke-dasharray="3 2.4"/><path d="M8 21l5.5-6 4 4 2.5-2.5 4 4.5"/>',
  circle: '<circle cx="16" cy="16" r="11"/>',
  oval: '<ellipse cx="16" cy="16" rx="8.5" ry="12"/>',
  square: '<rect x="5.5" y="5.5" width="21" height="21"/>',
  a5: '<rect x="8.5" y="6" width="15" height="20"/>',
  a4: '<rect x="7" y="4" width="18" height="24"/>',
  letter: '<rect x="6.5" y="5" width="19" height="22"/>',
};

const outlinesBox = $('outlines');
outlinesBox.innerHTML = OUTLINES.map(
  (outline) => `
    <label>
      <input type="radio" name="outline" value="${outline.kind}" ${outline.kind === state.kind ? 'checked' : ''} />
      <svg viewBox="0 0 32 32" aria-hidden="true">${OUTLINE_ICONS[outline.kind]}</svg>
      ${outline.label}
    </label>`,
).join('');

const sizeInput = $<HTMLInputElement>('size');
const zoomInput = $<HTMLInputElement>('zoom');

function currentShape(): PlateShape {
  const pictureAspect = state.source ? state.source.width / state.source.height : 1;
  return plateShape(state.kind, state.size, state.landscape, pictureAspect);
}

function updateFrame(): void {
  const spec = outlineSpec(state.kind);
  const shape = currentShape();
  crop.setShape(shape);
  $('size-field').hidden = spec.paper !== null;
  $('orientation-field').hidden = spec.aspect === 1;
  $('outline-note').textContent = spec.followsPicture
    ? 'The plate takes the shape of your picture. Zoom in to trim it.'
    : '';
  const longest = Math.max(shape.width, shape.height);
  $('dimensions').textContent =
    `Plate: ${describeShape(shape)}` + (longest > 220 ? ' · check that it fits your printer' : '');
  state.frameDirty = true;
  syncZoom();
}

function syncZoom(): void {
  zoomInput.value = String(Math.log(crop.zoom) / Math.log(CropWidget.maxZoom));
}

outlinesBox.addEventListener('change', (event) => {
  state.kind = (event.target as HTMLInputElement).value as OutlineKind;
  updateFrame();
});
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="orientation"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    state.landscape = radio.value === 'landscape';
    updateFrame();
  });
}
sizeInput.addEventListener('change', () => {
  const value = Number(sizeInput.value);
  state.size = Math.min(MAX_SIZE_MM, Math.max(MIN_SIZE_MM, Number.isFinite(value) ? value : DEFAULT_SIZE_MM));
  sizeInput.value = String(state.size);
  updateFrame();
});
zoomInput.addEventListener('input', () => {
  crop.zoom = CropWidget.maxZoom ** Number(zoomInput.value);
  state.frameDirty = true;
});
crop.onChange = () => {
  state.frameDirty = true;
  syncZoom();
};
$('to-plate').addEventListener('click', () => void makePlate());

// ---------------------------------------------------------------- Step 3: plate

function ensurePreview(): PlatePreview | null {
  if (preview || previewFailed) return preview;
  try {
    preview = new PlatePreview($('preview'));
  } catch (error) {
    console.warn('3D preview unavailable', error);
    previewFailed = true;
    $('preview').textContent = 'The 3D preview needs WebGL, which this browser has switched off. You can still download the plate.';
  }
  return preview;
}

async function makePlate(): Promise<void> {
  if (!state.source) return;
  const shape = currentShape();
  const raster = rasterFor(shape);
  const plate: Plate = {
    kind: state.kind,
    shape,
    ...raster,
    region: crop.getRegion(),
    cropDepth: null,
    hasDepth: false,
    histogram: null,
    splitChosen: false,
  };
  state.plate = plate;
  state.heights = null;
  state.frameDirty = false;
  setExportEnabled(false);
  $('export-info').textContent = '';
  showEstimate(plate);
  showStep('plate');
  ensurePreview()?.setPlate(shape, plate.nx, plate.ny);
  await prepare(plate);

  // When the crop is a small part of the picture, a depth pass on just the crop is sharper.
  const source = state.source;
  const share = (plate.region.width * plate.region.height) / (source.width * source.height);
  if (state.depth && share < 0.35) {
    const version = state.imageVersion;
    try {
      const map = await depthClient.estimate(source, plate.region);
      if (state.plate !== plate || version !== state.imageVersion) return;
      plate.cropDepth = map;
      state.depthBusy = false;
      state.depthText = `Depth ready (${map.backend === 'webgpu' ? 'GPU' : 'CPU'}, ${(map.ms / 1000).toFixed(1)} s)`;
      showDepthStatus();
      await prepare(plate);
    } catch (error) {
      console.warn('Depth for the crop failed; keeping the full-picture depth.', error);
      state.depthBusy = false;
      showDepthStatus();
    }
  }
}

function depthSourceFor(plate: Plate): DepthSource | null {
  if (plate.cropDepth) {
    const map = plate.cropDepth;
    return { data: map.data, width: map.width, height: map.height, crop: { x: 0, y: 0, width: map.width, height: map.height } };
  }
  const map = state.depth;
  const source = state.source;
  if (!map || !source) return null;
  const sx = map.width / source.width;
  const sy = map.height / source.height;
  return {
    data: map.data,
    width: map.width,
    height: map.height,
    crop: { x: plate.region.x * sx, y: plate.region.y * sy, width: plate.region.width * sx, height: plate.region.height * sy },
  };
}

async function prepare(plate: Plate): Promise<void> {
  if (!state.source) return;
  const image = renderRegion(state.source, plate.region, plate.nx, plate.ny);
  const depth = depthSourceFor(plate);
  try {
    const info = await relief.prepare(image.data, plate.nx, plate.ny, plate.pitch, plate.shape, depth);
    if (state.plate !== plate) return;
    plate.hasDepth = info.hasDepth;
    plate.histogram = info.histogram;
    if (info.hasDepth && !plate.splitChosen) state.params.split = info.split;
    syncControls();
    requestCompose();
  } catch (error) {
    setMessage(depthStatus, error instanceof Error ? error.message : 'The plate could not be prepared.', 'error');
  }
}

function requestCompose(): void {
  const plate = state.plate;
  if (!plate) return;
  relief.compose(state.params, { rubbing: state.view === 'rubbing', tint: state.tint && plate.hasDepth });
}

const rubbingCanvas = $<HTMLCanvasElement>('rubbing');

relief.onComposed = (result: ComposedRelief) => {
  const plate = state.plate;
  if (!plate || result.heights.length !== plate.nx * plate.ny) return;
  state.heights = result.heights;
  preview?.update(result.heights, state.params.reliefHeight, state.base, result.tint);
  if (result.rubbing) {
    rubbingCanvas.width = plate.nx;
    rubbingCanvas.height = plate.ny;
    rubbingCanvas
      .getContext('2d')!
      .putImageData(new ImageData(result.rubbing as Uint8ClampedArray<ArrayBuffer>, plate.nx, plate.ny), 0, 0);
  }
  setExportEnabled(true);
  $('export-info').textContent =
    `${describeShape(plate.shape)} · ${plate.pitch.toFixed(2)} mm detail · ${Math.round(result.raisedShare * 100)}% raised`;
};
relief.onError = (error) => setMessage(depthStatus, error.message, 'error');

// --- Controls

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
function millimetres(value: number): string {
  return `${value.toFixed(1)} mm`;
}

interface RangeBinding {
  id: string;
  get: () => number;
  set: (value: number) => void;
  format: (value: number) => string;
}

const ranges: RangeBinding[] = [
  { id: 'foreground', get: () => state.params.foreground, set: (v) => (state.params.foreground = v), format: percent },
  { id: 'background', get: () => state.params.background, set: (v) => (state.params.background = v), format: percent },
  { id: 'outline', get: () => state.params.outline, set: (v) => (state.params.outline = v), format: percent },
  { id: 'relief', get: () => state.params.reliefHeight, set: (v) => (state.params.reliefHeight = v), format: millimetres },
  { id: 'base', get: () => state.base, set: (v) => (state.base = v), format: millimetres },
];

for (const binding of ranges) {
  const input = $<HTMLInputElement>(binding.id);
  input.addEventListener('input', () => {
    binding.set(Number(input.value));
    $(`${binding.id}-out`).textContent = binding.format(binding.get());
    // Recomposing is cheap, and its result redraws the preview with every current setting.
    requestCompose();
  });
}

const splitInput = $<HTMLInputElement>('split');
splitInput.addEventListener('input', () => {
  state.params.split = Number(splitInput.value);
  if (state.plate) state.plate.splitChosen = true;
  drawHistogram();
  requestCompose();
});

$<HTMLSelectElement>('layer').addEventListener('change', (event) => {
  state.params.layerHeight = Number((event.target as HTMLSelectElement).value);
  requestCompose();
});
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="raise"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    state.params.raiseDark = radio.value === 'dark';
    requestCompose();
  });
}
$<HTMLInputElement>('border').addEventListener('change', (event) => {
  state.params.border = (event.target as HTMLInputElement).checked;
  requestCompose();
});
$<HTMLInputElement>('tint').addEventListener('change', (event) => {
  state.tint = (event.target as HTMLInputElement).checked;
  requestCompose();
});
for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="view"]')) {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    state.view = radio.value as 'plate' | 'rubbing';
    $('preview').hidden = state.view !== 'plate';
    $('rubbing-wrap').hidden = state.view !== 'rubbing';
    $('reset-view').hidden = state.view !== 'plate';
    requestCompose();
  });
}
$('reset-view').addEventListener('click', () => preview?.resetView());

function syncControls(): void {
  for (const binding of ranges) {
    $<HTMLInputElement>(binding.id).value = String(binding.get());
    $(`${binding.id}-out`).textContent = binding.format(binding.get());
  }
  splitInput.value = String(state.params.split);
  $<HTMLSelectElement>('layer').value = String(state.params.layerHeight);
  $<HTMLInputElement>('border').checked = state.params.border;
  $<HTMLInputElement>('tint').checked = state.tint;
  const hasDepth = state.plate?.hasDepth ?? false;
  $<HTMLFieldSetElement>('depth-field').disabled = !hasDepth;
  $<HTMLInputElement>('background').disabled = !hasDepth;
  drawHistogram();
}

function drawHistogram(): void {
  const canvas = $<HTMLCanvasElement>('histogram');
  const c = canvas.getContext('2d')!;
  const { width, height } = canvas;
  c.clearRect(0, 0, width, height);
  const histogram = state.plate?.histogram;
  if (!histogram || !state.plate?.hasDepth) return;
  let peak = 0;
  for (const value of histogram) peak = Math.max(peak, value);
  if (!peak) return;
  const style = getComputedStyle(document.documentElement);
  const far = style.getPropertyValue('--far').trim();
  const near = style.getPropertyValue('--near').trim();
  const barWidth = width / histogram.length;
  for (let b = 0; b < histogram.length; b++) {
    const centre = (b + 0.5) / histogram.length;
    // Square-root scale keeps small groups visible next to a dominant background.
    const barHeight = Math.sqrt(histogram[b] / peak) * (height - 4);
    c.fillStyle = centre < state.params.split ? far : near;
    c.fillRect(b * barWidth + 0.5, height - barHeight, barWidth - 1, barHeight);
  }
  c.fillStyle = style.getPropertyValue('--text').trim();
  c.fillRect(Math.round(state.params.split * width) - 1, 0, 2, height);
}

// --- Export

function setExportEnabled(enabled: boolean): void {
  $<HTMLButtonElement>('export').disabled = !enabled;
  $<HTMLButtonElement>('export-png').disabled = !enabled;
}

function megabytes(bytes: number): string {
  const mb = bytes / 1e6;
  return `${mb < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB`;
}

/**
 * Triangle count and STL size for the current plate. Both follow from the outline and the
 * sample grid alone, so they are known before anything is built.
 */
function showEstimate(plate: Plate): void {
  const triangles = countPlateTriangles(plate.shape, plate.nx, plate.ny);
  $('export-estimate').textContent =
    `STL estimate: ${triangles.toLocaleString()} triangles · ${megabytes(stlByteLength(triangles))}`;
}

function plateFilename(plate: Plate): string {
  const size = `${Math.round(plate.shape.width)}x${Math.round(plate.shape.height)}mm`;
  return `rubbing-plate-${plate.kind === 'none' ? '' : `${plate.kind}-`}${size}`;
}

$('export').addEventListener('click', async () => {
  const plate = state.plate;
  const heights = state.heights;
  if (!plate || !heights) return;
  const button = $<HTMLButtonElement>('export');
  const info = $('export-info');
  button.disabled = true;
  setMessage(info, 'Building the STL', 'busy');
  try {
    const filename = `${plateFilename(plate)}.stl`;
    const result = await exportStl(heights, plate.nx, plate.ny, plate.shape, state.base, `Rubbing plate ${Math.round(plate.shape.width)} x ${Math.round(plate.shape.height)} mm`);
    downloadBlob(result.blob, filename);
    setMessage(info, `Saved ${filename} · ${result.triangles.toLocaleString()} triangles · ${megabytes(result.bytes)}`);
  } catch (error) {
    setMessage(info, error instanceof Error ? error.message : 'The STL could not be built.', 'error');
  } finally {
    button.disabled = false;
  }
});

// Lightmap: the plate's heights as a greyscale picture (white = raised, black = flat), for use
// as a height or displacement map in other tools. Outside the outline it is transparent.
$('export-png').addEventListener('click', async () => {
  const plate = state.plate;
  const heights = state.heights;
  if (!plate || !heights) return;
  const button = $<HTMLButtonElement>('export-png');
  const info = $('export-info');
  button.disabled = true;
  try {
    const { nx, ny, shape } = plate;
    let alpha: Uint8Array | null = null;
    if (shape.ellipse) {
      alpha = new Uint8Array(nx * ny);
      const dx = shape.width / (nx - 1);
      const dy = shape.height / (ny - 1);
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          alpha[j * nx + i] = ellipseValue(shape, -shape.width / 2 + i * dx, shape.height / 2 - j * dy) <= 1 ? 255 : 0;
        }
      }
    }
    const png = await encodeGreyAlphaPng(heightsToGrey(heights, state.params.reliefHeight), alpha, nx, ny);
    const filename = `${plateFilename(plate)}-lightmap.png`;
    downloadBlob(new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }), filename);
    setMessage(info, `Saved ${filename} · ${nx} × ${ny} px · white = raised (${state.params.reliefHeight.toFixed(1)} mm)`);
  } catch (error) {
    setMessage(info, error instanceof Error ? error.message : 'The PNG could not be made.', 'error');
  } finally {
    button.disabled = false;
  }
});

$('coupon').addEventListener('click', async () => {
  const coupon = buildCoupon();
  const result = await exportStl(coupon.heights, coupon.nx, coupon.ny, COUPON_SHAPE, COUPON_BASE, 'Rubbing calibration coupon');
  downloadBlob(result.blob, 'rubbing-calibration-coupon.stl');
});

// ---------------------------------------------------------------- Start

sizeInput.value = String(state.size);
updateFrame();
syncControls();
showStep('image');

// Development-only handle for inspecting the app from the console.
if (import.meta.env.DEV) {
  (window as unknown as { __rubbings: unknown }).__rubbings = {
    state,
    get preview() {
      return preview;
    },
  };
}
