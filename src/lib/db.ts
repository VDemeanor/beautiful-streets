import { createClient, type Client } from '@libsql/client';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = [
  `create table if not exists meta (key text primary key, value text not null)`,
  `create table if not exists users (
     id text primary key, name text not null, created_at integer not null)`,
  `create table if not exists blocks (id text primary key, data text not null)`,
  `create table if not exists elo (
     block_id text primary key, rating real not null, n integer not null)`,
  `create table if not exists matchups (
     id integer primary key autoincrement, user_id text not null,
     winner text not null, loser text not null, created_at integer not null)`,
  // side: L, R (relative to the block's stored direction) or B for the whole block.
  // kind: rate (stars after a walk), thumb (tap on the map) or side (which side
  // was nicer: 1 for the preferred side, 0 for the other). value is 0..1.
  `create table if not exists ratings (
     user_id text not null, block_id text not null, side text not null,
     kind text not null, value real not null, created_at integer not null,
     primary key (user_id, block_id, side, kind))`,
  `create index if not exists ratings_block on ratings (block_id)`,
  `create table if not exists walks (
     id text primary key, user_id text not null, name text not null,
     data text not null, created_at integer not null)`,
];

const g = globalThis as unknown as { __bsDb?: Promise<Client> };

export function db(): Promise<Client> {
  if (!g.__bsDb) {
    g.__bsDb = (async () => {
      const url = process.env.DATABASE_URL || 'file:./data/beautiful-streets.db';
      if (url.startsWith('file:')) fs.mkdirSync(path.dirname(url.slice(5)), { recursive: true });
      const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
      for (const sql of SCHEMA) await client.execute(sql);
      return client;
    })();
  }
  return g.__bsDb;
}
