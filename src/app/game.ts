import type { LngLat, RouteLeg, WalkContext } from '@/lib/types';

/**
 * The game around the walks: streets you have walked stay lit on the map,
 * gems wait at the best spots of each route, a new walk is suggested every
 * day, and badges mark what you have done. Progress is kept in this browser.
 */

export interface WalkLog {
  date: string;
  lengthM: number;
  climbM: number;
  gems: number;
  golden: boolean;
  night: boolean;
  rain: boolean;
}

export interface GameState {
  /** Block id to the day it was first walked. */
  walked: Record<string, string>;
  walks: WalkLog[];
  gems: number;
  streak: number;
  bestStreak: number;
  /** The last day a walk was logged, as YYYY-MM-DD. */
  last: string;
}

export const EMPTY_GAME: GameState = { walked: {}, walks: [], gems: 0, streak: 0, bestStreak: 0, last: '' };
const KEY = 'bs.game';

export function loadGame(): GameState {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
    if (saved && typeof saved === 'object' && saved.walked && Array.isArray(saved.walks)) return { ...EMPTY_GAME, ...saved };
  } catch {
    /* nothing saved, or storage unavailable */
  }
  return EMPTY_GAME;
}

export function saveGame(state: GameState) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable */
  }
}

/** A calendar day in local time, offset by a number of days. */
export function day(offset = 0, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The streak as it stands today: it lapses if neither today nor yesterday has a walk. */
export function liveStreak(state: GameState, today = day()): number {
  return state.last === today || state.last === day(-1) ? state.streak : 0;
}

export interface Gem {
  /** Metres along the walk. */
  at: number;
  where: LngLat;
  kind: 'stairs' | 'view' | 'green' | 'life' | 'beauty';
  label: string;
}

export interface GemBlock {
  kind: string;
  score: number;
  /** views, greenery, architecture, street life: each 0..1 */
  dims: [number, number, number, number];
}

const metres = (a: LngLat, b: LngLat) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 111320);

/** Pick the spots on a walk worth a gem: stairways, views, the greenest and liveliest blocks. */
export function routeGems(legs: RouteLeg[], block: (id: string) => GemBlock | undefined): Gem[] {
  const found: (Gem & { worth: number })[] = [];
  let prev: LngLat | null = null;
  let d = 0;
  for (const leg of legs) {
    const start = d;
    let length = 0;
    const along: number[] = [];
    for (const c of leg.coords) {
      if (prev && (prev[0] !== c[0] || prev[1] !== c[1])) length += metres(prev, c);
      along.push(length);
      prev = c;
    }
    d += length;
    const b = block(leg.blockId);
    if (!b || length < 25) continue;
    // The gem sits half way along the block.
    let i = 1;
    while (i < along.length - 1 && along[i] < length / 2) i++;
    const span = along[i] - along[i - 1];
    const f = span ? (length / 2 - along[i - 1]) / span : 0;
    const where: LngLat = [leg.coords[i - 1][0] + (leg.coords[i][0] - leg.coords[i - 1][0]) * f, leg.coords[i - 1][1] + (leg.coords[i][1] - leg.coords[i - 1][1]) * f];
    const name = leg.name || 'this block';
    const options: [Gem['kind'], number, string][] = [
      ['stairs', b.kind === 'steps' ? 1.4 : 0, `Stairway: ${name}`],
      ['view', b.dims[0] >= 0.62 ? 0.6 + b.dims[0] * 0.6 : 0, `The view from ${name}`],
      ['green', b.dims[1] >= 0.7 ? 0.4 + b.dims[1] * 0.6 : 0, `Trees and gardens on ${name}`],
      ['life', b.dims[3] >= 0.7 ? 0.4 + b.dims[3] * 0.6 : 0, `Street life on ${name}`],
      ['beauty', 0.2 + b.score * 0.7, `A beautiful block of ${name}`],
    ];
    const best = options.sort((x, y) => y[1] - x[1])[0];
    found.push({ at: start + length / 2, where, kind: best[0], label: best[2], worth: best[1] });
  }
  // The best few, spaced out so they are spread over the walk.
  const want = Math.max(3, Math.min(9, Math.round(d / 420)));
  const chosen: (Gem & { worth: number })[] = [];
  for (const gem of found.sort((x, y) => y.worth - x.worth)) {
    if (chosen.length >= want) break;
    if (gem.at < 70 || gem.at > d - 40) continue;
    if (chosen.some((c) => Math.abs(c.at - gem.at) < 170)) continue;
    chosen.push(gem);
  }
  return chosen.sort((x, y) => x.at - y.at).map(({ at, where, kind, label }) => ({ at, where, kind, label }));
}

