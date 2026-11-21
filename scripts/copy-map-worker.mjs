// Files that must be served on their own rather than bundled. MapLibre runs
// its tile work in a web worker, and the cinematic city needs the Draco
// decoder to unpack Google's 3D tiles. Copy both from their packages into public/.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public/draco', { recursive: true });
copyFileSync('node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', 'public/maplibre-gl-worker.mjs');
for (const file of ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'])
  copyFileSync(`node_modules/three/examples/jsm/libs/draco/gltf/${file}`, `public/draco/${file}`);
