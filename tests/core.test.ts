import { describe, expect, it } from 'vitest';
import { buildContext } from '@/lib/context';
import { demoBlocks } from '@/lib/demo';
import { bearing, cardinal, haversine, pointToSegment } from '@/lib/geo';
import { buildBlocks, type OsmElement } from '@/lib/osm';
import { chooseSides, designWalk } from '@/lib/planner';
import { buildGraph, largestComponent, planLoop } from '@/lib/router';
import { communityScore, finalScore, isSunny, priorScore, sideScore } from '@/lib/scoring';
import { DEFAULT_WEIGHTS, type Block, type Community, type WalkContext } from '@/lib/types';

const ctx = (over: Partial<WalkContext> = {}): WalkContext => ({
  when: '2026-11-18T20:00:00Z',
  weather: null,
  sunAzimuth: 180,
  sunAltitude: 30,
  goldenHour: false,
  night: false,
  raining: false,
  windy: false,
  sunPref: 'none',
  busyHour: true,
  notes: [],
  ...over,
});

describe('geometry', () => {
  it('measures distance and bearing', () => {
    expect(haversine([-122.42, 37.8], [-122.42, 37.801])).toBeCloseTo(111.2, 0);
    expect(bearing([-122.42, 37.8], [-122.42, 37.81])).toBeCloseTo(0, 3);
    expect(bearing([-122.42, 37.8], [-122.41, 37.8])).toBeCloseTo(90, 1);
    expect(cardinal(271)).toBe('west');
  });
  it('knows left from right', () => {
    // Heading north; a point to the west is on the left.
    const west = pointToSegment([-122.4201, 37.8005], [-122.42, 37.8], [-122.42, 37.801]);
    const east = pointToSegment([-122.4199, 37.8005], [-122.42, 37.8], [-122.42, 37.801]);
    expect(west.cross).toBeGreaterThan(0);
    expect(east.cross).toBeLessThan(0);
    expect(west.dist).toBeCloseTo(8.8, 0);
  });
});

describe('OpenStreetMap import', () => {
  const node = (id: number, lon: number, lat: number, tags?: Record<string, string>): OsmElement => ({ type: 'node', id, lon, lat, tags });
  const way = (id: number, nodes: [number, number, number][], tags: Record<string, string>): OsmElement => ({
    type: 'way',
    id,
    nodes: nodes.map((n) => n[0]),
    geometry: nodes.map((n) => ({ lon: n[1], lat: n[2] })),
    tags,
  });
  // Main St runs north through nodes 1,2,3; Cross St meets it at node 2.
  const elements: OsmElement[] = [
    way(10, [[1, -122.42, 37.8], [2, -122.42, 37.801], [3, -122.42, 37.802]], { highway: 'residential', name: 'Main St' }),
    way(11, [[4, -122.421, 37.801], [2, -122.42, 37.801]], { highway: 'residential', name: 'Cross St' }),
    way(12, [[5, -122.43, 37.8], [6, -122.43, 37.801]], { highway: 'footway', footway: 'sidewalk' }),
    node(100, -122.42008, 37.8004, { natural: 'tree' }),
    node(101, -122.42008, 37.8006, { natural: 'tree' }),
    node(102, -122.41992, 37.8015, { shop: 'bakery' }),
  ];
  const blocks = buildBlocks(elements);

  it('cuts ways at intersections and drops sidewalks', () => {
    expect(blocks.map((b) => b.id).sort()).toEqual(['10-0', '10-1', '11-0']);
    const first = blocks.find((b) => b.id === '10-0')!;
    expect(first.a).toBe('1');
    expect(first.b).toBe('2');
    expect(first.len).toBeCloseTo(111.2, 0);
  });
  it('credits trees and shops to the right block and side', () => {
    const south = blocks.find((b) => b.id === '10-0')!;
    const north = blocks.find((b) => b.id === '10-1')!;
    expect(south.prior.L.green).toBeGreaterThan(0);
    expect(south.prior.R.green).toBe(0);
    expect(north.prior.R.energy).toBeGreaterThan(0);
    expect(north.prior.L.energy).toBe(0);
    expect(north.prior.green).toBe(0);
  });
});

