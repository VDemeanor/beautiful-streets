import type { LngLat } from '@/lib/types';

/**
 * Ground height anywhere on the street network, in metres above sea level.
 * Each block knows its mean height and its slope, so the height at a point is
 * read off the nearest block. A street-level camera needs this to the metre:
 * a block-wide average would bury it on San Francisco's hills.
 */

export interface Sloped {
  coords: LngLat[];
  len: number;
  elev: number | null;
  /** Signed rise over run from the first point to the last. */
  grade: number;
}

const CELL = 0.002;
const RAD = Math.PI / 180;

export function makeGround(blocks: Sloped[], fallback = 60): (at: LngLat) => number {
  const grid = new Map<string, Sloped[]>();
  const cell = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  for (const b of blocks) {
    if (b.elev == null || b.coords.length < 2) continue;
    const seen = new Set<string>();
    for (const c of b.coords) {
      const k = cell(c[0], c[1]);
      if (seen.has(k)) continue;
      seen.add(k);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(b);
    }
  }
  let last = fallback;
  return (at) => {
    const kx = 111320 * Math.cos(at[1] * RAD);
    let best = Infinity;
    let height = last;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const list = grid.get(cell(at[0] + dx * CELL, at[1] + dy * CELL));
        if (!list) continue;
        for (const b of list) {
          let along = 0;
          for (let i = 1; i < b.coords.length; i++) {
            const ax = (b.coords[i - 1][0] - at[0]) * kx;
            const ay = (b.coords[i - 1][1] - at[1]) * 111320;
            const bx = (b.coords[i][0] - at[0]) * kx;
            const by = (b.coords[i][1] - at[1]) * 111320;
            const sx = bx - ax;
            const sy = by - ay;
            const seg = Math.hypot(sx, sy);
            const t = seg ? Math.max(0, Math.min(1, -(ax * sx + ay * sy) / (seg * seg))) : 0;
            const d = Math.hypot(ax + sx * t, ay + sy * t);
            if (d < best) {
              best = d;
              height = (b.elev as number) + b.grade * (along + seg * t - b.len / 2);
            }
            along += seg;
          }
        }
      }
    last = height;
    return height;
  };
}
