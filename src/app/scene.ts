import * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { LngLat } from '@/lib/types';

/**
 * The 3D scene: terrain, painted buildings with windows and roofs, block trees,
 * and light and sky that follow the real sun.
 */

export const CAMERA_3D = { pitch: 62, bearing: -18 };

/** House colours borrowed from San Francisco's painted Victorians and stucco flats. */
const WALLS = ['#f3dcc6', '#ead0b0', '#dbe6de', '#f6e9b8', '#cddbea', '#f1c9bd', '#e7e1d4', '#d3e3c6', '#e9d4e0', '#c9e0e0'];
// Mostly pale flat roofs, with the odd terracotta one.
const ROOFS = ['#ddd7cd', '#cdd2d6', '#e4d9c7', '#d2d9d1', '#c99a80'];
const N = WALLS.length;

/** A square of facade: three floors of three windows with sills, lintels and a cornice line. */
function wallImage(color: string): { width: number; height: number; data: Uint8Array } {
  // Drawn at double resolution so windows stay crisp when the camera is at street level.
  const size = 96;
  const scale = 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size * scale;
  const g = cv.getContext('2d')!;
  g.scale(scale, scale);
  g.fillStyle = color;
  g.fillRect(0, 0, size, size);
  const cell = size / 3;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x = col * cell + 9;
      const y = row * cell + 7;
      g.fillStyle = 'rgba(255,255,255,0.55)'; // frame
      g.fillRect(x - 1.5, y - 1.5, 17, 20);
      g.fillStyle = 'rgba(38,58,84,0.78)'; // glass
      g.fillRect(x, y, 14, 17);
      g.fillStyle = 'rgba(190,220,240,0.5)'; // sky reflected in the top pane
      g.fillRect(x, y, 14, 5);
      g.fillStyle = 'rgba(255,255,255,0.6)'; // mullion
      g.fillRect(x + 6.5, y, 1, 17);
      g.fillStyle = 'rgba(0,0,0,0.16)'; // sill shadow
      g.fillRect(x - 2, y + 18.5, 18, 2);
    }
    g.fillStyle = 'rgba(0,0,0,0.10)'; // floor line
    g.fillRect(0, (row + 1) * cell - 1.5, size, 1.5);
  }
  const d = g.getImageData(0, 0, size * scale, size * scale);
  return { width: size * scale, height: size * scale, data: new Uint8Array(d.data.buffer) };
}

/** Which palette entry a building gets: stable per building, varied between neighbours. */
const pick = (n: number) => ['%', ['floor', ['/', ['to-number', ['id'], 0], 10]], n];

function squares(points: LngLat[], halfMetres: number): FeatureCollection {
  const features: Feature[] = points.map(([lng, lat], i) => {
    const dLat = halfMetres / 111320;
    const dLng = halfMetres / (111320 * Math.cos((lat * Math.PI) / 180));
    return {
      type: 'Feature',
      // A little variety so the canopy is not one flat sheet of green.
      properties: { v: i % 4, h: 5.5 + ((i * 7) % 5) },
      geometry: {
        type: 'Polygon',
        coordinates: [[[lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat], [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]]],
      },
    };
  });
  return { type: 'FeatureCollection', features };
}

