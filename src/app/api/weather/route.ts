import { buildContext, fetchWeather } from '@/lib/context';
import type { LngLat } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Conditions right now at a point: weather, sun position and what they mean for a walk. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const lng = Number(url.searchParams.get('lng'));
  const lat = Number(url.searchParams.get('lat'));
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return Response.json({ error: 'Give lng and lat.' }, { status: 400 });
  const at: LngLat = [lng, lat];
  const now = new Date();
  const ctx = buildContext(at, now, await fetchWeather(at, now));
  return Response.json({ ctx }, { headers: { 'Cache-Control': 'public, max-age=600' } });
}
