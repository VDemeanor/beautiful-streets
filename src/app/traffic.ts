import type { LngLat } from '@/lib/types';

/**
 * Street life. A small traffic simulation: cars drive the real street network
 * on the right-hand side, slow for intersections and pick a way on at each one,
 * and a cable car runs up and down Hyde Street. Only the area around the
 * camera is populated; cars that fall behind are recycled ahead.
 */

export interface Road {
  name: string;
  kind: string;
  coords: LngLat[];
}

export interface Vehicle {
  id: number;
  type: 'car' | 'cable';
  /** Which paint job, for cars. */
  paint: number;
  at: LngLat;
  /** Compass heading, degrees clockwise from north. */
  heading: number;
}

/** Cruising speed in metres per second, and how much traffic a street type attracts. */
const DRIVE: Record<string, { speed: number; weight: number }> = {
  primary: { speed: 11, weight: 5 },
  secondary: { speed: 10, weight: 4 },
  tertiary: { speed: 8.5, weight: 3 },
  unclassified: { speed: 7, weight: 1.5 },
  residential: { speed: 6.5, weight: 1 },
  living_street: { speed: 4, weight: 0.4 },
};

const RAD = Math.PI / 180;
const M_PER_DEG = 111320;
const PAINTS = 6;

interface Lane {
  road: number;
  forward: boolean;
}

interface Segmented {
  road: Road;
  /** Local metres relative to the first point. */
  xy: [number, number][];
  cum: number[];
  length: number;
  mid: LngLat;
  origin: LngLat;
  kx: number;
}

interface Car {
  id: number;
  type: 'car' | 'cable';
  paint: number;
  lane: Lane;
  s: number;
  pace: number;
}

