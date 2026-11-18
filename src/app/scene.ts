import * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { LngLat } from '@/lib/types';
import { brickSkin, concreteSkin, glassSkin, houseSkin, roofSkin, SKIN_SCALE } from './textures';

/**
 * The 3D scene: terrain, painted buildings with windows and roofs, block trees,
 * and light and sky that follow the real sun.
 */

export const CAMERA_3D = { pitch: 62, bearing: -18 };

/** Muted paint colours of San Francisco houses: creams, greys, sage, the odd salmon or blue. */
const WALLS = ['#e7e0d2', '#d8ccb7', '#c8d1cd', '#e3d5a9', '#bcc6d2', '#d9b7a5', '#d6d3cd', '#b8c2a8', '#cab6c0', '#eeeae2'];
/** Mid-rise apartment blocks: two brick, one concrete. */
const MID = ['#a5694f', '#8f5b4a', '#bdb8ae'];
const BRICK: [number, number, number][] = [[166, 104, 80], [142, 92, 76]];
/** Towers: blue-grey and green-grey glass. */
const GLASS: [number, number, number][] = [[104, 128, 146], [112, 136, 134]];
const GLASS_FAR = ['#7890a0', '#809896'];
/** Flat roofs: tar and gravel greys, a pale membrane, one terracotta. */
const ROOFS = ['#8f8c86', '#a9a59d', '#c9c6be', '#77756f', '#a8826c'];
const N = WALLS.length;

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
    const add = (name: string, skin: { width: number; height: number; data: Uint8Array }) => {
      if (!map.hasImage(name)) map.addImage(name, skin, { pixelRatio: SKIN_SCALE });
    };
    // Every third house is wood siding; the rest are stucco.
    WALLS.forEach((c, i) => add(`bs-wall-${i}`, houseSkin(c, 100 + i, i % 3 === 1)));
    BRICK.forEach((c, i) => add(`bs-mid-${i}`, brickSkin(c, 200 + i)));
    add('bs-mid-2', concreteSkin(MID[2], 202));
    GLASS.forEach((c, i) => add(`bs-glass-${i}`, glassSkin(c, 300 + i)));
    ROOFS.forEach((c, i) => add(`bs-roof-${i}`, roofSkin(c, 400 + i)));

    // Heights snap to 3 m storeys so floors line up with the window rows.
    const height = ['*', 3, ['ceil', ['/', ['coalesce', ['get', 'render_height'], 9], 3]]];
    const base = ['coalesce', ['get', 'render_min_height'], 0];
    const tall = ['>', ['coalesce', ['get', 'render_height'], 9], 42];
    const mid = ['>', ['coalesce', ['get', 'render_height'], 9], 19];
    const numbered = (prefix: string, n: number) => ['concat', prefix, ['to-string', pick(n)]];
    // Houses get painted walls, apartment blocks brick or concrete, towers glass.
    const skin = ['case', tall, numbered('bs-glass-', GLASS.length), mid, numbered('bs-mid-', MID.length), numbered('bs-wall-', N)];
    const list = (colours: string[], n: number) => ['match', pick(n), ...colours.slice(0, n - 1).flatMap((c, i) => [i, c]), colours[n - 1]];
    const flat = ['case', tall, list(GLASS_FAR, GLASS_FAR.length), mid, list(MID, MID.length), list(WALLS, N)];

    // From far away any window pattern turns to grey mush, so distant views
    // use plain wall colours and the detail appears as you come closer.
    map.addLayer(
      {
        id: 'bs-buildings-far',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13,
        maxzoom: 15.6,
        paint: {
          'fill-extrusion-height': height as never,
          'fill-extrusion-base': base as never,
          'fill-extrusion-color': flat as never,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      'duel',
    );
    map.addLayer(
      {
        id: 'bs-buildings',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 15.6,
        paint: {
          'fill-extrusion-height': height as never,
          'fill-extrusion-base': base as never,
          'fill-extrusion-pattern': skin as never,
          'fill-extrusion-vertical-gradient': true,
        },
      },
      'duel',
    );
    // A parapet-height cap textured as a flat roof, which also covers the wall
    // pattern that would otherwise show on top.
    map.addLayer(
      {
        id: 'bs-roofs-far',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 13,
        maxzoom: 15.6,
        paint: {
          'fill-extrusion-base': height as never,
          'fill-extrusion-height': ['+', height, 0.9] as never,
          'fill-extrusion-color': list(ROOFS, ROOFS.length) as never,
          'fill-extrusion-vertical-gradient': false,
        },
      },
      'duel',
    );
    map.addLayer(
      {
        id: 'bs-roofs',
        type: 'fill-extrusion',
        source: 'openmaptiles',
        'source-layer': 'building',
        minzoom: 15.6,
        paint: {
          'fill-extrusion-base': height as never,
          'fill-extrusion-height': ['+', height, 0.9] as never,
          'fill-extrusion-pattern': numbered('bs-roof-', ROOFS.length) as never,
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
          'fill-extrusion-color': '#6f6a64',
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

const SCENE_LAYERS = ['bs-buildings', 'bs-buildings-far', 'bs-roofs', 'bs-roofs-far', 'bs-centerline', 'bs-ground', 'bs-trees', 'bs-trunks'];
/** The base map's own building layers, which ours replace in 3D. */
const STYLE_3D = ['building-3d'];
const STYLE_FLAT = ['building'];

/**
 * Add what the base map lacks for the camera: relief shading and road markings.
 */
function dressBaseMap(map: maplibregl.Map) {
  if (map.getSource('bs-dem') && !map.getSource('bs-relief')) {
    try {
      // Hillshade needs its own copy of the elevation source.
      map.addSource('bs-relief', {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 15,
        encoding: 'terrarium',
      });
      map.addLayer(
        {
          id: 'bs-relief',
          type: 'hillshade',
          source: 'bs-relief',
          paint: { 'hillshade-exaggeration': 0.45, 'hillshade-shadow-color': '#3b4a5a', 'hillshade-highlight-color': '#fff6e0', 'hillshade-accent-color': '#5a6b5a' },
        },
        map.getLayer('blocks') ? 'blocks' : undefined,
      );
    } catch {
      /* relief is decoration */
    }
  }
  if (map.getSource('openmaptiles') && !map.getLayer('bs-centerline')) {
    // The yellow line down the middle of the bigger streets.
    map.addLayer(
      {
        id: 'bs-centerline',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'transportation',
        minzoom: 15,
        filter: ['all', ['==', ['geometry-type'], 'LineString'], ['match', ['get', 'class'], ['primary', 'secondary', 'tertiary', 'trunk'], true, false]],
        paint: {
          'line-color': '#d8b648',
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 15, 0.5, 19, 2.6],
          'line-opacity': 0.9,
        },
      },
      map.getLayer('blocks') ? 'blocks' : undefined,
    );
  }
}

/** Paint the base map as the real thing: asphalt, concrete, grass. Returns what to set. */
function realGround(map: maplibregl.Map): [string, string, unknown][] {
  const out: [string, string, unknown][] = [];
  for (const layer of map.getStyle().layers ?? []) {
    const id = layer.id;
    const sl = (layer as { 'source-layer'?: string })['source-layer'];
    if (id.startsWith('bs-')) continue;
    if (layer.type === 'background') out.push([id, 'background-color', '#c4bfb2']);
    else if (layer.type === 'fill') {
      if (sl === 'water') out.push([id, 'fill-color', '#5f9cc0']);
      else if (id === 'landuse_residential') out.push([id, 'fill-color', '#c9c4b7']);
      else if (id === 'park') out.push([id, 'fill-color', '#7fa867']);
      else if (id === 'landcover_grass' || id === 'landuse_pitch' || id === 'landuse_track') out.push([id, 'fill-color', '#88b06d']);
      else if (id === 'landcover_wood') out.push([id, 'fill-color', '#5f8f55']);
      else if (id === 'landcover_sand') out.push([id, 'fill-color', '#dccfa5']);
      else if (id === 'landuse_school' || id === 'landuse_hospital' || id === 'landuse_cemetery') out.push([id, 'fill-color', '#bfc2aa']);
    } else if (layer.type === 'line' && sl === 'transportation' && !id.includes('rail')) {
      // Casings become the concrete kerb and sidewalk edge; the road itself is asphalt.
      if (id.includes('casing')) out.push([id, 'line-color', '#aeaaa0']);
      else if (id.includes('path_pedestrian')) out.push([id, 'line-color', '#bdb8ab']);
      else if (id.includes('motorway') || id.includes('trunk_primary')) out.push([id, 'line-color', '#46494d']);
      else if (id.includes('secondary_tertiary') || id.includes('link')) out.push([id, 'line-color', '#4d5054']);
      else if (id.includes('service_track')) out.push([id, 'line-color', '#64676a']);
      else out.push([id, 'line-color', '#56595d']);
    } else if (layer.type === 'line' && sl === 'park') out.push([id, 'line-color', '#6f9a5a']);
  }
  return out;
}

/** The base map's own colours, remembered so the flat map can have them back. */
const originals = new WeakMap<maplibregl.Map, [string, string, unknown][]>();

function paintGround(map: maplibregl.Map, real: boolean) {
  const wanted = realGround(map);
  if (!originals.has(map)) originals.set(map, wanted.map(([id, prop]) => [id, prop, map.getPaintProperty(id, prop as never)]));
  for (const [id, prop, value] of real ? wanted : originals.get(map)!) {
    try {
      map.setPaintProperty(id, prop as never, value as never);
    } catch {
      /* a layer this base map does not have */
    }
  }
}

export function setSceneMode(map: maplibregl.Map, on: boolean, scores = false) {
  dressBaseMap(map);
  // White roads belong on a map, not in a view of the city, so 3D repaints the ground.
  paintGround(map, on);
  // In 3D the picture leads: no labels, and street scores only when asked for.
  // Flat is the working map, with both.
  for (const layer of map.getStyle().layers ?? []) {
    if (layer.type === 'symbol') map.setLayoutProperty(layer.id, 'visibility', on ? 'none' : 'visible');
  }
  if (map.getLayer('blocks')) map.setPaintProperty('blocks', 'line-opacity', on ? (scores ? 0.8 : 0) : 0.85);
  if (map.getLayer('bs-relief')) map.setLayoutProperty('bs-relief', 'visibility', on ? 'visible' : 'none');
  map.setMinZoom(on ? 12.6 : 11);
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
      // Plenty of haze, so the far city melts into the sky instead of ending in a hard edge.
      'sky-horizon-blend': 0.8,
      'horizon-fog-blend': 0.9,
      'fog-ground-blend': 0.55,
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
