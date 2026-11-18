import { cardinal } from './geo';
import { buildGraph, nearestNode, planLoop, type Graph, type Traversal } from './router';
import { contextPenalty, contextWeights, finalScore, sideNormal, sideScore } from './scoring';
import type { Block, Community, LngLat, Route, RouteLeg, RouteStep, Side, WalkContext, Weights } from './types';

const PACE_M_PER_MIN = 78; // about 4.7 km/h on the flat
const CROSSING_COST = 0.2;
/** Stairs and paths have no sidewalks to choose between. */
const UNSIDED = new Set(['steps', 'footway', 'path', 'pedestrian']);
/** Stretches shorter than this are folded into the step before them. */
const MIN_STEP_M = 30;

const flip = (s: Side): Side => (s === 'L' ? 'R' : 'L');

/**
 * Choose a side of the street for every block of the route. Each block has a
 * score per side; changing sides costs a little, because crossing mid-walk for
 * a marginal gain is annoying. Solved exactly with a two-state Viterbi pass.
 */
export function chooseSides(
  path: Traversal[],
  w: Weights,
  ctx: WalkContext,
  community: Map<string, Community>,
): { side: Side; reason: string }[] {
  if (!path.length) return [];
  const sides: Side[] = ['L', 'R'];
  // Gain for walking on travel-side s of block i.
  // A long block is worth crossing for; a 10 m stub is not, so gains scale with length.
  const gains = path.map((t) =>
    sides.map((s) => {
      if (UNSIDED.has(t.block.highway)) return { score: 0, reason: '' };
      const g = sideScore(t.block, t.forward ? s : flip(s), w, ctx, community.get(t.block.id));
      return { score: g.score * Math.min(1.5, t.block.len / 100), reason: g.reason };
    }),
  );
  const best: number[][] = [gains[0].map((g) => g.score)];
  const from: number[][] = [[0, 1]];
  for (let i = 1; i < path.length; i++) {
    best.push([0, 0]);
    from.push([0, 0]);
    for (let s = 0; s < 2; s++) {
      const stay = best[i - 1][s];
      const cross = best[i - 1][1 - s] - CROSSING_COST;
      from[i][s] = stay >= cross ? s : 1 - s;
      best[i][s] = Math.max(stay, cross) + gains[i][s].score;
    }
  }
  const out: { side: Side; reason: string }[] = new Array(path.length);
  let s = best[path.length - 1][0] >= best[path.length - 1][1] ? 0 : 1;
  for (let i = path.length - 1; i >= 0; i--) {
    out[i] = { side: sides[s], reason: gains[i][s].reason };
    s = from[i][s];
  }
  return out;
}

export interface PlanInput {
  blocks: Block[];
  graph?: Graph;
  community: Map<string, Community>;
  start: LngLat;
  minutes: number;
  weights: Weights;
  ctx: WalkContext;
}

export function designWalk(input: PlanInput): Route | null {
  const { community, ctx } = input;
  const graph = input.graph ?? buildGraph(input.blocks);
  const start = nearestNode(graph, input.start);
  if (!start) return null;

  const w = contextWeights(input.weights, ctx);
  const cache = new Map<string, number>();
  const score = (b: Block) => {
    let s = cache.get(b.id);
    if (s === undefined) {
      s = Math.max(0, finalScore(b, w, community.get(b.id)) - contextPenalty(b, ctx));
      cache.set(b.id, s);
    }
    return s;
  };

  // Hills add time, so plan once, see how long the loop really takes, and
  // re-plan with the distance scaled to hit the requested minutes.
  const timeOf = (path: Traversal[]) => {
    let len = 0;
    let climb = 0;
    for (const t of path) {
      len += t.block.len;
      const rise = (t.forward ? t.block.grade : -t.block.grade) * t.block.len;
      if (rise > 0) climb += rise;
    }
    return len / PACE_M_PER_MIN + climb / 10;
  };
  let targetM = input.minutes * PACE_M_PER_MIN;
  let loop = planLoop(graph, start, targetM, score);
  // If the streets around the start cannot hold a loop this long, offer the
  // longest one that fits rather than nothing.
  for (let i = 0; !loop && i < 4; i++) {
    targetM *= 0.8;
    loop = planLoop(graph, start, targetM, score);
  }
  if (!loop) return null;
  const wanted = Math.min(input.minutes, (targetM / PACE_M_PER_MIN) * 1.05);
  for (let i = 0; i < 2; i++) {
    const ratio = wanted / timeOf(loop.path);
    if (Math.abs(ratio - 1) < 0.08) break;
    targetM *= ratio;
    const retry = planLoop(graph, start, targetM, score);
    if (!retry) break;
    if (Math.abs(timeOf(retry.path) - wanted) < Math.abs(timeOf(loop.path) - wanted)) loop = retry;
  }

  const sides = chooseSides(loop.path, w, ctx, community);
  let climbM = 0;
  const legs: RouteLeg[] = loop.path.map((t, i) => {
    const rise = (t.forward ? t.block.grade : -t.block.grade) * t.block.len;
    if (rise > 0) climbM += rise;
    const blockSide = t.forward ? sides[i].side : flip(sides[i].side);
    return {
      blockId: t.block.id,
      name: t.block.name,
      coords: t.forward ? t.block.coords : [...t.block.coords].reverse(),
      len: t.block.len,
      side: sides[i].side,
      sideLabel: UNSIDED.has(t.block.highway) ? '' : cardinal(sideNormal(t.block, blockSide)),
      reason: sides[i].reason,
      score: score(t.block),
      forward: t.forward,
      step: 0,
    };
  });

  // Turn-by-turn steps: consecutive blocks on the same street and side become
  // one step, and stubs too short to be worth an instruction join the previous one.
  const steps: RouteStep[] = [];
  loop.path.forEach((t, i) => {
    const leg = legs[i];
    const last = steps[steps.length - 1];
    const sameStreet = last && last.name === leg.name && (last.side === leg.side || !leg.sideLabel);
    if (last && (sameStreet || leg.len < MIN_STEP_M)) {
      last.len += leg.len;
      leg.step = steps.length - 1;
      return;
    }
    leg.step = steps.length;
    const travel = (t.block.bearing + (t.forward ? 0 : 180)) % 360;
    steps.push({
      name: leg.name,
      side: leg.side,
      sideLabel: leg.sideLabel,
      reason: leg.reason,
      len: leg.len,
      heading: cardinal(travel),
    });
  });

  // Climbing slows you down: add roughly a minute per 10 m of ascent.
  const minutes = loop.lengthM / PACE_M_PER_MIN + climbM / 10;
  return {
    legs,
    steps,
    lengthM: loop.lengthM,
    minutes,
    climbM,
    meanScore: loop.meanScore,
    repeatFrac: loop.repeatFrac,
  };
}
