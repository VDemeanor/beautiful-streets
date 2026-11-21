import * as maplibregl from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import type { LngLat, RouteLeg } from '@/lib/types';

/**
 * The walker: a small 3D person built from blocks, standing in the scene like
 * the buildings and cars do, facing the way they are walking, legs and arms
 * swinging in step. scripts/make-models.mjs builds the same figure as models
 * for the photographed city; keep the two in step.
 */

export interface Part {
  /** Metres to the walker's right, and forward. */
  x: number;
  z: number;
  /** Width across, depth front to back. */
  w: number;
  d: number;
  /** Bottom and top, metres above the ground. */
  y0: number;
  y1: number;
  colour: 'jacket' | 'trousers' | 'skin' | 'hair' | 'shoe' | 'pack';
}

/** The body at one moment of the stride. phase runs 0..2π over two steps. */
export function pose(phase: number): Part[] {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const bob = 0.03 * Math.abs(c);
  const parts: Part[] = [];
  for (const side of [-1, 1]) {
    const swing = s * side;
    // The foot coming forward lifts off the ground.
    const lift = Math.max(0, c * side) * 0.11;
    parts.push({ x: 0.11 * side, z: 0.3 * swing + 0.05, w: 0.17, d: 0.3, y0: lift, y1: lift + 0.09, colour: 'shoe' });
    parts.push({ x: 0.11 * side, z: 0.3 * swing, w: 0.17, d: 0.19, y0: lift + 0.09, y1: 0.5 + bob, colour: 'trousers' });
    parts.push({ x: 0.11 * side, z: 0.14 * swing, w: 0.18, d: 0.21, y0: 0.5 + bob, y1: 0.9 + bob, colour: 'trousers' });
    // Arms swing against the legs.
    parts.push({ x: 0.28 * side, z: -0.09 * swing, w: 0.11, d: 0.14, y0: 1.12 + bob, y1: 1.46 + bob, colour: 'jacket' });
    parts.push({ x: 0.28 * side, z: -0.24 * swing, w: 0.1, d: 0.13, y0: 0.86 + bob, y1: 1.12 + bob, colour: 'jacket' });
    parts.push({ x: 0.28 * side, z: -0.27 * swing, w: 0.09, d: 0.11, y0: 0.77 + bob, y1: 0.86 + bob, colour: 'skin' });
  }
  parts.push({ x: 0, z: 0.02, w: 0.44, d: 0.26, y0: 0.9 + bob, y1: 1.48 + bob, colour: 'jacket' });
  parts.push({ x: 0, z: -0.19, w: 0.3, d: 0.13, y0: 1.02 + bob, y1: 1.42 + bob, colour: 'pack' });
  parts.push({ x: 0, z: 0.02, w: 0.13, d: 0.13, y0: 1.48 + bob, y1: 1.54 + bob, colour: 'skin' });
  parts.push({ x: 0, z: 0.03, w: 0.21, d: 0.22, y0: 1.54 + bob, y1: 1.74 + bob, colour: 'skin' });
  parts.push({ x: 0, z: 0.0, w: 0.23, d: 0.24, y0: 1.72 + bob, y1: 1.8 + bob, colour: 'hair' });
  parts.push({ x: 0, z: -0.09, w: 0.23, d: 0.07, y0: 1.58 + bob, y1: 1.74 + bob, colour: 'hair' });
  return parts;
}

const COLOURS: Record<Part['colour'], string> = { jacket: '#e2542f', trousers: '#232c44', skin: '#e6b08a', hair: '#3b2a1d', shoe: '#f4f2ec', pack: '#1f5673' };
const RAD = Math.PI / 180;

/**
 * Draw the walker in the built-in scene, or remove them with null. `size`
 * scales the figure, so they can still be found when the camera is far away.
 */
export function drawWalker(map: maplibregl.Map, at: LngLat | null, heading = 0, size = 1, phase = 0) {
  const features: Feature[] = [];
  if (at) {
    const kx = 111320 * Math.cos(at[1] * RAD);
    const fx = Math.sin(heading * RAD);
    const fy = Math.cos(heading * RAD);
    for (const p of pose(phase)) {
      const corner = (across: number, along: number) => [
        at[0] + ((p.z + along) * size * fx + (p.x + across) * size * fy) / kx,
        at[1] + ((p.z + along) * size * fy - (p.x + across) * size * fx) / 111320,
      ];
      const w = p.w / 2;
      const d = p.d / 2;
      features.push({
        type: 'Feature',
        properties: { c: COLOURS[p.colour], b: p.y0 * size, h: p.y1 * size },
        geometry: { type: 'Polygon', coordinates: [[corner(-w, d), corner(w, d), corner(w, -d), corner(-w, -d), corner(-w, d)]] },
      });
    }
  }
  const data: FeatureCollection = { type: 'FeatureCollection', features };
  const source = map.getSource('bs-walker') as maplibregl.GeoJSONSource | undefined;
  if (source) {
    source.setData(data);
    return;
  }
  if (!at) return;
  map.addSource('bs-walker', { type: 'geojson', data });
  map.addLayer(
    {
      id: 'bs-walker',
      type: 'fill-extrusion',
      source: 'bs-walker',
      paint: { 'fill-extrusion-color': ['get', 'c'], 'fill-extrusion-base': ['get', 'b'], 'fill-extrusion-height': ['get', 'h'], 'fill-extrusion-vertical-gradient': false },
    },
    map.getLayer('duel') ? 'duel' : undefined,
  );
}

/** Metres from the middle of the street to where a person walks, by kind of street. */
const KERB: Record<string, number> = { primary: 6.5, secondary: 6, tertiary: 5, residential: 4, unclassified: 4, living_street: 2 };

/**
 * The walk as it is really walked: each stretch moved over to the side of the
 * street the plan chose. The path, the walker and the camera all follow this,
 * so they line up with each other and with the pavement.
 */
export function sideLegs(legs: RouteLeg[], kindOf: (blockId: string) => string | undefined): RouteLeg[] {
  return legs.map((leg) => {
    const reach = leg.sideLabel ? KERB[kindOf(leg.blockId) ?? ''] ?? 0 : 0;
    if (!reach || leg.coords.length < 2) return leg;
    const sign = leg.side === 'R' ? 1 : -1;
    const kx = 111320 * Math.cos(leg.coords[0][1] * RAD);
    const coords = leg.coords.map((c, i): LngLat => {
      // The direction of travel through this point, averaged over the segments either side.
      const a = leg.coords[Math.max(0, i - 1)];
      const b = leg.coords[Math.min(leg.coords.length - 1, i + 1)];
      const dx = (b[0] - a[0]) * kx;
      const dy = (b[1] - a[1]) * 111320;
      const len = Math.hypot(dx, dy) || 1;
      // To the right of travel is (dy, -dx).
      return [c[0] + ((dy / len) * reach * sign) / kx, c[1] + ((-dx / len) * reach * sign) / 111320];
    });
    return { ...leg, coords };
  });
}
