/**
 * Download the street network once and save it as data/streets.json, so the app
 * can start without calling OpenStreetMap. Run by the "Import streets" workflow.
 */
import fs from 'node:fs';
import { applyElevation, BBOX, buildBlocks, fetchCityTrees, fetchElevations, fetchOverpass } from '../src/lib/osm';
import type { LngLat } from '../src/lib/types';
import { largestComponent } from '../src/lib/router';

async function main() {
  const elements = await fetchOverpass();
  let cityTrees: LngLat[] = [];
  let trees = '';
  try {
    cityTrees = await fetchCityTrees();
    trees = `${cityTrees.length} city tree records`;
  } catch (err) {
    trees = `city tree list failed: ${String(err)}`;
  }
  const all = buildBlocks(elements, cityTrees);
  const blocks = largestComponent(all);
  let elevation = 'ok';
  try {
    applyElevation(blocks, await fetchElevations(blocks));
  } catch (err) {
    elevation = `failed: ${String(err)}`;
  }
  const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  for (const b of blocks) {
    b.coords = b.coords.map((p) => [r(p[0], 6), r(p[1], 6)]);
    b.len = r(b.len, 1);
    b.bearing = r(b.bearing, 1);
    b.grade = r(b.grade, 4);
    if (b.elev != null) b.elev = r(b.elev, 1);
    for (const k of ['views', 'green', 'arch', 'energy'] as const) b.prior[k] = r(b.prior[k], 3);
    for (const s of ['L', 'R'] as const) {
      b.prior[s].green = r(b.prior[s].green, 3);
      b.prior[s].energy = r(b.prior[s].energy, 3);
    }
  }
  fs.mkdirSync('data', { recursive: true });
  // Trees for the 3D scene: city records plus OpenStreetMap's own, one per ~4 m cell.
  const seen = new Set<string>();
  const allTrees: LngLat[] = [];
  const osmTrees: LngLat[] = elements.filter((e) => e.type === 'node' && e.tags?.natural === 'tree').map((e) => [e.lon!, e.lat!]);
  for (const [lng, lat] of [...cityTrees, ...osmTrees]) {
    const k = `${Math.round(lng / 0.00004)}:${Math.round(lat / 0.00004)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    allTrees.push([r(lng, 6), r(lat, 6)]);
  }
  fs.writeFileSync('data/trees.json', JSON.stringify(allTrees));
  fs.writeFileSync(
    'data/streets.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), bbox: BBOX, elevation, trees, osmElements: elements.length, droppedBlocks: all.length - blocks.length, blocks }),
  );
  console.log(`Saved ${blocks.length} blocks (${all.length - blocks.length} disconnected dropped). Elevation: ${elevation}. Trees: ${trees}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
