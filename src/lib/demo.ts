import { bearing, lineLength } from './geo';
import type { Block, LngLat } from './types';

/** Small deterministic random generator so the demo grid is the same every run. */
function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A made-up street grid for trying the app without map data. The streets and
 * scores are invented; they do not describe real San Francisco blocks.
 */
export function demoBlocks(n = 14): Block[] {
  const rnd = mulberry(7);
  const origin: LngLat = [-122.4265, 37.7935];
  const dLng = 0.00125; // about 110 m
  const dLat = 0.00099;
  const node = (i: number, j: number) => `d${i}_${j}`;
  const at = (i: number, j: number): LngLat => [origin[0] + i * dLng, origin[1] + j * dLat];
  // One hill in the middle of the grid.
  const elev = (i: number, j: number) => 90 * Math.exp(-((i - n / 2) ** 2 + (j - n / 2) ** 2) / 18);
  // Each street has its own character, with some block-to-block noise.
  const ewChar = Array.from({ length: n + 1 }, () => [rnd(), rnd(), rnd(), rnd()]);
  const nsChar = Array.from({ length: n + 1 }, () => [rnd(), rnd(), rnd(), rnd()]);
  const blocks: Block[] = [];
  const make = (id: string, name: string, a: [number, number], b: [number, number], ch: number[], busy: boolean) => {
    const coords = [at(...a), at(...b)];
    const len = lineLength(coords);
    const ea = elev(...a);
    const eb = elev(...b);
    const j = () => (rnd() - 0.5) * 0.3;
    const c = (x: number) => Math.max(0, Math.min(1, x));
    const lg = c(ch[1] + j());
    const le = c(ch[3] + j());
    const rg = c(ch[1] + j());
    const re = c(ch[3] + j());
    blocks.push({
      id,
      name,
      highway: busy ? 'secondary' : 'residential',
      coords,
      len,
      bearing: bearing(coords[0], coords[1]),
      a: node(...a),
      b: node(...b),
      elev: (ea + eb) / 2,
      grade: (eb - ea) / len,
      prior: {
        views: c(((ea + eb) / 180) ** 1.5 + j() * 0.3),
        green: (lg + rg) / 2,
        arch: c(ch[2] + j()),
        energy: (le + re) / 2,
        traffic: busy ? 0.7 : 0.1,
        L: { green: lg, energy: le },
        R: { green: rg, energy: re },
      },
    });
  };
  for (let j = 0; j <= n; j++)
    for (let i = 0; i < n; i++) make(`ew${j}-${i}`, `Demo Street ${j + 1}`, [i, j], [i + 1, j], ewChar[j], j % 5 === 2);
  for (let i = 0; i <= n; i++)
    for (let j = 0; j < n; j++) make(`ns${i}-${j}`, `Demo Avenue ${i + 1}`, [i, j], [i, j + 1], nsChar[i], i % 6 === 3);
  return blocks;
}