describe('scoring', () => {
  const block = demoBlocks()[0];
  it('moves toward the community as votes accumulate', () => {
    const prior = priorScore(block, DEFAULT_WEIGHTS);
    const few: Community = { rate: { sum: 2, n: 2 } };
    const many: Community = { rate: { sum: 40, n: 40 } };
    expect(finalScore(block, DEFAULT_WEIGHTS)).toBe(prior);
    expect(finalScore(block, DEFAULT_WEIGHTS, few)).toBeGreaterThan(prior);
    expect(finalScore(block, DEFAULT_WEIGHTS, many)).toBeGreaterThan(finalScore(block, DEFAULT_WEIGHTS, few));
    expect(finalScore(block, DEFAULT_WEIGHTS, many)).toBeLessThanOrEqual(1);
  });
  it('blends matchups, stars and thumbs', () => {
    expect(communityScore({})).toBeNull();
    const c = communityScore({ elo: { rating: 1700, n: 10 }, thumbs: { up: 0, down: 6 } })!;
    expect(c.score).toBeGreaterThan(0.1);
    expect(c.score).toBeLessThan(0.76);
  });
  it('puts the sun on the correct sidewalk', () => {
    // An east-west street (a -> b heads east). Sun in the south.
    const ew: Block = { ...block, bearing: 90 };
    const c = ctx({ sunAzimuth: 180, sunAltitude: 30 });
    // Left of eastbound travel is the north sidewalk: lit. South sidewalk: shaded by its own buildings.
    expect(isSunny(ew, 'L', c)).toBe(true);
    expect(isSunny(ew, 'R', c)).toBe(false);
    expect(isSunny(ew, 'R', ctx({ sunAltitude: 70 }))).toBe(true);
    expect(isSunny(ew, 'L', ctx({ sunAltitude: -2 }))).toBe(false);
    const flat: Block = { ...ew, prior: { ...ew.prior, L: { green: 0, energy: 0 }, R: { green: 0, energy: 0 } } };
    expect(sideScore(flat, 'L', DEFAULT_WEIGHTS, ctx({ sunPref: 'sun' })).reason).toBe('sunny side');
    expect(sideScore(flat, 'R', DEFAULT_WEIGHTS, ctx({ sunPref: 'shade' })).reason).toBe('shady side');
  });
  it('lets walkers overrule the map on sides', () => {
    const flat: Block = { ...block, prior: { ...block.prior, L: { green: 0.2, energy: 0 }, R: { green: 0, energy: 0 } } };
    const votes: Community = { R: { sum: 9, n: 9 }, L: { sum: 0, n: 9 } };
    expect(sideScore(flat, 'R', DEFAULT_WEIGHTS, ctx(), votes).score).toBeGreaterThan(
      sideScore(flat, 'L', DEFAULT_WEIGHTS, ctx(), votes).score,
    );
  });
});

describe('context', () => {
  it('computes San Francisco sun position and time-of-day flags', () => {
    // 2026-11-18 12:00 PST: sun roughly due south, low-ish.
    const noon = buildContext([-122.42, 37.8], new Date('2026-11-18T20:00:00Z'), null);
    expect(noon.sunAzimuth).toBeGreaterThan(165);
    expect(noon.sunAzimuth).toBeLessThan(195);
    expect(noon.sunAltitude).toBeGreaterThan(25);
    expect(noon.sunAltitude).toBeLessThan(40);
    expect(noon.night).toBe(false);
    // 22:00 PST is night.
    expect(buildContext([-122.42, 37.8], new Date('2026-11-19T06:00:00Z'), null).night).toBe(true);
    // About 4:30pm PST, shortly before a ~4:56pm sunset.
    expect(buildContext([-122.42, 37.8], new Date('2026-11-19T00:30:00Z'), null).goldenHour).toBe(true);
    const cold = buildContext([-122.42, 37.8], new Date('2026-11-18T20:00:00Z'), { tempC: 12, windKph: 35, precipMm: 0, precipProb: 10, cloudPct: 20 });
    expect(cold.sunPref).toBe('sun');
    expect(cold.windy).toBe(true);
  });
});

