import type { DepthRequest, DepthResponse } from './depth.worker';
import type { Backend } from './ortConfig';

export interface DepthMap {
  /** Raw model output, larger = nearer. Row-major, `width * height` values. */
  data: Float32Array;
  width: number;
  height: number;
  backend: Backend;
  ms: number;
}

export interface DepthStatus {
  text: string;
  /** 0..1 while model files are downloading, otherwise null. */
  progress: number | null;
}

/** Longest side of the image handed to the depth worker; the model resizes it further. */
const MAX_INPUT_SIDE = 1036;

export class DepthClient {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (map: DepthMap) => void; reject: (error: Error) => void }>();
  onStatus: (status: DepthStatus) => void = () => {};

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./depth.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<DepthResponse>) => this.handle(event.data);
    worker.onerror = (event) => this.failAll(new Error(event.message || 'Depth worker failed to start'));
    const init: DepthRequest = {
      type: 'init',
      baseUrl: new URL('.', document.baseURI).href,
      // Debug switches: ?backend=wasm forces the CPU path, ?dtype=<variant> tries another model file.
      forceWasm: new URLSearchParams(location.search).get('backend') === 'wasm',
      dtype: new URLSearchParams(location.search).get('dtype') ?? undefined,
    };
    worker.postMessage(init);
    this.worker = worker;
    return worker;
  }

  private handle(message: DepthResponse): void {
    switch (message.type) {
      case 'status':
        this.onStatus({ text: message.text, progress: null });
        break;
      case 'progress':
        this.onStatus({
          text: 'Downloading depth model',
          progress: message.total > 0 ? message.loaded / message.total : null,
        });
        break;
      case 'result': {
        const { id, type: _type, ...map } = message;
        this.pending.get(id)?.resolve(map);
        this.pending.delete(id);
        break;
      }
      case 'error':
        this.pending.get(message.id)?.reject(new Error(message.message));
        this.pending.delete(message.id);
        break;
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  /** Estimate depth for a canvas (or a region of it). Resolves with the raw depth map. */
  estimate(
    source: HTMLCanvasElement,
    region?: { x: number; y: number; width: number; height: number },
  ): Promise<DepthMap> {
    const r = region ?? { x: 0, y: 0, width: source.width, height: source.height };
    const scale = Math.min(1, MAX_INPUT_SIDE / Math.max(r.width, r.height));
    const width = Math.max(1, Math.round(r.width * scale));
    const height = Math.max(1, Math.round(r.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
    c2d.imageSmoothingQuality = 'high';
    c2d.drawImage(source, r.x, r.y, r.width, r.height, 0, 0, width, height);
    const image = c2d.getImageData(0, 0, width, height);

    const id = this.nextId++;
    const worker = this.ensureWorker();
    return new Promise<DepthMap>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const request: DepthRequest = { type: 'run', id, image };
      worker.postMessage(request, [image.data.buffer]);
    });
  }
}
