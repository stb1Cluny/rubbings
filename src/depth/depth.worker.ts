/// <reference lib="webworker" />
// Depth estimation worker: Depth Anything V2 Small through Transformers.js, with every file
// (model weights and ONNX Runtime) loaded from this site's own origin.
import { AutoModelForDepthEstimation, Tensor, env } from '@huggingface/transformers';
import { MODEL_DTYPE, MODEL_ID, SHORT_SIDE, modelInputSize, runtimeFiles, type Backend } from './ortConfig';

export type DepthRequest =
  | { type: 'init'; baseUrl: string; forceWasm: boolean; dtype?: string }
  | { type: 'run'; id: number; image: ImageData };

export type DepthResponse =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'status'; text: string }
  | { type: 'result'; id: number; data: Float32Array; width: number; height: number; backend: Backend; ms: number }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (message: DepthResponse, transfer: Transferable[] = []) => ctx.postMessage(message, transfer);

// --- Privacy guard: this worker may only talk to its own origin. ---------------------------
function assertSameOrigin(input: RequestInfo | URL): void {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw, ctx.location.href);
  if (url.origin !== ctx.location.origin && url.protocol !== 'blob:' && url.protocol !== 'data:') {
    throw new Error(`Blocked request to another origin: ${url.origin}`);
  }
}
const nativeFetch = ctx.fetch.bind(ctx);
const guardedFetch: typeof fetch = (input, init) => {
  assertSameOrigin(input);
  return nativeFetch(input, init);
};
ctx.fetch = guardedFetch;
env.fetch = guardedFetch;

let baseUrl = '';
let forceWasm = false;
/** Optional override of the model variant, for comparing variants during development. */
let dtypeOverride: string | undefined;
let backend: Backend | null = null;
let model: any = null;
let configuredRuntime = false;

async function pickBackend(): Promise<Backend> {
  if (forceWasm) return 'wasm';
  try {
    const gpu = (navigator as any).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    // The GPU model uses half-float activations; without shader support for them we use WASM.
    if (adapter && adapter.features.has('shader-f16')) return 'webgpu';
  } catch {
    // fall through
  }
  return 'wasm';
}

function configure(target: Backend): void {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = new URL('models/', baseUrl).href;
  // Loading the runtime through the library's cache would import it from a blob: URL,
  // which the page's Content-Security-Policy forbids.
  env.useWasmCache = false;
  const wasm = env.backends.onnx.wasm!;
  if (!configuredRuntime) {
    // The runtime can only be chosen once per worker.
    wasm.wasmPaths = runtimeFiles(target, baseUrl);
    wasm.numThreads = 1;
    configuredRuntime = true;
  }
}

const fileProgress = new Map<string, { loaded: number; total: number }>();
function onProgress(info: any): void {
  if (info?.status !== 'progress' || !info.file) return;
  fileProgress.set(info.file, { loaded: info.loaded ?? 0, total: info.total ?? 0 });
  let loaded = 0;
  let total = 0;
  for (const entry of fileProgress.values()) {
    loaded += entry.loaded;
    total += entry.total;
  }
  post({ type: 'progress', loaded, total });
}

async function loadModel(target: Backend): Promise<void> {
  configure(target);
  post({ type: 'status', text: target === 'webgpu' ? 'Loading depth model (GPU)' : 'Loading depth model' });
  model = await AutoModelForDepthEstimation.from_pretrained(MODEL_ID, {
    device: target,
    dtype: (dtypeOverride ?? MODEL_DTYPE[target]) as 'q8',
    local_files_only: true,
    progress_callback: onProgress,
  });
  backend = target;
}

async function ensureModel(): Promise<void> {
  if (model) return;
  const target = await pickBackend();
  try {
    await loadModel(target);
  } catch (error) {
    if (target === 'wasm') throw error;
    console.warn('WebGPU model failed to load; falling back to WASM.', error);
    model = null;
    await loadModel('wasm');
  }
}

/** Resize to the model's input size and convert RGBA to a normalised CHW float tensor. */
async function toTensor(image: ImageData, shortSide: number): Promise<Tensor> {
  const size = modelInputSize(image.width, image.height, shortSide);
  const bitmap = await createImageBitmap(image);
  const canvas = new OffscreenCanvas(size.width, size.height);
  const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
  c2d.imageSmoothingEnabled = true;
  c2d.imageSmoothingQuality = 'high';
  c2d.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();
  const rgba = c2d.getImageData(0, 0, size.width, size.height).data;
  const n = size.width * size.height;
  const chw = new Float32Array(3 * n);
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  for (let i = 0; i < n; i++) {
    chw[i] = (rgba[i * 4] / 255 - mean[0]) / std[0];
    chw[n + i] = (rgba[i * 4 + 1] / 255 - mean[1]) / std[1];
    chw[2 * n + i] = (rgba[i * 4 + 2] / 255 - mean[2]) / std[2];
  }
  return new Tensor('float32', chw, [1, 3, size.height, size.width]);
}

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function toFloat32(data: ArrayLike<number>, type: string): Float32Array {
  if (data instanceof Float32Array) return new Float32Array(data);
  const out = new Float32Array(data.length);
  const packedHalf = type === 'float16' && data instanceof Uint16Array;
  for (let i = 0; i < out.length; i++) out[i] = packedHalf ? halfToFloat(data[i]) : Number(data[i]);
  return out;
}

async function infer(image: ImageData): Promise<{ data: Float32Array; width: number; height: number }> {
  const input = await toTensor(image, SHORT_SIDE[backend!]);
  const output = await model({ pixel_values: input });
  const depth = output.predicted_depth as Tensor;
  const dims = depth.dims;
  const height = dims[dims.length - 2];
  const width = dims[dims.length - 1];
  const data = toFloat32(depth.data as ArrayLike<number>, depth.type);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) throw new Error('Depth model produced non-finite values');
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(max > min)) throw new Error('Depth model produced a constant map');
  return { data, width, height };
}

async function run(id: number, image: ImageData): Promise<void> {
  await ensureModel();
  post({ type: 'status', text: 'Estimating depth' });
  const start = performance.now();
  let result;
  try {
    result = await infer(image);
  } catch (error) {
    if (backend !== 'webgpu') throw error;
    console.warn('WebGPU inference failed; retrying on WASM.', error);
    model = null;
    await loadModel('wasm');
    result = await infer(image);
  }
  post({ type: 'result', id, ...result, backend: backend!, ms: performance.now() - start }, [result.data.buffer]);
}

let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (event: MessageEvent<DepthRequest>) => {
  const message = event.data;
  if (message.type === 'init') {
    baseUrl = message.baseUrl;
    forceWasm = message.forceWasm;
    dtypeOverride = message.dtype;
    return;
  }
  queue = queue.then(() =>
    run(message.id, message.image).catch((error: unknown) => {
      post({ type: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) });
    }),
  );
};
