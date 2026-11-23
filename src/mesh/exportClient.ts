import type { PlateShape } from '../shapes/outline';
import type { ExportRequest, ExportResponse } from './export.worker';

export interface ExportResult {
  blob: Blob;
  triangles: number;
  bytes: number;
}

let worker: Worker | null = null;
let nextId = 1;
const waiters = new Map<number, { resolve: (result: ExportResult) => void; reject: (error: Error) => void }>();

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<ExportResponse>) => {
    const message = event.data;
    const waiter = waiters.get(message.id);
    waiters.delete(message.id);
    if (!waiter) return;
    if (message.type === 'error') waiter.reject(new Error(message.message));
    else {
      waiter.resolve({
        blob: new Blob(message.parts, { type: 'model/stl' }),
        triangles: message.triangles,
        bytes: message.bytes,
      });
    }
  };
  return worker;
}

/** Build a plate STL. `heights` is copied, so the caller keeps its array. */
export function exportStl(
  heights: Float32Array,
  nx: number,
  ny: number,
  shape: PlateShape,
  baseThickness: number,
  title: string,
): Promise<ExportResult> {
  const id = nextId++;
  const copy = heights.slice();
  const request: ExportRequest = { id, heights: copy, nx, ny, shape, baseThickness, title };
  return new Promise<ExportResult>((resolve, reject) => {
    waiters.set(id, { resolve, reject });
    ensureWorker().postMessage(request, [copy.buffer]);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
