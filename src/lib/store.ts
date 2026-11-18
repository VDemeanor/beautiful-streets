import type { Client } from '@libsql/client';
import fs from 'node:fs';
import { db } from './db';
import { demoBlocks } from './demo';
import { applyElevation, buildBlocks, fetchElevations, fetchOverpass } from './osm';
import { buildGraph, largestComponent, type Graph } from './router';
import type { Block, Community } from './types';

export interface World {
  blocks: Block[];
  byId: Map<string, Block>;
  graph: Graph;
  source: 'osm' | 'demo';
}

const g = globalThis as unknown as { __bsWorld?: Promise<World> };
const SNAPSHOT = 'data/streets.json';

/** Download, cut and score the street network. Run once; results live in the database. */
export async function importStreets(mode: 'osm' | 'demo'): Promise<Block[]> {
  let blocks: Block[];
  if (mode === 'demo') {
    blocks = demoBlocks();
  } else {
    blocks = largestComponent(buildBlocks(await fetchOverpass()));
    try {
      applyElevation(blocks, await fetchElevations(blocks));
    } catch (err) {
      console.warn('Elevation unavailable; hills and climbs left out.', err);
    }
  }
  return saveBlocks(blocks, mode);
}

/** The snapshot committed by the "Import streets" workflow, if present. */
function readSnapshot(): Block[] | null {
  try {
    return (JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as { blocks: Block[] }).blocks;
  } catch {
    return null;
  }
}

async function saveBlocks(blocks: Block[], mode: 'osm' | 'demo'): Promise<Block[]> {
  const client = await db();
  await client.batch(
    [
      'delete from blocks',
      ...blocks.map((b) => ({ sql: 'insert into blocks (id, data) values (?, ?)', args: [b.id, JSON.stringify(b)] })),
      { sql: 'insert or replace into meta (key, value) values (?, ?)', args: ['source', mode] },
    ],
    'write',
  );
  g.__bsWorld = undefined;
  return blocks;
}

async function load(): Promise<World> {
  const client = await db();
  let rows = (await client.execute('select data from blocks')).rows;
  if (!rows.length) {
    // Order of preference: demo grid if asked for, the committed snapshot, then a live download.
    const snapshot = process.env.BS_SEED === 'demo' ? null : readSnapshot();
    if (snapshot) await saveBlocks(snapshot, 'osm');
    else await importStreets(process.env.BS_SEED === 'demo' ? 'demo' : 'osm');
    rows = (await client.execute('select data from blocks')).rows;
  }
  const blocks = rows.map((r) => JSON.parse(r.data as string) as Block);
  const meta = await client.execute({ sql: 'select value from meta where key = ?', args: ['source'] });
  return {
    blocks,
    byId: new Map(blocks.map((b) => [b.id, b])),
    graph: buildGraph(blocks),
    source: (meta.rows[0]?.value as 'osm' | 'demo') ?? 'osm',
  };
}

export function world(): Promise<World> {
  if (!g.__bsWorld) {
    g.__bsWorld = load().catch((err) => {
      g.__bsWorld = undefined;
      throw err;
    });
  }
  return g.__bsWorld;
}

/** Everyone's votes, rolled up per block. */
export async function loadCommunity(client?: Client): Promise<Map<string, Community>> {
  const c = client ?? (await db());
  const out = new Map<string, Community>();
  const get = (id: string) => {
    let v = out.get(id);
    if (!v) out.set(id, (v = {}));
    return v;
  };
  for (const r of (await c.execute('select block_id, rating, n from elo')).rows)
    get(r.block_id as string).elo = { rating: Number(r.rating), n: Number(r.n) };
  const rows = (
    await c.execute('select block_id, side, kind, sum(value) as s, count(*) as n from ratings group by block_id, side, kind')
  ).rows;
  for (const r of rows) {
    const v = get(r.block_id as string);
    const s = Number(r.s);
    const n = Number(r.n);
    const side = r.side as 'L' | 'R' | 'B';
    if (side !== 'B') {
      const t = (v[side] ??= { sum: 0, n: 0 });
      t.sum += s;
      t.n += n;
    }
    // A thumb on one side is still a vote about the block. A plain side
    // preference (kind 'side') only feeds the side tallies.
    if (r.kind === 'rate') {
      const t = (v.rate ??= { sum: 0, n: 0 });
      t.sum += s;
      t.n += n;
    } else if (r.kind === 'thumb') {
      const t = (v.thumbs ??= { up: 0, down: 0 });
      t.up += s;
      t.down += n - s;
    }
  }
  return out;
}