/** Record a walk as walked. Returns the new state and what this walk added. */
export function recordWalk(
  state: GameState,
  walk: { blockIds: string[]; lengthM: number; climbM: number; gems: number; ctx: WalkContext },
  today = day(),
): { state: GameState; newStreets: number } {
  const walked = { ...state.walked };
  let newStreets = 0;
  for (const id of walk.blockIds) {
    if (walked[id]) continue;
    walked[id] = today;
    newStreets++;
  }
  const streak = state.last === today ? Math.max(1, state.streak) : state.last === day(-1) ? state.streak + 1 : 1;
  return {
    newStreets,
    state: {
      walked,
      walks: [...state.walks, { date: today, lengthM: Math.round(walk.lengthM), climbM: Math.round(walk.climbM), gems: walk.gems, golden: walk.ctx.goldenHour, night: walk.ctx.night, rain: walk.ctx.raining }].slice(-400),
      gems: state.gems + walk.gems,
      streak,
      bestStreak: Math.max(state.bestStreak, streak),
      last: today,
    },
  };
}

export interface Coverage {
  /** Metres of street walked, and metres there are. */
  metres: number;
  total: number;
  fraction: number;
  stairs: number;
  stairsTotal: number;
}

export function coverage(state: GameState, blocks: { id: string; kind: string; len: number }[]): Coverage {
  let metres = 0;
  let total = 0;
  let stairs = 0;
  let stairsTotal = 0;
  for (const b of blocks) {
    total += b.len;
    const got = !!state.walked[b.id];
    if (got) metres += b.len;
    if (b.kind === 'steps') {
      stairsTotal++;
      if (got) stairs++;
    }
  }
  return { metres, total, fraction: total ? metres / total : 0, stairs, stairsTotal };
}

export interface Badge {
  id: string;
  name: string;
  how: string;
  earned: boolean;
  /** Progress toward it, when it can be counted. */
  progress?: string;
}

export function badges(state: GameState, cover: Coverage): Badge[] {
  const any = (test: (w: WalkLog) => boolean) => state.walks.some(test);
  const pct = Math.floor(cover.fraction * 100);
  return [
    { id: 'first', name: 'First steps', how: 'Log your first walk', earned: state.walks.length > 0 },
    { id: 'streak3', name: 'Three in a row', how: 'Walk three days running', earned: state.bestStreak >= 3, progress: `${Math.min(state.bestStreak, 3)} of 3` },
    { id: 'streak7', name: 'A full week', how: 'Walk seven days running', earned: state.bestStreak >= 7, progress: `${Math.min(state.bestStreak, 7)} of 7` },
    { id: 'gems25', name: 'Gem collector', how: 'Collect 25 gems', earned: state.gems >= 25, progress: `${Math.min(state.gems, 25)} of 25` },
    { id: 'stairs', name: 'Stair master', how: 'Walk every stairway on the map', earned: cover.stairsTotal > 0 && cover.stairs >= cover.stairsTotal, progress: `${cover.stairs} of ${cover.stairsTotal}` },
    { id: 'local', name: 'Local', how: 'Walk 5% of the streets', earned: cover.fraction >= 0.05, progress: `${Math.min(pct, 5)}% of 5%` },
    { id: 'mapper', name: 'Cartographer', how: 'Walk a quarter of the streets', earned: cover.fraction >= 0.25, progress: `${Math.min(pct, 25)}% of 25%` },
    { id: 'climb', name: 'Hill climber', how: 'Climb 500 feet in one walk', earned: any((w) => w.climbM >= 152) },
    { id: 'long', name: 'The long way round', how: 'Walk three miles in one go', earned: any((w) => w.lengthM >= 4828) },
    { id: 'golden', name: 'Golden hour', how: 'Walk in the hour around sunrise or sunset', earned: any((w) => w.golden) },
    { id: 'night', name: 'Night owl', how: 'Walk after dark', earned: any((w) => w.night) },
    { id: 'rain', name: 'Rain or shine', how: 'Walk in the rain', earned: any((w) => w.rain) },
  ];
}

export interface Daily {
  title: string;
  blurb: string;
  mood: 'balanced' | 'views' | 'quiet' | 'lively';
  minutes: number;
  hills: 'avoid' | 'ok' | 'seek';
}

const THEMES: Omit<Daily, 'minutes'>[] = [
  { title: 'The grand tour', blurb: 'A bit of everything the hill does well', mood: 'balanced', hills: 'ok' },
  { title: 'The view hunt', blurb: 'Hilltops, stairways and the bay', mood: 'views', hills: 'seek' },
  { title: 'The quiet loop', blurb: 'Trees, gardens and little traffic', mood: 'quiet', hills: 'ok' },
  { title: 'The cafe circuit', blurb: 'Shopfronts, people and something to drink', mood: 'lively', hills: 'avoid' },
  { title: 'The stair climb', blurb: 'Up the steep way for the big views', mood: 'views', hills: 'seek' },
  { title: 'The easy stroll', blurb: 'Green streets, gentle grades', mood: 'quiet', hills: 'avoid' },
  { title: 'The architecture walk', blurb: 'The best all-round blocks, as they come', mood: 'balanced', hills: 'seek' },
];

/** Today's suggested walk: the same for everyone on a given day, different every day. */
export function dailyWalk(date = day()): Daily {
  let h = 2166136261;
  for (const ch of date) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const theme = THEMES[h % THEMES.length];
  return { ...theme, minutes: 30 + ((h >>> 8) % 5) * 5 };
}
