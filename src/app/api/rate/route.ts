import { db } from '@/lib/db';
import { bad, currentUser, unauthorized } from '@/lib/session';
import { world } from '@/lib/store';

interface Vote {
  blockId: string;
  kind: 'rate' | 'thumb' | 'side';
  side: 'L' | 'R' | 'B';
  value: number;
}

/**
 * Record votes on blocks.
 *  rate:  1-5 stars for the whole block (side B), after walking it
 *  thumb: 1 (up) or 0 (down) for the block or one side of it
 *  side:  which side was nicer (L or R)
 * A repeat vote from the same person replaces their earlier one.
 */
export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return unauthorized();
  const body = (await req.json().catch(() => null)) as { votes?: unknown } | null;
  if (!Array.isArray(body?.votes) || body.votes.length === 0 || body.votes.length > 500)
    return bad('Send between 1 and 500 votes.');
  const w = await world();
  const now = Date.now();
  const rows: [string, string, string, number][] = [];
  for (const v of body.votes as Vote[]) {
    if (!v || !w.byId.has(v.blockId)) return bad('One of those blocks does not exist.');
    if (v.kind === 'rate') {
      if (!(v.value >= 1 && v.value <= 5)) return bad('Stars must be between 1 and 5.');
      rows.push([v.blockId, 'B', 'rate', (v.value - 1) / 4]);
    } else if (v.kind === 'thumb') {
      if (!['L', 'R', 'B'].includes(v.side) || (v.value !== 0 && v.value !== 1)) return bad('That thumb vote is not valid.');
      rows.push([v.blockId, v.side, 'thumb', v.value]);
    } else if (v.kind === 'side') {
      if (v.side !== 'L' && v.side !== 'R') return bad('Choose the left or right side.');
      rows.push([v.blockId, v.side, 'side', 1]);
      rows.push([v.blockId, v.side === 'L' ? 'R' : 'L', 'side', 0]);
    } else return bad('Unknown kind of vote.');
  }
  await (await db()).batch(
    rows.map(([blockId, side, kind, value]) => ({
      sql: 'insert or replace into ratings (user_id, block_id, side, kind, value, created_at) values (?, ?, ?, ?, ?, ?)',
      args: [me.id, blockId, side, kind, value, now],
    })),
    'write',
  );
  return Response.json({ ok: true, saved: rows.length });
}
