import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Content-Security-Policy for the production page. It only lets the page talk to its own origin;
 * the single exception is loading a linked image (img-src https:), which sends nothing but the
 * request for that image. Injected at build time only, because a CSP meta tag breaks dev HMR.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "img-src 'self' blob: data: https:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

/** Ship the licence texts of the bundled libraries next to the licences page. */
function licenseFiles(): Plugin {
  const sources: Record<string, string> = {
    'licenses/three.txt': 'node_modules/three/LICENSE',
    'licenses/apache-2.0.txt': 'node_modules/@huggingface/transformers/LICENSE',
  };
  return {
    name: 'license-files',
    apply: 'build',
    async generateBundle() {
      for (const [fileName, source] of Object.entries(sources)) {
        this.emitFile({ type: 'asset', fileName, source: await readFile(source, 'utf8') });
      }
    },
  };
}

export default defineConfig({
  // Relative base: the built site works from any folder (user.github.io/<repo>/ included).
  base: './',
  appType: 'mpa',
  plugins: [cspPlugin(), licenseFiles()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
