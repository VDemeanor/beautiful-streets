import { bearing, clamp01, lineLength, pointToSegment } from './geo';
import type { Block, LngLat, Prior } from './types';

/** Russian Hill and its neighbours: Marina east, Pacific Heights, Nob Hill, North Beach, Telegraph Hill. */
export const BBOX = { s: 37.787, w: -122.447, n: 37.811, e: -122.4 };
export type BBox = typeof BBOX;

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

const WALKABLE = new Set([
  'residential',
  'tertiary',
  'secondary',
  'primary',
  'living_street',
  'pedestrian',
  'footway',
  'steps',
  'path',
  'unclassified',
  'service',
]);

export function overpassQuery(b: BBox): string {
  const box = `(${b.s},${b.w},${b.n},${b.e})`;
  return `[out:json][timeout:120];
(
  way["highway"~"^(${[...WALKABLE].join('|')})$"]${box};
  node["natural"="tree"]${box};
  node["tourism"~"^(viewpoint|attraction|artwork)$"]${box};
  node["amenity"~"^(cafe|restaurant|bar|pub|ice_cream|bakery)$"]${box};
  node["shop"]${box};
  way["leisure"~"^(park|garden)$"]${box};
  node["historic"]${box};
  way["historic"]${box};
  way["heritage"]${box};
);
out body geom;`;
}

const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

