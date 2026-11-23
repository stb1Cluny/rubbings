/// <reference lib="webworker" />
// Builds the printable mesh and encodes it as STL off the main thread.
import type { PlateShape } from '../shapes/outline';
import { buildPlateMesh } from './plateMesher';
import { writeBinaryStl } from './stlWriter';

export interface ExportRequest {
  id: number;
  heights: Float32Array;
  nx: number;
  ny: number;
  shape: PlateShape;
  baseThickness: number;
  title: string;
}

export type ExportResponse =
  | { type: 'done'; id: number; parts: ArrayBuffer[]; triangles: number; bytes: number }
  | { type: 'error'; id: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<ExportRequest>) => {
  const request = event.data;
  try {
    const mesh = buildPlateMesh({ nx: request.nx, ny: request.ny, data: request.heights }, request.shape, request.baseThickness);
    const parts = writeBinaryStl(mesh, request.title);
    const bytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const response: ExportResponse = { type: 'done', id: request.id, parts, triangles: mesh.indices.length / 3, bytes };
    ctx.postMessage(response, parts);
  } catch (error) {
    const response: ExportResponse = {
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    };
    ctx.postMessage(response);
  }
};
