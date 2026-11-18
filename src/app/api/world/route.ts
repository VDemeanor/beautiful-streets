import { communityScore, finalScore } from '@/lib/scoring';
import { currentUser } from '@/lib/session';
import { loadCommunity, world } from '@/lib/store';
import { DEFAULT_WEIGHTS } from '@/lib/types';

export const dynamic = 'force-dynamic';

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r2 = (x: number) => Math.round(x * 100) / 100;

export async function GET() {
  try {
    const [w, community, me] = await Promise.all([world(), loadCommunity(), currentUser()]);
    const blocks = w.blocks.map((b) => {
      const c = community.get(b.id);
      return {
        id: b.id,
        name: b.name,
        coords: b.coords.map((p) => [r6(p[0]), r6(p[1])]),
        len: Math.round(b.len),
        bearing: Math.round(b.bearing),
        score: r2(finalScore(b, DEFAULT_WEIGHTS, c)),
        votes: Math.round(communityScore(c)?.n ?? 0),
        dims: [r2(b.prior.views), r2(b.prior.green), r2(b.prior.arch), r2(b.prior.energy)],
      };
    });
    return Response.json({ blocks, me, source: w.source });
  } catch (err) {
    return Response.json(
      { error: `Streets are not loaded yet. ${err instanceof Error ? err.message : String(err)}` },
      { status: 503 },
    );
  }
}
