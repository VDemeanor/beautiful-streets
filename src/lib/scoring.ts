import { angleDiff, clamp01 } from './geo';
import { DIMS, type Block, type Community, type Side, type WalkContext, type Weights } from './types';

/** How many votes it takes for the community to count as much as the map data. */
const PRIOR_STRENGTH = 4;

export function priorScore(block: Block, w: Weights): number {
  let total = 0;
  let sum = 0;
  for (const d of DIMS) {
    total += w[d];
    sum += w[d] * block.prior[d];
  }
  const base = total > 0 ? sum / total : 0;
  return clamp01(base - 0.25 * block.prior.traffic);
}

export const eloToScore = (rating: number) => 1 / (1 + 10 ** ((1500 - rating) / 400));

/** Blend matchup wins, star ratings and thumbs into one 0..1 score plus its weight. */
export function communityScore(c: Community | undefined): { score: number; n: number } | null {
  if (!c) return null;
  let n = 0;
  let sum = 0;
  if (c.elo && c.elo.n > 0) {
    const w = c.elo.n * 0.5;
    sum += eloToScore(c.elo.rating) * w;
    n += w;
  }
  if (c.rate && c.rate.n > 0) {
    sum += c.rate.sum;
    n += c.rate.n;
  }
  if (c.thumbs && c.thumbs.up + c.thumbs.down > 0) {
    const votes = c.thumbs.up + c.thumbs.down;
    const w = votes * 0.7;
    sum += ((c.thumbs.up + 1) / (votes + 2)) * w;
    n += w;
  }
  return n > 0 ? { score: sum / n, n } : null;
}

/** Map-data prior pulled toward what people say, more strongly the more they say it. */
export function finalScore(block: Block, w: Weights, c?: Community): number {
  const prior = priorScore(block, w);
  const comm = communityScore(c);
  if (!comm) return prior;
  return (PRIOR_STRENGTH * prior + comm.n * comm.score) / (PRIOR_STRENGTH + comm.n);
}

/** Compass bearing of the outward normal for a side of the block (a -> b). */
export function sideNormal(block: Block, side: Side): number {
  return (block.bearing + (side === 'L' ? 270 : 90)) % 360;
}

/**
 * Is this sidewalk in the sun? Buildings on the sun's side of the street shade
 * their own sidewalk, so the lit sidewalk is the one facing the sun from across
 * the street: its outward normal points away from the sun.
 */
export function isSunny(block: Block, side: Side, ctx: WalkContext): boolean {
  if (ctx.sunAltitude <= 5) return false;
  if (ctx.weather && ctx.weather.cloudPct > 85) return false;
  if (ctx.sunAltitude > 55) return true;
  return angleDiff(sideNormal(block, side), ctx.sunAzimuth) > 105;
}

export interface SideChoice {
  score: number;
  reason: string;
}

/** Score one side of a block for this walk, with the main reason it scored that way. */
export function sideScore(block: Block, side: Side, w: Weights, ctx: WalkContext, c?: Community): SideChoice {
  const p = block.prior[side];
  const other = block.prior[side === 'L' ? 'R' : 'L'];
  const parts: [number, string][] = [];

  const wsum = w.green + w.energy || 1;
  parts.push([(0.5 * w.green * (p.green - other.green)) / wsum, 'more trees']);
  parts.push([(0.5 * w.energy * (p.energy - other.energy)) / wsum, 'shopfronts and cafes']);

  const tally = c?.[side];
  const otherTally = c?.[side === 'L' ? 'R' : 'L'];
  const mean = (t?: { sum: number; n: number }) => (t && t.n > 0 ? (t.sum / t.n - 0.5) * (t.n / (t.n + 2)) : 0);
  parts.push([mean(tally) - mean(otherTally), 'walkers prefer it']);

  if (ctx.sunPref !== 'none') {
    const sunny = isSunny(block, side, ctx);
    const otherSunny = isSunny(block, side === 'L' ? 'R' : 'L', ctx);
    if (sunny !== otherSunny) {
      const wantsThis = ctx.sunPref === 'sun' ? sunny : !sunny;
      parts.push([wantsThis ? 0.25 : -0.25, ctx.sunPref === 'sun' ? 'sunny side' : 'shady side']);
    }
  }

  let score = 0;
  let best: [number, string] = [0.02, 'either side works'];
  for (const part of parts) {
    score += part[0];
    if (part[0] > best[0]) best = part;
  }
  return { score, reason: best[1] };
}

/** Per-walk adjustments: weather, light and time of day change which streets shine. */
export function contextWeights(w: Weights, ctx: WalkContext): Weights {
  const out = { ...w };
  if (ctx.goldenHour) out.views *= 1.5;
  if (ctx.windy) out.views *= 0.7;
  if (ctx.night) {
    out.energy *= 1.5;
    out.green *= 0.6;
    out.views *= 0.8;
  }
  if (ctx.raining) out.energy *= 1.2;
  out.energy *= ctx.busyHour ? 1.2 : 0.8;
  return out;
}

/** Penalty in score units for blocks that suit this walk badly. */
export function contextPenalty(block: Block, ctx: WalkContext): number {
  const offStreet = block.highway === 'steps' || block.highway === 'path' || block.highway === 'footway';
  let p = 0;
  if (ctx.night && offStreet) p += 0.25;
  if (ctx.raining && block.highway === 'steps') p += 0.3;
  return p;
}
