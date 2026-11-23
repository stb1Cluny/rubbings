import type { PlateShape } from '../shapes/outline';
import type { DepthSource } from './bands';
import type { ReliefParams } from './compose';
import type { ReliefRequest, ReliefResponse } from './relief.worker';

export interface PreparedInfo {
  histogram: Float32Array;
  split: number;
  hasDepth: boolean;
}

export interface ComposedRelief {
  heights: Float32Array;
  rubbing: Uint8ClampedArray | null;
  tint: Uint8ClampedArray | null;
  raisedShare: number;
}

export interface ComposeOptions {
  rubbing: boolean;
  tint: boolean;
}

/**
 * Talks to the relief worker. Compose requests are "latest wins": while one is running, only
 * the most recent newer request is kept, so dragging a slider never builds up a backlog.
 */
export class ReliefClient {
  private worker = new Worker(new URL('./relief.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private prepareWaiters = new Map<number, { resolve: (info: PreparedInfo) => void; reject: (error: Error) => void }>();
  private busy = false;
  private queued: { params: ReliefParams; options: ComposeOptions } | null = null;
  private ready = false;
  private epoch = 0;
  private inflightEpoch = 0;
  onComposed: (result: ComposedRelief) => void = () => {};
  onError: (error: Error) => void = () => {};

  constructor() {
    this.worker.onmessage = (event: MessageEvent<ReliefResponse>) => this.handle(event.data);
    this.worker.onerror = (event) => this.onError(new Error(event.message || 'Relief worker failed'));
  }

  private handle(message: ReliefResponse): void {
    if (message.type === 'prepared') {
      this.ready = true;
      this.prepareWaiters.get(message.id)?.resolve(message);
      this.prepareWaiters.delete(message.id);
      return;
    }
    if (message.type === 'error') {
      const waiter = this.prepareWaiters.get(message.id);
      if (waiter) {
        waiter.reject(new Error(message.message));
        this.prepareWaiters.delete(message.id);
      } else {
        this.onError(new Error(message.message));
      }
      this.busy = false;
      this.flush();
      return;
    }
    this.busy = false;
    // Results composed for an earlier crop are stale once a new prepare has been issued.
    if (this.inflightEpoch === this.epoch) this.onComposed(message);
    this.flush();
  }

  /** Build the maps for a new crop. Any queued compose for the old crop is dropped. */
  prepare(rgba: Uint8ClampedArray, nx: number, ny: number, pitch: number, shape: PlateShape, depth: DepthSource | null): Promise<PreparedInfo> {
    this.queued = null;
    this.ready = false;
    this.epoch++;
    const id = this.nextId++;
    const request: ReliefRequest = { type: 'prepare', id, rgba, nx, ny, pitch, shape, depth };
    return new Promise<PreparedInfo>((resolve, reject) => {
      this.prepareWaiters.set(id, { resolve, reject });
      this.worker.postMessage(request, [rgba.buffer]);
    });
  }

  compose(params: ReliefParams, options: ComposeOptions): void {
    this.queued = { params: { ...params }, options };
    this.flush();
  }

  private flush(): void {
    if (this.busy || !this.ready || !this.queued) return;
    const { params, options } = this.queued;
    this.queued = null;
    this.busy = true;
    this.inflightEpoch = this.epoch;
    const request: ReliefRequest = { type: 'compose', id: this.nextId++, params, ...options };
    this.worker.postMessage(request);
  }
}
