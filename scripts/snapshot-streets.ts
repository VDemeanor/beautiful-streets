/**
 * Download the street network once and save it as data/streets.json, so the app
 * can start without calling OpenStreetMap. Run by the "Import streets" workflow.
 */
import fs from 'node:fs';
import { applyElevation, BBOX, buildBlocks, fetchElevations, fetchOverpass } from '../src/lib/osm';
import { largestComponent } from '../src/lib/router';

async function main() {
  const elements = await fetchOverpass();
  const all = buildBlocks(elements);
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
  fs.writeFileSync(
    'data/streets.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), bbox: BBOX, elevation, osmElements: elements.length, droppedBlocks: all.length - blocks.length, blocks }),
  );
  console.log(`Saved ${blocks.length} blocks (${all.length - blocks.length} disconnected dropped). Elevation: ${elevation}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
