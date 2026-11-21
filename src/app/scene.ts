import * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { LngLat } from '@/lib/types';
import { brickSkin, concreteSkin, glassSkin, houseSkin, roofSkin, SKIN_SCALE } from './textures';
import type { Vehicle } from './traffic';

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
const ROOFS = ['#bdbab2', '#cbc7be', '#dfdcd4', '#a9a69f', '#c59c84'];
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

const tall = ['>', ['coalesce', ['get', 'render_height'], 9], 42];
const mid = ['>', ['coalesce', ['get', 'render_height'], 9], 19];
const numbered = (prefix: string, n: number) => ['concat', prefix, ['to-string', pick(n)]];
const list = (colours: string[], n: number) => ['match', pick(n), ...colours.slice(0, n - 1).flatMap((c, i) => [i, c]), colours[n - 1]];
/** Mix two hex colours. */
const mix = (a: string, b: string, t: number) => {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0')).join('');
};
const NIGHT_INK = '#090d1e';
const dusk = (colours: string[], night: boolean) => (night ? colours.map((c) => mix(c, NIGHT_INK, 0.74)) : colours);
/** Houses get painted walls, apartment blocks brick or concrete, towers glass. */
const wallSkin = (night: boolean) => {
  const n = night ? 'night-' : '';
  return ['case', tall, numbered(`bs-${n}glass-`, GLASS.length), mid, numbered(`bs-${n}mid-`, MID.length), numbered(`bs-${n}wall-`, N)];
};
const wallFlat = (night: boolean) => ['case', tall, list(dusk(GLASS_FAR, night), GLASS_FAR.length), mid, list(dusk(MID, night), MID.length), list(dusk(WALLS, night), N)];
const roofSkinName = (night: boolean) => numbered(`bs-${night ? 'night-' : ''}roof-`, ROOFS.length);
const roofFlat = (night: boolean) => list(dusk(ROOFS, night), ROOFS.length);

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
    // Each skin is painted twice: by day, and by night with some of its windows lit.
    for (const night of [false, true]) {
      const n = night ? 'night-' : '';
      WALLS.forEach((c, i) => add(`bs-${n}wall-${i}`, houseSkin(c, 100 + i, i % 3 === 1, night)));
      BRICK.forEach((c, i) => add(`bs-${n}mid-${i}`, brickSkin(c, 200 + i, night)));
      add(`bs-${n}mid-2`, concreteSkin(MID[2], 202, night));
      GLASS.forEach((c, i) => add(`bs-${n}glass-${i}`, glassSkin(c, 300 + i, night)));
      ROOFS.forEach((c, i) => add(`bs-${n}roof-${i}`, roofSkin(c, 400 + i, night)));
    }

    // Heights snap to 3 m storeys so floors line up with the window rows.
    const height = ['*', 3, ['ceil', ['/', ['coalesce', ['get', 'render_height'], 9], 3]]];
    const base = ['coalesce', ['get', 'render_min_height'], 0];
    const skin = wallSkin(false);
    const flat = wallFlat(false);

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
          'fill-extrusion-color': roofFlat(false) as never,
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
          'fill-extrusion-pattern': roofSkinName(false) as never,
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

const CAR_COLOURS = ['#ededeb', '#b3b8bd', '#151517', '#545c66', '#213866', '#8c1714'];

/** A rectangle on the ground, centred on a point and turned to a compass heading. */
function footprint(at: LngLat, heading: number, length: number, width: number, shift = 0): number[][] {
  const rad = Math.PI / 180;
  const kx = 111320 * Math.cos(at[1] * rad);
  const fx = Math.sin(heading * rad);
  const fy = Math.cos(heading * rad);
  const corner = (along: number, across: number) => [
    at[0] + ((along + shift) * fx + across * fy) / kx,
    at[1] + ((along + shift) * fy - across * fx) / 111320,
  ];
  const l = length / 2;
  const w = width / 2;
  return [corner(l, -w), corner(l, w), corner(-l, w), corner(-l, -w), corner(l, -w)];
}

