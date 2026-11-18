import { bad, currentUser, join } from '@/lib/session';

export async function POST(req: Request) {
  const existing = await currentUser();
  if (existing) return Response.json({ me: existing });
  const body = (await req.json().catch(() => null)) as { name?: unknown } | null;
  const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 40) : '';
  if (name.length < 2) return bad('Enter a name with at least 2 characters.');
  return Response.json({ me: await join(name) });
}
