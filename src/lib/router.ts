import { angleDiff, bearing, haversine } from './geo';
import type { Block, LngLat } from './types';

export interface Edge {
  to: string;
  block: Block;
  /** True when travelling a -> b. */
  forward: boolean;
}

export interface Graph {
  adj: Map<string, Edge[]>;
  pos: Map<string, LngLat>;
}

export interface Traversal {
  block: Block;
  forward: boolean;
}

export function buildGraph(blocks: Block[]): Graph {
  const adj = new Map<string, Edge[]>();
  const pos = new Map<string, LngLat>();
  const add = (from: string, e: Edge) => {
    const list = adj.get(from);
    if (list) list.push(e);
    else adj.set(from, [e]);
  };
  for (const block of blocks) {
    pos.set(block.a, block.coords[0]);
    pos.set(block.b, block.coords[block.coords.length - 1]);
    add(block.a, { to: block.b, block, forward: true });
    add(block.b, { to: block.a, block, forward: false });
  }
  return { adj, pos };
}

/** Keep only the biggest connected piece, so every start point can reach every other. */
export function largestComponent(blocks: Block[]): Block[] {
  const g = buildGraph(blocks);
  const seen = new Map<string, number>();
  const sizes: number[] = [];
  for (const start of g.adj.keys()) {
    if (seen.has(start)) continue;
    const id = sizes.length;
    let size = 0;
    const stack = [start];
    seen.set(start, id);
    while (stack.length) {
      const n = stack.pop()!;
      size++;
      for (const e of g.adj.get(n) ?? [])
        if (!seen.has(e.to)) {
          seen.set(e.to, id);
          stack.push(e.to);
        }
    }
    sizes.push(size);
  }
  const best = sizes.indexOf(Math.max(...sizes));
  return blocks.filter((b) => seen.get(b.a) === best);
}

