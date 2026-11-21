import { buildContext, fetchWeather } from '@/lib/context';
import { designWalk } from '@/lib/planner';
import { bad } from '@/lib/session';
import { loadCommunity, world } from '@/lib/store';
import { DIMS, type LngLat, type Weights } from '@/lib/types';

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    start?: unknown;
    minutes?: unknown;
    weights?: Record<string, unknown>;
    when?: unknown;
    hills?: unknown;
    noStairs?: unknown;
  } | null;
  const start = body?.start;
  if (!Array.isArray(start) || start.length !== 2 || !start.every((n) => typeof n === 'number' && Number.isFinite(n)))
    return bad('Pick a starting point on the map.');
  const minutes = Number(body?.minutes);
  if (!(minutes >= 10 && minutes <= 240)) return bad('Walk length must be between 10 and 240 minutes.');
  const when = typeof body?.when === 'string' ? new Date(body.when) : new Date();
  if (Number.isNaN(when.getTime())) return bad('That start time is not a valid date.');

  const weights = {} as Weights;
  for (const d of DIMS) {
    const v = Number(body?.weights?.[d] ?? 1);
    weights[d] = Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 1;
  }

  const [w, community, weather] = await Promise.all([world(), loadCommunity(), fetchWeather(start as LngLat, when)]);
  const ctx = buildContext(start as LngLat, when, weather);
  const route = designWalk({
    blocks: w.blocks,
    graph: w.graph,
    community,
    start: start as LngLat,
    minutes,
    weights,
    ctx,
    hills: body?.hills === 'avoid' || body?.hills === 'seek' ? body.hills : 'ok',
    noStairs: body?.noStairs === true,
  });
  if (!route) return bad('No loop of that length fits from there. Try a longer walk or a start nearer the middle of the map.');
  return Response.json({ route, ctx });
}
