import { db } from '@/lib/db';
import { bad, currentUser, unauthorized } from '@/lib/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const me = await currentUser();
  if (!me) return Response.json({ walks: [] });
  const res = await (await db()).execute({
    sql: 'select id, name, data, created_at from walks where user_id = ? order by created_at desc limit 50',
    args: [me.id],
  });
  return Response.json({
    walks: res.rows.map((r) => ({ id: r.id, name: r.name, createdAt: Number(r.created_at), ...JSON.parse(r.data as string) })),
  });
}

export async function POST(req: Request) {
  const me = await currentUser();
  if (!me) return unauthorized();
  const body = (await req.json().catch(() => null)) as { name?: unknown; route?: unknown; ctx?: unknown } | null;
  if (!body?.route || typeof body.route !== 'object') return bad('There is no walk to save.');
  const data = JSON.stringify({ route: body.route, ctx: body.ctx ?? null });
  if (data.length > 400_000) return bad('That walk is too large to save.');
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 80) : 'Walk';
  const id = crypto.randomUUID();
  await (await db()).execute({
    sql: 'insert into walks (id, user_id, name, data, created_at) values (?, ?, ?, ?, ?)',
    args: [id, me.id, name, data, Date.now()],
  });
  return Response.json({ id });
}