/** Traffic in the drawn city: each vehicle is a body block with a darker cabin on top. */
export function drawVehicles(map: maplibregl.Map, vehicles: Vehicle[], night = false) {
  const bodies: Feature[] = [];
  const cabins: Feature[] = [];
  const lights: Feature[] = [];
  const tint = (c: string) => (night ? mix(c, NIGHT_INK, 0.62) : c);
  const point = (at: LngLat, heading: number, along: number, across: number, k: string): Feature => {
    const rad = Math.PI / 180;
    const kx = 111320 * Math.cos(at[1] * rad);
    const fx = Math.sin(heading * rad);
    const fy = Math.cos(heading * rad);
    return { type: 'Feature', properties: { k }, geometry: { type: 'Point', coordinates: [at[0] + (along * fx + across * fy) / kx, at[1] + (along * fy - across * fx) / 111320] } };
  };
  for (const v of vehicles) {
    if (v.type === 'ferry') {
      bodies.push({ type: 'Feature', properties: { c: tint('#16263f'), h: 2.4, b: 0 }, geometry: { type: 'Polygon', coordinates: [footprint(v.at, v.heading, 40, 10)] } });
      cabins.push({ type: 'Feature', properties: { c: night ? '#7d6a48' : '#f1f1ee', h: 7.6, b: 2.4 }, geometry: { type: 'Polygon', coordinates: [footprint(v.at, v.heading, 30, 8.4, -2)] } });
      if (night) for (const along of [-12, -4, 4, 12]) lights.push(point(v.at, v.heading, along, 0, 'deck'));
      continue;
    }
    const cable = v.type === 'cable';
    bodies.push({
      type: 'Feature',
      properties: { c: tint(cable ? '#6b1217' : CAR_COLOURS[v.paint % CAR_COLOURS.length]), h: cable ? 1.3 : 0.9, b: 0.3 },
      geometry: { type: 'Polygon', coordinates: [footprint(v.at, v.heading, cable ? 8.4 : 4.4, cable ? 2.4 : 1.8)] },
    });
    cabins.push({
      type: 'Feature',
      properties: { c: cable ? (night ? '#b08a4a' : '#ece0bd') : night ? '#0b1018' : '#1a2530', h: cable ? 2.9 : 1.45, b: cable ? 1.3 : 0.9 },
      geometry: { type: 'Polygon', coordinates: [footprint(v.at, v.heading, cable ? 8.6 : 2.4, cable ? 2.5 : 1.6, cable ? 0 : -0.25)] },
    });
    if (night) {
      // Headlights throw a pool of light on the road ahead; tail lights glow red behind.
      const half = cable ? 4.2 : 2.2;
      lights.push(point(v.at, v.heading, half + 5, 0, 'beam'));
      lights.push(point(v.at, v.heading, half, -0.6, 'head'), point(v.at, v.heading, half, 0.6, 'head'));
      lights.push(point(v.at, v.heading, -half, -0.6, 'tail'), point(v.at, v.heading, -half, 0.6, 'tail'));
    }
  }
  const data = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
  const body = map.getSource('bs-cars') as maplibregl.GeoJSONSource | undefined;
  if (!body) {
    // Lights lie on the road, so they go under the buildings and are hidden by them.
    const under = map.getLayer('bs-buildings-far') ? 'bs-buildings-far' : map.getLayer('duel') ? 'duel' : undefined;
    const metres = (m: number) => ['interpolate', ['exponential', 2], ['zoom'], 13, m * 0.1325, 20, m * 16.95];
    map.addSource('bs-car-lights', { type: 'geojson', data: data(lights) });
    map.addLayer(
      {
        id: 'bs-car-beams',
        type: 'circle',
        source: 'bs-car-lights',
        minzoom: 14.5,
        filter: ['==', ['get', 'k'], 'beam'],
        paint: { 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map', 'circle-radius': metres(6.5) as never, 'circle-color': '#fff1c7', 'circle-blur': 1, 'circle-opacity': 0.55 },
      },
      under,
    );
    map.addLayer(
      {
        id: 'bs-car-lamps',
        type: 'circle',
        source: 'bs-car-lights',
        minzoom: 13,
        filter: ['!=', ['get', 'k'], 'beam'],
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 0.8, 16, 1.4, 19, 3.2],
          'circle-color': ['match', ['get', 'k'], 'tail', '#ff3a2c', 'deck', '#ffd98a', '#fffbe8'],
          'circle-blur': 0.35,
        },
      },
      under,
    );
    const before = map.getLayer('duel') ? 'duel' : undefined;
    for (const [id, features] of [['bs-cars', bodies], ['bs-car-tops', cabins]] as const) {
      map.addSource(id, { type: 'geojson', data: data(features) });
      map.addLayer(
        {
          id,
          type: 'fill-extrusion',
          source: id,
          minzoom: 13,
          paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-base': ['get', 'b'] },
        },
        before,
      );
    }
    return;
  }
  body.setData(data(bodies));
  (map.getSource('bs-car-tops') as maplibregl.GeoJSONSource).setData(data(cabins));
  (map.getSource('bs-car-lights') as maplibregl.GeoJSONSource | undefined)?.setData(data(lights));
}