describe('route design', () => {
  const blocks = demoBlocks();
  const graph = buildGraph(blocks);
  const start = 'd7_7';

  it('keeps the network connected', () => {
    expect(largestComponent(blocks).length).toBe(blocks.length);
  });

  it('returns a closed loop of about the requested length', () => {
    const score = (b: Block) => priorScore(b, DEFAULT_WEIGHTS);
    for (const target of [1500, 3000, 5000]) {
      const loop = planLoop(graph, start, target, score)!;
      expect(loop).not.toBeNull();
      expect(Math.abs(loop.lengthM - target) / target).toBeLessThan(0.25);
      // Continuous, and ends where it began.
      let at = start;
      for (const t of loop.path) {
        expect(t.forward ? t.block.a : t.block.b).toBe(at);
        at = t.forward ? t.block.b : t.block.a;
      }
      expect(at).toBe(start);
      expect(loop.repeatFrac).toBeLessThan(0.2);
    }
  });

  it('beats the average street and follows votes', () => {
    const score = (b: Block) => priorScore(b, DEFAULT_WEIGHTS);
    const avg = blocks.reduce((s, b) => s + score(b), 0) / blocks.length;
    const loop = planLoop(graph, start, 3000, score)!;
    expect(loop.meanScore).toBeGreaterThan(avg + 0.05);

    // Heavily upvote one mediocre street near the start; the route should now use it.
    const target = 'Demo Street 10';
    const community = new Map<string, Community>();
    for (const b of blocks) if (b.name === target) community.set(b.id, { rate: { sum: 60, n: 60 } });
    const input = { blocks, graph, community: new Map<string, Community>(), start: graph.pos.get(start)!, minutes: 40, weights: DEFAULT_WEIGHTS, ctx: ctx() };
    const before = designWalk(input)!;
    const after = designWalk({ ...input, community })!;
    const share = (r: typeof before) => r.legs.filter((l) => l.name === target).reduce((s, l) => s + l.len, 0) / r.lengthM;
    expect(share(after)).toBeGreaterThan(share(before));
    expect(share(after)).toBeGreaterThan(0.1);
  });

  it('gives every leg a side and does not zigzag across the street', () => {
    const route = designWalk({ blocks, graph, community: new Map(), start: graph.pos.get(start)!, minutes: 45, weights: DEFAULT_WEIGHTS, ctx: ctx({ sunPref: 'sun' }) })!;
    expect(route.steps.length).toBeGreaterThan(2);
    for (const leg of route.legs) {
      expect(['L', 'R']).toContain(leg.side);
      expect(leg.sideLabel.length).toBeGreaterThan(3);
    }
    let switches = 0;
    for (let i = 1; i < route.legs.length; i++) if (route.legs[i].side !== route.legs[i - 1].side) switches++;
    expect(switches).toBeLessThan(route.legs.length / 2);
    expect(route.minutes).toBeGreaterThan(38);
    expect(route.minutes).toBeLessThan(52);
  });

  it('holds a side when the gain from crossing is small', () => {
    const b = { ...blocks[0], prior: { ...blocks[0].prior, L: { green: 0.5, energy: 0.5 }, R: { green: 0.5, energy: 0.5 } } };
    const sides = chooseSides([{ block: b, forward: true }, { block: b, forward: true }, { block: b, forward: true }], DEFAULT_WEIGHTS, ctx(), new Map());
    expect(new Set(sides.map((s) => s.side)).size).toBe(1);
  });
});

describe('walk preferences', () => {
  const blocks = demoBlocks();
  const graph = buildGraph(blocks);
  const base = { blocks, graph, community: new Map<string, Community>(), start: graph.pos.get('d2_2')!, minutes: 40, weights: DEFAULT_WEIGHTS, ctx: ctx() };
  const steepShare = (legs: { blockId: string; len: number }[]) => {
    const byId = new Map(blocks.map((b) => [b.id, b]));
    let steep = 0;
    let all = 0;
    for (const l of legs) {
      all += l.len;
      if (Math.abs(byId.get(l.blockId)!.grade) > 0.07) steep += l.len;
    }
    return steep / all;
  };
  it('routes around steep blocks when asked to avoid hills', () => {
    const normal = designWalk(base)!;
    const gentle = designWalk({ ...base, hills: 'avoid' })!;
    expect(steepShare(gentle.legs)).toBeLessThanOrEqual(steepShare(normal.legs));
    expect(gentle.climbM).toBeLessThanOrEqual(normal.climbM + 1);
  });
  it('climbs more when asked for hills', () => {
    const gentle = designWalk({ ...base, hills: 'avoid' })!;
    const climb = designWalk({ ...base, hills: 'seek' })!;
    expect(climb.climbM).toBeGreaterThanOrEqual(gentle.climbM);
  });
});