/** Add everything. Each part is optional, so a missing source leaves the rest working. */
export function installScene(map: maplibregl.Map) {
  try {
    map.addSource('bs-dem', {
      type: 'raster-dem',
      tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      maxzoom: 15,
      encoding: 'terrarium',
      attribution: 'Terrain: Mapzen, USGS',
    });
  } catch {
    /* terrain is optional */
  }

  if (map.getSource('openmaptiles')) {
    WALLS.forEach((c, i) => {
      if (!map.hasImage(`bs-wall-${i}`)) map.addImage(`bs-wall-${i}`, wallImage(c), { pixelRatio: 2 });
    });
    // Heights snap to 3 m storeys so buildings read as stacked blocks.
    const height = ['*', 3, ['ceil', ['/', ['coalesce', ['get', 'render_height'], 9], 3]]];
    const base = ['coalesce', ['get', 'render_min_height'], 0];
    map.addLayer(
      {
        id: 'bs-buildings',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13,
        paint: {
          'fill-extrusion-height': height as never,
          'fill-extrusion-base': base as never,
          'fill-extrusion-pattern': ['concat', 'bs-wall-', ['to-string', pick(N)]] as never,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      'duel',
    );
    // A thin cap in a roof colour hides the window pattern on top and adds a parapet edge.
    map.addLayer(
      {
        id: 'bs-roofs',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13,
        paint: {
          'fill-extrusion-base': height as never,
          'fill-extrusion-height': ['+', height, 0.9] as never,
          'fill-extrusion-color': ['match', pick(ROOFS.length), 0, ROOFS[0], 1, ROOFS[1], 2, ROOFS[2], 3, ROOFS[3], ROOFS[4]] as never,
          'fill-extrusion-vertical-gradient': false,
        },
      },
      'duel',
    );
    // A darker ground-floor band: shopfronts, garages and doorways.
    map.addLayer(
      {
        id: 'bs-ground',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 15,
        paint: {
          'fill-extrusion-base': base as never,
          'fill-extrusion-height': ['+', base, 0.6] as never,
          'fill-extrusion-color': '#7d7872',
        },
      },
      'duel',
    );
  }
}

/** Street trees as little block trees: a brown trunk under a green cube. */
export function installTrees(map: maplibregl.Map, trees: LngLat[]) {
  if (!trees.length || map.getSource('bs-trees')) return;
  map.addSource('bs-trees', { type: 'geojson', data: squares(trees, 1.45) });
  map.addSource('bs-trunks', { type: 'geojson', data: squares(trees, 0.35) });
  const before = map.getLayer('duel') ? 'duel' : undefined;
  map.addLayer(
    {
      id: 'bs-trunks',
      type: 'fill-extrusion',
      source: 'bs-trunks',
      minzoom: 15.5,
      paint: { 'fill-extrusion-color': '#6b4a32', 'fill-extrusion-height': 2.6 },
    },
    before,
  );
  map.addLayer(
    {
      id: 'bs-trees',
      type: 'fill-extrusion',
      source: 'bs-trees',
      minzoom: 14.5,
      paint: {
        'fill-extrusion-color': ['match', ['get', 'v'], 0, '#3f8a4c', 1, '#56a25a', 2, '#2f7446', '#7ab567'],
        'fill-extrusion-base': 2.2,
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-vertical-gradient': true,
      },
    },
    before,
  );
}

const SCENE_LAYERS = ['bs-buildings', 'bs-roofs', 'bs-ground', 'bs-trees', 'bs-trunks'];
/** The base map's own building layers, which ours replace in 3D. */
const STYLE_3D = ['building-3d'];
const STYLE_FLAT = ['building'];

export function setSceneMode(map: maplibregl.Map, on: boolean) {
  try {
    map.setTerrain(on && map.getSource('bs-dem') ? { source: 'bs-dem', exaggeration: 1.35 } : null);
  } catch {
    /* terrain is optional */
  }
  const show = (id: string, visible: boolean) => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
  };
  for (const id of SCENE_LAYERS) show(id, on);
  for (const id of STYLE_3D) show(id, false);
  for (const id of STYLE_FLAT) show(id, !on || !map.getLayer('bs-buildings'));
  const target = on ? CAMERA_3D : { pitch: 0, bearing: 0 };
  if (Math.abs(map.getPitch() - target.pitch) > 1) map.easeTo({ ...target, duration: 900 });
}

export interface Sun {
  /** Degrees clockwise from north. */
  azimuth: number;
  /** Degrees above the horizon; negative at night. */
  altitude: number;
  /** 0..100 */
  cloud: number;
}

const mix = (a: string, b: string, t: number) => {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0')).join('');
};

/** Sky colours for the sun's height: night, a warm band around sunrise and sunset, then day. */
export function skyColors(sun: Sun): { sky: string; horizon: string; fog: string; phase: 'night' | 'golden' | 'day' } {
  const grey = sun.cloud / 100;
  if (sun.altitude < -6) return { sky: '#0b1430', horizon: '#1b2647', fog: '#141c33', phase: 'night' };
  if (sun.altitude < 8) {
    const t = (sun.altitude + 6) / 14; // dusk -> low sun
    return {
      sky: mix(mix('#22305c', '#5f9fd6', t), '#8d99a6', grey * 0.7),
      horizon: mix(mix('#e0734a', '#ffc98a', t), '#b9b4ae', grey * 0.7),
      fog: mix('#c98a6a', '#f1dcc0', t),
      phase: 'golden',
    };
  }
  return {
    sky: mix('#3f93dd', '#9aa6b0', grey * 0.8),
    horizon: mix('#cfe6f7', '#d5d8da', grey * 0.8),
    fog: mix('#e3eff7', '#dcdfe0', grey * 0.8),
    phase: 'day',
  };
}

/** Light the buildings from where the sun really is, and colour the sky to match. */
export function applySun(map: maplibregl.Map, sun: Sun) {
  const c = skyColors(sun);
  const up = Math.max(sun.altitude, 4);
  try {
    map.setLight({
      anchor: 'map',
      // [distance, azimuth, polar angle from straight overhead]
      position: [1.5, sun.azimuth, 90 - up],
      color: c.phase === 'night' ? '#8fa3d9' : c.phase === 'golden' ? '#ffd2a1' : '#fff6e6',
      intensity: c.phase === 'night' ? 0.25 : 0.35 + 0.3 * (1 - sun.cloud / 100),
    });
  } catch {
    /* lighting is decoration */
  }
  try {
    map.setSky({
      'sky-color': c.sky,
      'horizon-color': c.horizon,
      'fog-color': c.fog,
      'sky-horizon-blend': 0.7,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.25,
    });
  } catch {
    /* sky is decoration */
  }
  return c.phase;
}

/**
 * Where the sun sits on screen for the current camera, or null when it is
 * behind the camera or the sky is out of view. `above` means it is higher than
 * the top of the view, so it is pinned to the top edge as a glow.
 */
export function sunOnScreen(map: maplibregl.Map, sun: Sun): { x: number; y: number; above: boolean } | null {
  if (sun.altitude < -2) return null;
  const box = map.getContainer().getBoundingClientRect();
  const rad = Math.PI / 180;
  const fov = (map.getVerticalFieldOfView?.() ?? 36.87) * rad;
  const f = box.height / 2 / Math.tan(fov / 2);
  // The centre of the view looks this far below the horizon.
  const centre = -(90 - map.getPitch());
  const horizonY = box.height / 2 - f * Math.tan(-centre * rad);
  if (horizonY < 8) return null; // no sky in view
  const delta = ((sun.azimuth - map.getBearing() + 540) % 360) - 180;
  if (Math.abs(delta) > 70) return null;
  const x = box.width / 2 + f * Math.tan(delta * rad);
  if (x < -40 || x > box.width + 40) return null;
  const lift = sun.altitude - centre;
  const y = lift >= 85 ? -1 : box.height / 2 - f * Math.tan(lift * rad);
  if (y < 22) return { x, y: 22, above: true };
  if (y > horizonY) return null;
  return { x, y, above: false };
}
