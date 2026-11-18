/**
 * Check the saved street snapshot against reality: how much was imported, how
 * the scores are spread, which streets rank highest, and whether the planner
 * and forecast work from a real Russian Hill corner. Writes data/import-report.md.
 */
import fs from 'node:fs';
import { buildContext, fetchWeather } from '../src/lib/context';
import { designWalk } from '../src/lib/planner';
import { buildGraph } from '../src/lib/router';
import { priorScore } from '../src/lib/scoring';
import { DEFAULT_WEIGHTS, DIMS, type Block, type LngLat } from '../src/lib/types';

const START: LngLat = [-122.4194, 37.8021]; // Hyde and Lombard

async function main() {
  const snap = JSON.parse(fs.readFileSync('data/streets.json', 'utf8')) as { generatedAt: string; elevation: string; trees?: string; blocks: Block[] };
  const blocks = snap.blocks;
  const out: string[] = [`# Street import report`, ``, `Generated ${snap.generatedAt}. Elevation: ${snap.elevation}. Trees: ${snap.trees ?? 'OpenStreetMap only'}.`, ``];
  const km = blocks.reduce((s, b) => s + b.len, 0) / 1000;
  out.push(`- Blocks: ${blocks.length}, ${km.toFixed(1)} km`);
  const byType = new Map<string, number>();
  for (const b of blocks) byType.set(b.highway, (byType.get(b.highway) ?? 0) + 1);
  out.push(`- By type: ${[...byType].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const d of DIMS) {
    const vals = blocks.map((b) => b.prior[d]).sort((a, b) => a - b);
    const q = (p: number) => vals[Math.floor(p * (vals.length - 1))].toFixed(2);
    const nonzero = vals.filter((v) => v > 0.01).length;
    out.push(`- ${d}: median ${q(0.5)}, p90 ${q(0.9)}, max ${q(1)}, non-zero on ${Math.round((100 * nonzero) / vals.length)}% of blocks`);
  }
  const sided = blocks.filter((b) => Math.abs(b.prior.L.green - b.prior.R.green) > 0.05 || Math.abs(b.prior.L.energy - b.prior.R.energy) > 0.05).length;
  out.push(`- Blocks where the two sides differ in map data: ${Math.round((100 * sided) / blocks.length)}%`);
  out.push(`- Blocks with elevation: ${Math.round((100 * blocks.filter((b) => b.elev != null).length) / blocks.length)}%`);

  const streets = new Map<string, { len: number; sum: number }>();
  for (const b of blocks) {
    const s = streets.get(b.name) ?? { len: 0, sum: 0 };
    s.len += b.len;
    s.sum += b.len * priorScore(b, DEFAULT_WEIGHTS);
    streets.set(b.name, s);
  }
  for (const generic of ['Stairway', 'Footpath', 'Alley', 'Unnamed street']) streets.delete(generic);
  const ranked = [...streets].filter(([, s]) => s.len >= 150).map(([name, s]) => ({ name, score: s.sum / s.len, len: s.len })).sort((a, b) => b.score - a.score);
  out.push(``, `## Top 25 streets by map data alone`, ``);
  ranked.slice(0, 25).forEach((s, i) => out.push(`${i + 1}. ${s.name}: ${Math.round(s.score * 100)} (${Math.round(s.len)} m)`));
  out.push(``, `## Where well-known streets rank (of ${ranked.length})`, ``);
  for (const name of ['Lombard Street', 'Macondray Lane', 'Filbert Steps', 'Greenwich Steps', 'Vallejo Street', 'Green Street', 'Union Street', 'Hyde Street', 'Columbus Avenue', 'Van Ness Avenue', 'Broadway']) {
    const i = ranked.findIndex((s) => s.name === name);
    out.push(i < 0 ? `- ${name}: not found` : `- ${name}: #${i + 1}, ${Math.round(ranked[i].score * 100)}`);
  }
  const sc = blocks.map((b) => priorScore(b, DEFAULT_WEIGHTS)).sort((a, b) => a - b);
  out.push(``, `Block score spread: p10 ${sc[Math.floor(sc.length * 0.1)].toFixed(2)}, median ${sc[Math.floor(sc.length / 2)].toFixed(2)}, p90 ${sc[Math.floor(sc.length * 0.9)].toFixed(2)}, max ${sc[sc.length - 1].toFixed(2)}`);
  out.push(``, `## Bottom 10`, ``);
  ranked.slice(-10).forEach((s) => out.push(`- ${s.name}: ${Math.round(s.score * 100)} (${Math.round(s.len)} m)`));

  const now = new Date();
  const weather = await fetchWeather(START, now);
  out.push(``, `## Forecast lookup`, ``, weather ? `Worked: ${JSON.stringify(weather)}` : `Failed: no forecast returned.`);

  const graph = buildGraph(blocks);
  const ctx = buildContext(START, now, weather);
  out.push(``, `## Walks from Hyde and Lombard`, ``, `Conditions: ${ctx.notes.join(' ')}`, ``);
  const routes: Record<string, unknown> = {};
  for (const minutes of [30, 45, 75]) {
    const t0 = Date.now();
    const route = designWalk({ blocks, graph, community: new Map(), start: START, minutes, weights: DEFAULT_WEIGHTS, ctx });
    const ms = Date.now() - t0;
    if (!route) {
      out.push(`### ${minutes} minutes: no loop found (${ms} ms)`, ``);
      continue;
    }
    routes[minutes] = route;
    out.push(
      `### ${minutes} minutes asked: ${Math.round(route.minutes)} min, ${(route.lengthM / 1609.34).toFixed(2)} mi, ${Math.round(route.climbM * 3.28)} ft climb, beauty ${Math.round(route.meanScore * 100)}, repeat ${Math.round(route.repeatFrac * 100)}%, planned in ${ms} ms`,
      ``,
    );
    for (const s of route.steps) out.push(`- ${s.name}, heading ${s.heading}${s.sideLabel ? `, ${s.sideLabel} side (${s.reason})` : ''}, ${Math.round(s.len)} m`);
    out.push(``);
  }
  fs.writeFileSync('data/import-report.md', out.join('\n') + '\n');
  fs.writeFileSync('data/sample-routes.json', JSON.stringify(routes));
  console.log(out.join('\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