export function nearestNode(g: Graph, pt: LngLat): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const [id, p] of g.pos) {
    const d = haversine(pt, p);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

class Heap {
  private items: [number, string][] = [];
  get size() {
    return this.items.length;
  }
  push(item: [number, string]) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, string] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

interface Tree {
  cost: Map<string, number>;
  len: Map<string, number>;
  prev: Map<string, { from: string; edge: Edge }>;
}

export type ScoreFn = (block: Block) => number;

/** Walking a metre of a beautiful block "costs" far less than a metre of a dull one. */
/** Multiplies the cost of walking a block in a given direction; 1 leaves it unchanged. */
export type CostFn = (block: Block, forward: boolean) => number;

function edgeCost(e: Edge, score: ScoreFn, used: Set<string> | null, extra?: CostFn): number {
  const s = Math.max(0, Math.min(1, score(e.block)));
  let c = e.block.len * (0.4 + 1.6 * (1 - s));
  const grade = e.forward ? e.block.grade : -e.block.grade;
  if (grade > 0.08) c *= 1.15;
  if (used?.has(e.block.id)) c *= 4;
  if (extra) c *= extra(e.block, e.forward);
  return c;
}

function dijkstra(g: Graph, source: string, score: ScoreFn, used: Set<string> | null, maxLen: number, extra?: CostFn): Tree {
  const cost = new Map<string, number>([[source, 0]]);
  const len = new Map<string, number>([[source, 0]]);
  const prev = new Map<string, { from: string; edge: Edge }>();
  const done = new Set<string>();
  const heap = new Heap();
  heap.push([0, source]);
  while (heap.size) {
    const [c, n] = heap.pop();
    if (done.has(n)) continue;
    done.add(n);
    const nLen = len.get(n)!;
    if (nLen > maxLen) continue;
    for (const e of g.adj.get(n) ?? []) {
      if (done.has(e.to)) continue;
      const nc = c + edgeCost(e, score, used, extra);
      if (nc < (cost.get(e.to) ?? Infinity)) {
        cost.set(e.to, nc);
        len.set(e.to, nLen + e.block.len);
        prev.set(e.to, { from: n, edge: e });
        heap.push([nc, e.to]);
      }
    }
  }
  return { cost, len, prev };
}

function pathTo(tree: Tree, target: string): Traversal[] {
  const out: Traversal[] = [];
  let cur = target;
  for (;;) {
    const p = tree.prev.get(cur);
    if (!p) break;
    out.push({ block: p.edge.block, forward: p.edge.forward });
    cur = p.from;
  }
  return out.reverse();
}

export interface LoopResult {
  path: Traversal[];
  lengthM: number;
  meanScore: number;
  repeatFrac: number;
}

function evaluate(path: Traversal[], score: ScoreFn, targetM: number): LoopResult & { objective: number } {
  const seen = new Set<string>();
  let lengthM = 0;
  let weighted = 0;
  let repeated = 0;
  for (const t of path) {
    lengthM += t.block.len;
    if (seen.has(t.block.id)) repeated += t.block.len;
    else weighted += t.block.len * score(t.block);
    seen.add(t.block.id);
  }
  const meanScore = lengthM > 0 ? weighted / lengthM : 0;
  const repeatFrac = lengthM > 0 ? repeated / lengthM : 0;
  const objective = meanScore - 0.6 * (Math.abs(lengthM - targetM) / targetM) - 0.5 * repeatFrac;
  return { path, lengthM, meanScore, repeatFrac, objective };
}

/**
 * Design a loop of about targetM metres from start that spends as much of its
 * length as possible on high-scoring blocks.
 *
 * It tries many triangles start -> A -> B -> start. A and B are picked from a
 * ring around the start in different compass directions; each leg takes the
 * most beautiful path, and later legs are steered away from blocks already used.
 * The best triangle by beauty, length fit and lack of backtracking wins.
 */
export function planLoop(g: Graph, start: string, targetM: number, score: ScoreFn, extra?: CostFn): LoopResult | null {
  const origin = g.pos.get(start);
  if (!origin) return null;
  const reach = targetM * 0.75;
  const first = dijkstra(g, start, score, null, reach, extra);

  const pickBySector = (tree: Tree, ok: (id: string, len: number) => boolean, sectors: number, perSector: number) => {
    const buckets = new Map<number, { id: string; q: number }[]>();
    for (const [id, len] of tree.len) {
      if (len <= 0 || !ok(id, len)) continue;
      const sector = Math.floor(bearing(origin, g.pos.get(id)!) / (360 / sectors));
      const q = tree.cost.get(id)! / len;
      const list = buckets.get(sector) ?? [];
      list.push({ id, q });
      buckets.set(sector, list);
    }
    const out: string[] = [];
    for (const list of buckets.values()) {
      list.sort((x, y) => x.q - y.q);
      for (const item of list.slice(0, perSector)) out.push(item.id);
    }
    return out;
  };

  type Scored = LoopResult & { objective: number };
  // Assigned inside loops below; the cast stops the compiler narrowing it to null.
  let best = null as Scored | null;

  // First pass uses well-shaped triangles; if the network is too small or the
  // start too near an edge for those, a second pass accepts lopsided ones.
  for (const loose of [false, true]) {
    const legMin = loose ? 0.15 : 0.27;
    const legMax = loose ? 0.5 : 0.4;
    const as = pickBySector(first, (_id, len) => len >= targetM * legMin && len <= targetM * legMax, 12, 1);
    for (const a of as) {
      const leg1 = pathTo(first, a);
      const used1 = new Set(leg1.map((t) => t.block.id));
      const second = dijkstra(g, a, score, used1, reach, extra);
      const bearingA = bearing(origin, g.pos.get(a)!);
      const bs = pickBySector(
        second,
        (id, len) => {
          if (id === start || len < targetM * (loose ? 0.12 : 0.22) || len > targetM * (loose ? 0.55 : 0.42)) return false;
          const p = g.pos.get(id)!;
          const turn = angleDiff(bearing(origin, p), bearingA);
          const away = haversine(origin, p);
          if (loose) return turn >= 20 && away >= targetM * 0.04;
          return turn >= 35 && turn <= 150 && away >= targetM * 0.12 && away <= targetM * 0.42;
        },
        12,
        1,
      );
      for (const b of bs) {
        const leg2 = pathTo(second, b);
        const used2 = new Set(used1);
        for (const t of leg2) used2.add(t.block.id);
        const third = dijkstra(g, b, score, used2, reach, extra);
        if (!third.len.has(start)) continue;
        const candidate = evaluate([...leg1, ...leg2, ...pathTo(third, start)], score, targetM);
        if (!best || candidate.objective > best.objective) best = candidate;
      }
    }
    // Good enough: within a fifth of the requested length.
    if (best && Math.abs(best.lengthM - targetM) / targetM < 0.2) break;
  }

  if (!best) {
    // Small network or short walk: go out along the best path and come back.
    let far: string | null = null;
    let farQ = Infinity;
    for (const [id, len] of first.len) {
      if (len < targetM * 0.35 || len > targetM * 0.6) continue;
      const q = first.cost.get(id)! / len;
      if (q < farQ) {
        farQ = q;
        far = id;
      }
    }
    if (!far) return null;
    const out = pathTo(first, far);
    const back = [...out].reverse().map((t) => ({ block: t.block, forward: !t.forward }));
    best = evaluate([...out, ...back], score, targetM);
  }
  const { path, lengthM, meanScore, repeatFrac } = best;
  return { path, lengthM, meanScore, repeatFrac };
}
