import type { LngLat } from './types';

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Compass bearing from a to b, degrees clockwise from north. */
export function bearing(a: LngLat, b: LngLat): number {
  const y = Math.sin(rad(b[0] - a[0])) * Math.cos(rad(b[1]));
  const x =
    Math.cos(rad(a[1])) * Math.sin(rad(b[1])) -
    Math.sin(rad(a[1])) * Math.cos(rad(b[1])) * Math.cos(rad(b[0] - a[0]));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function lineLength(coords: LngLat[]): number {
  let t = 0;
  for (let i = 1; i < coords.length; i++) t += haversine(coords[i - 1], coords[i]);
  return t;
}

/** Local flat projection in metres around an origin; fine at neighbourhood scale. */
export function toXY(p: LngLat, origin: LngLat): [number, number] {
  return [rad(p[0] - origin[0]) * R * Math.cos(rad(origin[1])), rad(p[1] - origin[1]) * R];
}

/**
 * Distance from p to segment ab in metres, and which side of a->b it falls on.
 * cross > 0 means p is to the left of the direction of travel.
 */
export function pointToSegment(p: LngLat, a: LngLat, b: LngLat): { dist: number; cross: number } {
  const [bx, by] = toXY(b, a);
  const [px, py] = toXY(p, a);
  const l2 = bx * bx + by * by;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / l2));
  const dx = px - t * bx;
  const dy = py - t * by;
  return { dist: Math.hypot(dx, dy), cross: bx * py - by * px };
}

const CARDINALS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export function cardinal(bearingDeg: number): string {
  return CARDINALS[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
}

/** Smallest absolute difference between two bearings, 0..180. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