/** One street lamp every 46 metres or so, on alternating sides of the street. */
const LIT_STREETS = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian']);
/** The Golden Gate Bridge and the western span of the Bay Bridge, for their lights. */
const BRIDGES: { colour: string; every: number; line: LngLat[] }[] = [
  { colour: '#ffb070', every: 55, line: [[-122.4752, 37.8079], [-122.4777, 37.8136], [-122.4791, 37.8249], [-122.4804, 37.8322]] },
  { colour: '#f3f6ff', every: 38, line: [[-122.3884, 37.7873], [-122.3665, 37.8076]] },
];

function along(lineString: LngLat[], every: number, startAt = every / 2): { at: LngLat; heading: number; n: number }[] {
  const out: { at: LngLat; heading: number; n: number }[] = [];
  const rad = Math.PI / 180;
  let carry = every - startAt;
  let n = 0;
  for (let i = 1; i < lineString.length; i++) {
    const a = lineString[i - 1];
    const b = lineString[i];
    const kx = 111320 * Math.cos(a[1] * rad);
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * 111320;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    let d = every - carry;
    while (d <= len) {
      out.push({ at: [a[0] + (dx * (d / len)) / kx, a[1] + (dy * (d / len)) / 111320], heading: Math.atan2(dx, dy) / rad, n: n++ });
      d += every;
    }
    carry = (carry + len) % every;
  }
  return out;
}

/** Street lamps and bridge lights. They only show at night. */
export function installLights(map: maplibregl.Map, streets: { kind: string; coords: LngLat[] }[]) {
  if (map.getSource('bs-lamps')) return;
  const rad = Math.PI / 180;
  const lamps: Feature[] = [];
  for (const s of streets) {
    if (!LIT_STREETS.has(s.kind)) continue;
    for (const p of along(s.coords, 46)) {
      const side = p.n % 2 ? 1 : -1;
      const kx = 111320 * Math.cos(p.at[1] * rad);
      lamps.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [p.at[0] + (Math.cos(p.heading * rad) * 5.5 * side) / kx, p.at[1] - (Math.sin(p.heading * rad) * 5.5 * side) / 111320] },
      });
    }
  }
  const bridge: Feature[] = BRIDGES.flatMap((b) => along(b.line, b.every).map((p): Feature => ({ type: 'Feature', properties: { c: b.colour }, geometry: { type: 'Point', coordinates: p.at } })));
  const under = map.getLayer('bs-buildings-far') ? 'bs-buildings-far' : map.getLayer('duel') ? 'duel' : undefined;
  const metres = (m: number) => ['interpolate', ['exponential', 2], ['zoom'], 13, m * 0.1325, 20, m * 16.95];
  map.addSource('bs-lamps', { type: 'geojson', data: { type: 'FeatureCollection', features: lamps } });
  map.addSource('bs-bridge-lights', { type: 'geojson', data: { type: 'FeatureCollection', features: bridge } });
  map.addLayer(
    {
      id: 'bs-lamp-pools',
      type: 'circle',
      source: 'bs-lamps',
      minzoom: 14,
      layout: { visibility: 'none' },
      paint: { 'circle-pitch-alignment': 'map', 'circle-pitch-scale': 'map', 'circle-radius': metres(9) as never, 'circle-color': '#ffc270', 'circle-blur': 1, 'circle-opacity': 0.5 },
    },
    under,
  );
  map.addLayer(
    {
      id: 'bs-lamp-heads',
      type: 'circle',
      source: 'bs-lamps',
      minzoom: 13,
      layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 0.7, 16, 1.3, 19, 3], 'circle-color': '#fff2cf', 'circle-blur': 0.3 },
    },
    under,
  );
  map.addLayer(
    {
      id: 'bs-bridge-lights',
      type: 'circle',
      source: 'bs-bridge-lights',
      layout: { visibility: 'none' },
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1, 15, 2.2, 18, 4], 'circle-color': ['get', 'c'], 'circle-blur': 0.4 },
    },
    under,
  );
}

