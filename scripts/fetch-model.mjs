// Downloads the depth model into public/models/ so the site can serve it itself.
// Files are pinned to one revision and verified by size and SHA-256.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const REPO = 'onnx-community/depth-anything-v2-small';
const REVISION = '4472b7362082ad9968fee890ca0f1e5aca36b93d';

/** sha256 is null for small JSON files, which are checked by size only. */
const FILES = [
  { path: 'config.json', size: 38, sha256: null },
  { path: 'preprocessor_config.json', size: 461, sha256: null },
  {
    // WebGPU path: 4-bit weights with half-float activations. Within 0.3% of the fp16 model's
    // depth (Pearson 0.998 on test photos) at well under half the download.
    path: 'onnx/model_q4f16.onnx',
    size: 19126267,
    sha256: 'eca72971aea64216d767c70c534160de53b5435b588d362bac6dbd5a73f9bf1e',
  },
  {
    // WASM (CPU) path: 8-bit quantised, the runtime's own default for WASM.
    path: 'onnx/model_quantized.onnx',
    size: 27258801,
    sha256: 'fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d',
  },
];

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'models', REPO);

async function sha256Of(file) {
  const hash = createHash('sha256');
  hash.update(await readFile(file));
  return hash.digest('hex');
}

async function isValid(file, spec) {
  try {
    const info = await stat(file);
    if (info.size !== spec.size) return false;
    return spec.sha256 === null || (await sha256Of(file)) === spec.sha256;
  } catch {
    return false;
  }
}

for (const spec of FILES) {
  const dest = join(outDir, spec.path);
  if (await isValid(dest, spec)) {
    console.log(`ok       ${spec.path}`);
    continue;
  }
  await mkdir(dirname(dest), { recursive: true });
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${spec.path}`;
  console.log(`download ${spec.path} (${(spec.size / 1e6).toFixed(1)} MB)`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const partial = `${dest}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  if (!(await isValid(partial, spec))) {
    await rm(partial, { force: true });
    throw new Error(`Checksum or size mismatch for ${spec.path}`);
  }
  await rename(partial, dest);
}
// Remove anything else in the model folder, so stale variants are never deployed.
const wanted = new Set(FILES.map((spec) => spec.path));
async function prune(dir, prefix) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relativePath = prefix + entry.name;
    if (entry.isDirectory()) await prune(join(dir, entry.name), `${relativePath}/`);
    else if (!wanted.has(relativePath)) {
      await rm(join(dir, entry.name));
      console.log(`removed  ${relativePath}`);
    }
  }
}
await prune(outDir, '');
console.log(`Model ready in ${outDir}`);