const key = (p: LngLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;

export class Traffic {
  private roads: Segmented[] = [];
  private nodes = new Map<string, Lane[]>();
  private cars: Car[] = [];
  private cable: number[] = [];
  private nextId = 1;
  private seed = 20261121;

  constructor(roads: Road[], private count = 22) {
    for (const road of roads) {
      if (!DRIVE[road.kind] || road.coords.length < 2) continue;
      const origin = road.coords[0];
      const kx = M_PER_DEG * Math.cos(origin[1] * RAD);
      const xy = road.coords.map((c) => [(c[0] - origin[0]) * kx, (c[1] - origin[1]) * M_PER_DEG] as [number, number]);
      const cum = [0];
      for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
      const length = cum[cum.length - 1];
      if (length < 8) continue;
      const index = this.roads.length;
      this.roads.push({ road, xy, cum, length, mid: road.coords[Math.floor(road.coords.length / 2)], origin, kx });
      // A lane leaves from each end of the block.
      this.join(key(road.coords[0]), { road: index, forward: true });
      this.join(key(road.coords[road.coords.length - 1]), { road: index, forward: false });
      // The Powell-Hyde cable car line runs on Hyde Street from the bay up over Russian Hill.
      if (road.name === 'Hyde Street' && this.roads[index].mid[1] > 37.7945) this.cable.push(index);
    }
    if (this.cable.length) {
      for (let i = 0; i < 2; i++) {
        const road = this.cable[Math.floor(((i + 0.3) / 2) * this.cable.length)];
        this.cars.push({ id: this.nextId++, type: 'cable', paint: 0, lane: { road, forward: i === 0 }, s: 0, pace: 1 });
      }
    }
  }

  private join(node: string, lane: Lane) {
    const list = this.nodes.get(node);
    if (list) list.push(lane);
    else this.nodes.set(node, [lane]);
  }

  private random() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private metresBetween(a: LngLat, b: LngLat) {
    return Math.hypot((a[0] - b[0]) * M_PER_DEG * Math.cos(a[1] * RAD), (a[1] - b[1]) * M_PER_DEG);
  }

  /** Position and heading a distance along a lane, shifted sideways to the right of travel. */
  private place(lane: Lane, s: number, right: number): { at: LngLat; heading: number } {
    const r = this.roads[lane.road];
    const d = lane.forward ? s : r.length - s;
    let i = 1;
    while (i < r.cum.length - 1 && r.cum[i] < d) i++;
    const span = r.cum[i] - r.cum[i - 1] || 1;
    const f = (d - r.cum[i - 1]) / span;
    let dx = (r.xy[i][0] - r.xy[i - 1][0]) / span;
    let dy = (r.xy[i][1] - r.xy[i - 1][1]) / span;
    if (!lane.forward) {
      dx = -dx;
      dy = -dy;
    }
    const x = r.xy[i - 1][0] + (r.xy[i][0] - r.xy[i - 1][0]) * f + dy * right;
    const y = r.xy[i - 1][1] + (r.xy[i][1] - r.xy[i - 1][1]) * f - dx * right;
    return { at: [r.origin[0] + x / r.kx, r.origin[1] + y / M_PER_DEG], heading: (Math.atan2(dx, dy) / RAD + 360) % 360 };
  }

  private endNode(lane: Lane): string {
    const c = this.roads[lane.road].road.coords;
    return key(lane.forward ? c[c.length - 1] : c[0]);
  }

  /** Where to go at the end of a block: usually straight on, sometimes a turn, never back unless stuck. */
  private onward(lane: Lane, cableOnly: boolean): Lane {
    const here = this.place(lane, this.roads[lane.road].length, 0).heading;
    const options = (this.nodes.get(this.endNode(lane)) ?? []).filter((o) => o.road !== lane.road && (!cableOnly || this.cable.includes(o.road)));
    if (!options.length) return { road: lane.road, forward: !lane.forward };
    const scored = options.map((o) => {
      const turn = Math.abs(((this.place(o, 0, 0).heading - here + 540) % 360) - 180);
      return { o, turn };
    });
    scored.sort((a, b) => a.turn - b.turn);
    if (cableOnly || this.random() < 0.62) return scored[0].o;
    return scored[Math.floor(this.random() * scored.length)].o;
  }

  private spawn(focus: LngLat): Car | null {
    let best: number | null = null;
    let bestScore = -1;
    for (let tries = 0; tries < 40; tries++) {
      const i = Math.floor(this.random() * this.roads.length);
      const d = this.metresBetween(this.roads[i].mid, focus);
      if (d > 430 || d < 60) continue;
      const score = DRIVE[this.roads[i].road.kind].weight * this.random();
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best === null) return null;
    return {
      id: this.nextId++,
      type: 'car',
      paint: Math.min(PAINTS - 1, Math.floor(this.random() ** 1.6 * PAINTS)),
      lane: { road: best, forward: this.random() < 0.5 },
      s: this.random() * this.roads[best].length,
      pace: 0.85 + this.random() * 0.3,
    };
  }

  /** Advance the simulation by dt seconds and return the vehicles near the focus point. */
  step(dt: number, focus: LngLat): Vehicle[] {
    if (!this.roads.length) return [];
    const out: Vehicle[] = [];
    const kept: Car[] = [];
    let cars = 0;
    for (const car of this.cars) {
      const r = this.roads[car.lane.road];
      const base = car.type === 'cable' ? 4.2 : DRIVE[r.road.kind].speed * car.pace;
      // Ease off approaching the corner, and pull away again after it.
      const edge = Math.min(car.s, r.length - car.s);
      const speed = base * (0.45 + 0.55 * Math.min(1, edge / 14));
      car.s += speed * dt;
      if (car.s >= r.length) {
        car.lane = this.onward(car.lane, car.type === 'cable');
        car.s = 0;
      }
      // Cars keep right; the cable car runs nearer the middle of the street.
      const p = this.place(car.lane, car.s, car.type === 'cable' ? 1.4 : 2.7);
      const far = this.metresBetween(p.at, focus);
      if (car.type === 'car') {
        if (far > 540) continue; // recycled below
        cars++;
      }
      kept.push(car);
      if (far < (car.type === 'cable' ? 900 : 540)) out.push({ id: car.id, type: car.type, paint: car.paint, at: p.at, heading: p.heading });
    }
    this.cars = kept;
    for (let i = cars; i < this.count; i++) {
      const car = this.spawn(focus);
      if (!car) break;
      this.cars.push(car);
    }
    return out;
  }
}
