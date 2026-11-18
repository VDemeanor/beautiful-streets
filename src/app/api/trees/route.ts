import fs from 'node:fs';

/** Street trees for the 3D scene, saved by the "Import streets" workflow. */
let cache: string | null = null;

export async function GET() {
  if (cache === null) {
    try {
      cache = fs.readFileSync('data/trees.json', 'utf8');
    } catch {
      cache = '[]';
    }
  }
  return new Response(`{"trees":${cache}}`, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
