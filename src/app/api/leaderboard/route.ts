import { db } from '@/lib/db';
import { communityScore, finalScore } from '@/lib/scoring';
import { loadCommunity, world } from '@/lib/store';
import { DEFAULT_WEIGHTS } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  const [w, community] = await Promise.all([world(), loadCommunity()]);
  const streets = new Map<string, { len: number; sum: number; votes: number }>();
  for (const b of w.blocks) {
    if (b.name === 'Unnamed street' || b.name === 'Alley' || b.name === 'Footpath') continue;
    const c = community.get(b.id);
    const s = streets.get(b.name) ?? { len: 0, sum: 0, votes: 0 };
    s.len += b.len;
    s.sum += b.len * finalScore(b, DEFAULT_WEIGHTS, c);
    s.votes += communityScore(c)?.n ?? 0;
    streets.set(b.name, s);
  }
  const top = [...streets.entries()]
    .filter(([, s]) => s.len >= 150)
    .map(([name, s]) => ({ name, score: Math.round((s.sum / s.len) * 100), votes: Math.round(s.votes), lengthM: Math.round(s.len) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);

  const voters = (
    await (await db()).execute(
      `select u.name as name, count(*) as n from (
         select user_id from matchups union all select user_id from ratings
       ) v join users u on u.id = v.user_id group by u.id order by n desc limit 10`,
    )
  ).rows.map((r) => ({ name: r.name as string, votes: Number(r.n) }));
  return Response.json({ streets: top, voters });
}