export async function fetchOverpass(b: BBox = BBOX): Promise<OsmElement[]> {
  let lastError: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(overpassQuery(b)),
      });
      if (!res.ok) throw new Error(`Overpass ${url} answered ${res.status}`);
      const json = (await res.json()) as { elements: OsmElement[] };
      return json.elements;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Could not download streets from OpenStreetMap: ${String(lastError)}`);
}

function isWalkable(tags: Record<string, string>): boolean {
  if (!WALKABLE.has(tags.highway)) return false;
  if (tags.area === 'yes') return false;
  if (tags.access === 'private' || tags.access === 'no' || tags.foot === 'no') return false;
  // Sidewalks mapped as their own lines duplicate the street; the side-of-street
  // model already covers them.
  if (tags.footway === 'sidewalk' || tags.footway === 'crossing') return false;
  if (tags.service === 'driveway' || tags.service === 'parking_aisle') return false;
  return true;
}

function displayName(tags: Record<string, string>): string {
  if (tags.name) return tags.name;
  if (tags.highway === 'steps') return 'Stairway';
  if (tags.highway === 'footway' || tags.highway === 'path' || tags.highway === 'pedestrian') return 'Footpath';
  if (tags.highway === 'service') return 'Alley';
  return 'Unnamed street';
}

const TRAFFIC: Record<string, number> = {
  primary: 1,
  secondary: 0.7,
  tertiary: 0.4,
  unclassified: 0.2,
  service: 0.15,
  residential: 0.1,
};

interface Feature {
  kind: 'tree' | 'view' | 'poi' | 'park' | 'historic';
  pt: LngLat;
}

const RADIUS: Record<Feature['kind'], number> = { tree: 18, poi: 25, park: 40, historic: 60, view: 150 };

function collectFeatures(elements: OsmElement[]): Feature[] {
  const out: Feature[] = [];
  for (const el of elements) {
    const t = el.tags;
    if (!t) continue;
    if (el.type === 'node' && el.lat != null && el.lon != null) {
      const pt: LngLat = [el.lon, el.lat];
      if (t.natural === 'tree') out.push({ kind: 'tree', pt });
      if (t.tourism === 'viewpoint') out.push({ kind: 'view', pt });
      if (t.tourism === 'attraction' || t.tourism === 'artwork' || t.historic) out.push({ kind: 'historic', pt });
      if (t.shop || (t.amenity && /^(cafe|restaurant|bar|pub|ice_cream|bakery)$/.test(t.amenity)))
        out.push({ kind: 'poi', pt });
    } else if (el.type === 'way' && el.geometry?.length) {
      if (t.leisure === 'park' || t.leisure === 'garden') {
        // Every outline vertex counts as a bit of green edge.
        for (const g of el.geometry) out.push({ kind: 'park', pt: [g.lon, g.lat] });
      }
      if ((t.historic || t.heritage) && !t.highway) {
        const g = el.geometry[0];
        out.push({ kind: 'historic', pt: [g.lon, g.lat] });
      }
    }
  }
  return out;
}

const CELL = 0.0005; // roughly 50 m
const cellKey = (x: number, y: number) => `${x}:${y}`;
const cellOf = (p: LngLat): [number, number] => [Math.floor(p[0] / CELL), Math.floor(p[1] / CELL)];

interface Counts {
  tree: [number, number];
  poi: [number, number];
  park: number;
  historic: number;
  view: number;
}

const squash = (density: number, k: number) => 1 - Math.exp(-density / k);

/**
 * Turn raw OpenStreetMap elements into blocks: each walkable way is cut at every
 * intersection, then scored from the trees, shops, parks, landmarks and viewpoints
 * found beside it. Trees and shops are counted per side of the street.
 */
export function buildBlocks(elements: OsmElement[]): Block[] {
  const ways = elements.filter(
    (e) => e.type === 'way' && e.tags && e.nodes && e.geometry && isWalkable(e.tags),
  );

  const usage = new Map<number, number>();
  for (const w of ways) for (const n of w.nodes!) usage.set(n, (usage.get(n) ?? 0) + 1);

  const blocks: Block[] = [];
  const counts = new Map<string, Counts>();

  for (const w of ways) {
    const nodes = w.nodes!;
    const geom = w.geometry!;
    const tags = w.tags!;
    let start = 0;
    let part = 0;
    for (let i = 1; i < nodes.length; i++) {
      const isEnd = i === nodes.length - 1;
      if (!isEnd && (usage.get(nodes[i]) ?? 0) < 2) continue;
      const coords: LngLat[] = geom.slice(start, i + 1).map((g) => [g.lon, g.lat]);
      const len = lineLength(coords);
      if (nodes[start] !== nodes[i] && len > 0) {
        const id = `${w.id}-${part++}`;
        blocks.push({
          id,
          name: displayName(tags),
          highway: tags.highway,
          coords,
          len,
          bearing: bearing(coords[0], coords[coords.length - 1]),
          a: String(nodes[start]),
          b: String(nodes[i]),
          elev: null,
          grade: 0,
          prior: emptyPrior(),
        });
        counts.set(id, { tree: [0, 0], poi: [0, 0], park: 0, historic: 0, view: 0 });
      }
      start = i;
    }
  }

  // Index every block segment by the grid cells it touches.
  const grid = new Map<string, { block: Block; i: number }[]>();
  for (const block of blocks) {
    for (let i = 1; i < block.coords.length; i++) {
      const [x0, y0] = cellOf(block.coords[i - 1]);
      const [x1, y1] = cellOf(block.coords[i]);
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
          const k = cellKey(x, y);
          let list = grid.get(k);
          if (!list) grid.set(k, (list = []));
          list.push({ block, i });
        }
    }
  }

  for (const f of collectFeatures(elements)) {
    const radius = RADIUS[f.kind];
    const reach = Math.ceil(radius / 40);
    const [cx, cy] = cellOf(f.pt);
    const best = new Map<string, { dist: number; cross: number }>();
    for (let x = cx - reach; x <= cx + reach; x++)
      for (let y = cy - reach; y <= cy + reach; y++)
        for (const { block, i } of grid.get(cellKey(x, y)) ?? []) {
          const hit = pointToSegment(f.pt, block.coords[i - 1], block.coords[i]);
          if (hit.dist > radius) continue;
          const prev = best.get(block.id);
          if (!prev || hit.dist < prev.dist) best.set(block.id, hit);
        }
    for (const [id, hit] of best) {
      const c = counts.get(id)!;
      const side = hit.cross > 0 ? 0 : 1;
      if (f.kind === 'tree') c.tree[side]++;
      else if (f.kind === 'poi') c.poi[side]++;
      else if (f.kind === 'park') c.park++;
      else if (f.kind === 'historic') c.historic++;
      else c.view++;
    }
  }

  for (const block of blocks) {
    const c = counts.get(block.id)!;
    const per100 = 100 / Math.max(block.len, 20);
    const park = c.park > 0 ? 0.45 : 0;
    const prior: Prior = {
      green: clamp01(squash((c.tree[0] + c.tree[1]) * per100, 6) + park),
      energy: squash((c.poi[0] + c.poi[1]) * per100, 4),
      arch: clamp01(squash(c.historic, 2) + (block.highway === 'living_street' ? 0.15 : 0)),
      views: clamp01((block.highway === 'steps' ? 0.55 : 0) + (c.view > 0 ? 0.5 : 0)),
      traffic: TRAFFIC[block.highway] ?? 0,
      L: { green: squash(c.tree[0] * per100, 3), energy: squash(c.poi[0] * per100, 2) },
      R: { green: squash(c.tree[1] * per100, 3), energy: squash(c.poi[1] * per100, 2) },
    };
    block.prior = prior;
  }
  return blocks;
}

export function emptyPrior(): Prior {
  return {
    views: 0,
    green: 0,
    arch: 0,
    energy: 0,
    traffic: 0,
    L: { green: 0, energy: 0 },
    R: { green: 0, energy: 0 },
  };
}

/**
 * Add elevation: high ground earns a views bonus (hilltops are where the bay shows
 * up), and each block gets a grade so the planner knows about climbs.
 */
export function applyElevation(blocks: Block[], elevByNode: Map<string, number>): void {
  const all = [...elevByNode.values()].sort((x, y) => x - y);
  if (!all.length) return;
  const pct = (e: number) => {
    let lo = 0;
    let hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid] < e) lo = mid + 1;
      else hi = mid;
    }
    return lo / all.length;
  };
  for (const b of blocks) {
    const ea = elevByNode.get(b.a);
    const eb = elevByNode.get(b.b);
    if (ea == null || eb == null) continue;
    b.elev = (ea + eb) / 2;
    b.grade = (eb - ea) / Math.max(b.len, 5);
    b.prior.views = clamp01(b.prior.views + 0.5 * pct(b.elev) ** 2);
  }
}

/** Elevation for each intersection from Open-Meteo, 100 points per request. */
export async function fetchElevations(blocks: Block[]): Promise<Map<string, number>> {
  const pts = new Map<string, LngLat>();
  for (const b of blocks) {
    pts.set(b.a, b.coords[0]);
    pts.set(b.b, b.coords[b.coords.length - 1]);
  }
  const ids = [...pts.keys()];
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const lat = chunk.map((id) => pts.get(id)![1].toFixed(5)).join(',');
    const lng = chunk.map((id) => pts.get(id)![0].toFixed(5)).join(',');
    const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
    if (!res.ok) throw new Error(`Elevation service answered ${res.status}`);
    const json = (await res.json()) as { elevation: number[] };
    chunk.forEach((id, j) => out.set(id, json.elevation[j]));
  }
  return out;
}
