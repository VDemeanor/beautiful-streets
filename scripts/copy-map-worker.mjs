// MapLibre runs its tile work in a web worker that must be served as its own
// file. Copy it from the package into public/ so the app can point at it.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('public', { recursive: true });
copyFileSync('node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs', 'public/maplibre-gl-worker.mjs');
