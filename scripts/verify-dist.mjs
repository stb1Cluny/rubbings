// Post-build checks for the static site in dist/:
//  - the page loads nothing from other origins and carries the Content-Security-Policy
//  - no unexpected external addresses appear anywhere in the built code
//  - the self-hosted model and runtime files are present and within hosting limits
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const problems = [];

/**
 * Hosts that appear as text inside third-party libraries but are never contacted:
 *  - huggingface.co, cdn.jsdelivr.net: library defaults, overridden to this site's own files
 *    and additionally blocked by the same-origin guard in src/depth/depth.worker.ts
 *  - the rest: links inside comments, error messages and XML namespaces
 */
const INERT_HOSTS = new Set([
  'huggingface.co',
  'cdn.jsdelivr.net',
  'github.com',
  'gist.github.com',
  'web.dev',
  'developer.mozilla.org',
  'rolldown.rs',
  'www.w3.org',
]);

/** GitHub Pages: files over 100 MB are rejected; sites should stay under 1 GB. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_SITE_BYTES = 1024 * 1024 * 1024;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const files = await walk(dist).catch(() => {
  console.error('dist/ not found. Run the build first.');
  process.exit(1);
});

// --- index.html ---------------------------------------------------------------------------
const html = await readFile(join(dist, 'index.html'), 'utf8');
// Quotes inside the attribute may be written as character references.
const csp = (html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/)?.[1] ?? '')
  .replaceAll('&#39;', "'")
  .replaceAll('&apos;', "'");
if (!csp) problems.push('index.html has no Content-Security-Policy meta tag');
else if (!/connect-src 'self'(;|$)/.test(csp)) problems.push("the Content-Security-Policy does not restrict connect-src to 'self'");
for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
  if (/^(?:https?:)?\/\//i.test(match[1])) problems.push(`index.html loads an external resource: ${match[1]}`);
}

// --- external hosts named anywhere in the built text files ---------------------------------
const textTypes = new Set(['.js', '.mjs', '.css', '.html']);
const hosts = new Map();
let totalBytes = 0;
for (const file of files) {
  const info = await stat(file);
  totalBytes += info.size;
  const name = relative(dist, file).replaceAll('\\', '/');
  if (info.size > MAX_FILE_BYTES) problems.push(`${name} is ${(info.size / 1e6).toFixed(1)} MB, over the 100 MB per-file limit`);
  if (!textTypes.has(extname(file))) continue;
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const host = match[1].toLowerCase();
    if (!hosts.has(host)) hosts.set(host, new Set());
    hosts.get(host).add(name);
  }
}
for (const [host, where] of hosts) {
  if (!INERT_HOSTS.has(host)) problems.push(`unexpected external host "${host}" in ${[...where].join(', ')}`);
}
if (totalBytes > MAX_SITE_BYTES) problems.push(`site is ${(totalBytes / 1e6).toFixed(0)} MB, over 1 GB`);

// --- self-hosted model and runtime ---------------------------------------------------------
const required = [
  'models/onnx-community/depth-anything-v2-small/config.json',
  'models/onnx-community/depth-anything-v2-small/preprocessor_config.json',
  'models/onnx-community/depth-anything-v2-small/onnx/model_q4f16.onnx',
  'models/onnx-community/depth-anything-v2-small/onnx/model_quantized.onnx',
  '404.html',
  'licenses/index.html',
];
const names = new Set(files.map((file) => relative(dist, file).replaceAll('\\', '/')));
for (const name of required) if (!names.has(name)) problems.push(`missing ${name} (run "npm run fetch-model" before building)`);
const wasm = [...names].filter((name) => name.endsWith('.wasm'));
if (wasm.length !== 2) problems.push(`expected 2 ONNX Runtime .wasm files, found ${wasm.length}: ${wasm.join(', ')}`);

console.log(`dist: ${files.length} files, ${(totalBytes / 1e6).toFixed(1)} MB`);
console.log(`hosts named in built code (all inert): ${[...hosts.keys()].sort().join(', ') || 'none'}`);
if (problems.length) {
  console.error(`\nverify-dist found ${problems.length} problem(s):`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log('verify-dist: ok');
