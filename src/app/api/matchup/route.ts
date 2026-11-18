import { db } from '@/lib/db';
import { bad, currentUser, unauthorized } from '@/lib/session';
import { world } from '@/lib/store';
import type { Block } from '@/lib/types';

export const dynamic = 'force-dynamic';

const K = 24;
const GENERIC = new Set(['Unnamed street', 'Alley', 'Footpath']);

function card(b: Block) {
  const mid = b.coords[Math.floor(b.coords.length / 2)];
  const a = b.coords[0];
  const z = b.coords[b.coords.length - 1];
  const at = b.coords.length === 2 ? [(a[0] + z[0]) / 2, (a[1] + z[1]) / 2] : mid;
  return { id: b.id, name: b.name, at, bearing: Math.round(b.bearing), coords: b.coords };
}

/** Two blocks to compare: one we know little about, one rated close to it. */
export async function GET() {
  const w = await world();
  const pool = w.blocks.filter((b) => b.len >= 60 && !GENERIC.has(b.name));
  if (pool.length < 2) return bad('Not enough named streets to compare yet.');
  const elo = new Map<string, { rating: number; n: number }>();
  for (const r of (await (await db()).execute('select block_id, rating, n from elo')).rows)
    elo.set(r.block_id as string, { rating: Number(r.rating), n: Number(r.n) });
  const sample = () => Array.from({ length: 30 }, () => pool[Math.floor(Math.random() * pool.length)]);
  const n = (b: Block) => elo.get(b.id)?.n ?? 0;
  const rating = (b: Block) => elo.get(b.id)?.rating ?? 1500;
  const first = sample().reduce((x, y) => (n(y) < n(x) ? y : x));
  const others = sample().filter((b) => b.name !== first.name);
  if (!others.length) return bad('Not enough named streets to compare yet.');
  const second = others.reduce((x, y) => (Math.abs(rating(y) - rating(first)) < Math.abs(rating(x) - rating(first)) ? y : x));
  return Response.json({ a: card(first), b: card(second) });
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return unauthorized();
  const body = (await req.json().catch(() => null)) as { winner?: unknown; loser?: unknown } | null;
  const w = await world();
  const winner = typeof body?.winner === 'string' ? w.byId.get(body.winner) : undefined;
  const loser = typeof body?.loser === 'string' ? w.byId.get(body.loser) : undefined;
  if (!winner || !loser || winner.id === loser.id) return bad('That matchup is not valid.');

  const client = await db();
  const tx = await client.transaction('write');
  try {
    const get = async (id: string) => {
      const r = (await tx.execute({ sql: 'select rating, n from elo where block_id = ?', args: [id] })).rows[0];
      return r ? { rating: Number(r.rating), n: Number(r.n) } : { rating: 1500, n: 0 };
    };
    const a = await get(winner.id);
    const b = await get(loser.id);
    const expected = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
    const delta = K * (1 - expected);
    const put = (id: string, rating: number, n: number) =>
      tx.execute({ sql: 'insert or replace into elo (block_id, rating, n) values (?, ?, ?)', args: [id, rating, n] });
    await put(winner.id, a.rating + delta, a.n + 1);
    await put(loser.id, b.rating - delta, b.n + 1);
    await tx.execute({
      sql: 'insert into matchups (user_id, winner, loser, created_at) values (?, ?, ?, ?)',
      args: [me.id, winner.id, loser.id, Date.now()],
    });
    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
  return Response.json({ ok: true });
}
