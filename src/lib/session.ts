import { cookies } from 'next/headers';
import { db } from './db';

const COOKIE = 'bs_uid';

export interface Me {
  id: string;
  name: string;
}

export async function currentUser(): Promise<Me | null> {
  const id = (await cookies()).get(COOKIE)?.value;
  if (!id) return null;
  const res = await (await db()).execute({ sql: 'select id, name from users where id = ?', args: [id] });
  const row = res.rows[0];
  return row ? { id: row.id as string, name: row.name as string } : null;
}

export async function join(name: string): Promise<Me> {
  const id = crypto.randomUUID();
  await (await db()).execute({
    sql: 'insert into users (id, name, created_at) values (?, ?, ?)',
    args: [id, name, Date.now()],
  });
  (await cookies()).set(COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
  });
  return { id, name };
}

export const unauthorized = () => Response.json({ error: 'Join with a name before voting.' }, { status: 401 });
export const bad = (error: string) => Response.json({ error }, { status: 400 });
