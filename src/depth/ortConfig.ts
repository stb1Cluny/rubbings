// ONNX Runtime files, served from this site. Importing them with `?url` makes Vite emit each
// file once and gives us its final address, so nothing is ever requested from a CDN.
import asyncifyMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import asyncifyWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import plainMjs from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import plainWasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

export type Backend = 'webgpu' | 'wasm';

export const MODEL_ID = 'onnx-community/depth-anything-v2-small';

/** Model variant per backend. Keep in step with the file list in scripts/fetch-model.mjs. */
export const MODEL_DTYPE: Record<Backend, 'q4f16' | 'q8'> = { webgpu: 'q4f16', wasm: 'q8' };

/** The WebGPU path needs the larger "asyncify" runtime; plain WASM uses the small one. */
export function runtimeFiles(backend: Backend, base: string): { mjs: string; wasm: string } {
  const pair = backend === 'webgpu' ? { mjs: asyncifyMjs, wasm: asyncifyWasm } : { mjs: plainMjs, wasm: plainWasm };
  return { mjs: new URL(pair.mjs, base).href, wasm: new URL(pair.wasm, base).href };
}

/** Model input is a multiple of 14 px per side; the short side is the quality/speed knob. */
export const SHORT_SIDE: Record<Backend, number> = { webgpu: 518, wasm: 392 };
export const PATCH = 14;

/** Size the model input: short side at the target, long side capped at 2x, both multiples of 14. */
export function modelInputSize(width: number, height: number, shortSide: number): { width: number; height: number } {
  const scale = shortSide / Math.min(width, height);
  const snap = (v: number) => Math.max(PATCH, Math.round(Math.min(v * scale, shortSide * 2) / PATCH) * PATCH);
  return { width: snap(width), height: snap(height) };
}