const NIGHT_LAYERS = ['bs-lamp-pools', 'bs-lamp-heads', 'bs-bridge-lights', 'bs-car-beams', 'bs-car-lamps'];
const SCENE_LAYERS = ['bs-cars', 'bs-car-tops', 'bs-buildings', 'bs-buildings-far', 'bs-roofs', 'bs-roofs-far', 'bs-centerline', 'bs-ground', 'bs-trees', 'bs-trunks'];
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
      else if (id.includes('motorway') || id.includes('trunk_primary')) out.push([id, 'line-color', '#4a4a48']);
      else if (id.includes('secondary_tertiary') || id.includes('link')) out.push([id, 'line-color', '#50504e']);
      else if (id.includes('service_track')) out.push([id, 'line-color', '#666563']);
      else out.push([id, 'line-color', '#5a5957']);
    } else if (layer.type === 'line' && sl === 'park') out.push([id, 'line-color', '#6f9a5a']);
  }
  return out;
}

/** The base map's own colours, remembered so the flat map can have them back. */
const originals = new WeakMap<maplibregl.Map, [string, string, unknown][]>();

function paintGround(map: maplibregl.Map, real: boolean, night: boolean) {
  const wanted = realGround(map);
  if (!originals.has(map)) originals.set(map, wanted.map(([id, prop]) => [id, prop, map.getPaintProperty(id, prop as never)]));
  // By night the same ground, sunk most of the way into dark blue; the water goes darkest.
  const shown = night ? wanted.map(([id, prop, value]): [string, string, unknown] => [id, prop, value === '#5f9cc0' ? '#0c1830' : mix(value as string, NIGHT_INK, 0.72)]) : wanted;
  for (const [id, prop, value] of real ? shown : originals.get(map)!) {
    try {
      map.setPaintProperty(id, prop as never, value as never);
    } catch {
      /* a layer this base map does not have */
    }
  }
}

export function setSceneMode(map: maplibregl.Map, on: boolean, scores = false, night = false) {
  dressBaseMap(map);
  // White roads belong on a map, not in a view of the city, so 3D repaints the ground.
  paintGround(map, on, night);
  const dark = on && night;
  const paint = (id: string, prop: string, value: unknown) => {
    try {
      if (map.getLayer(id)) map.setPaintProperty(id, prop as never, value as never);
    } catch {
      /* decoration */
    }
  };
  // Night swaps every building onto its lamplit skin and brings out the lights.
  paint('bs-buildings', 'fill-extrusion-pattern', wallSkin(dark));
  paint('bs-buildings-far', 'fill-extrusion-color', wallFlat(dark));
  paint('bs-roofs', 'fill-extrusion-pattern', roofSkinName(dark));
  paint('bs-roofs-far', 'fill-extrusion-color', roofFlat(dark));
  paint('bs-ground', 'fill-extrusion-color', dark ? '#3b3026' : '#6f6a64');
  paint('bs-trunks', 'fill-extrusion-color', dark ? '#1c1612' : '#6b4a32');
  paint('bs-trees', 'fill-extrusion-color', ['match', ['get', 'v'], ...(dark ? [0, '#142a22', 1, '#18301f', 2, '#10241d', '#1c3323'] : [0, '#3f8a4c', 1, '#56a25a', 2, '#2f7446', '#7ab567'])]);
  paint('bs-centerline', 'line-color', dark ? '#6b5a2a' : '#d8b648');
  paint('bs-relief', 'hillshade-highlight-color', dark ? '#1a2444' : '#fff6e0');
  paint('bs-relief', 'hillshade-shadow-color', dark ? '#04060d' : '#3b4a5a');
  paint('bs-relief', 'hillshade-accent-color', dark ? '#0b1022' : '#5a6b5a');
  for (const id of NIGHT_LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', dark ? 'visible' : 'none');
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

/** Sky colours for the sun's height: night, a warm band around sunrise and sunset, then day. */
export function skyColors(sun: Sun): { sky: string; horizon: string; fog: string; phase: 'night' | 'golden' | 'day' } {
  const grey = sun.cloud / 100;
  if (sun.altitude < -6) return { sky: '#060b1f', horizon: '#18233f', fog: '#0f1730', phase: 'night' };
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
      // The night skins carry their own darkness and lamplight, so night light is even and white.
      color: c.phase === 'night' ? '#ffffff' : c.phase === 'golden' ? '#ffd2a1' : '#fff6e6',
      intensity: c.phase === 'night' ? 0.12 : 0.35 + 0.3 * (1 - sun.cloud / 100),
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
