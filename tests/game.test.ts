import { describe, expect, it } from 'vitest';
import { badges, coverage, dailyWalk, EMPTY_GAME, liveStreak, recordWalk, routeGems } from '../src/app/game';
import { makeGround } from '../src/app/ground';
import type { RouteLeg, WalkContext } from '../src/lib/types';

const ctx = { goldenHour: false, night: false, raining: false } as WalkContext;
const leg = (blockId: string, x: number): RouteLeg => ({
  blockId, name: `Street ${blockId}`, coords: [[-122.42 + x * 0.002, 37.8], [-122.42 + (x + 1) * 0.002, 37.8]],
  len: 176, side: 'L', sideLabel: 'north', reason: '', score: 0.5, forward: true, step: 0, elev: 50,
});

describe('game', () => {
  it('builds a streak over consecutive days and lapses after a gap', () => {
    const walk = { blockIds: ['a', 'b'], lengthM: 2000, climbM: 40, gems: 3, ctx };
    const one = recordWalk(EMPTY_GAME, walk, '2026-11-20');
    expect(one.newStreets).toBe(2);
    const two = recordWalk(one.state, { ...walk, blockIds: ['b', 'c'] }, '2026-11-20');
    expect(two.newStreets).toBe(1);
    expect(two.state.gems).toBe(6);
    expect(two.state.streak).toBe(1);
    // A streak last fed long ago no longer counts.
    expect(liveStreak({ ...one.state, last: '2020-01-01', streak: 4 }, '2026-11-21')).toBe(0);
    expect(liveStreak({ ...one.state, last: '2026-11-21', streak: 4 }, '2026-11-21')).toBe(4);
  });

  it('counts coverage and awards badges from it', () => {
    const blocks = [{ id: 'a', kind: 'residential', len: 100 }, { id: 'b', kind: 'steps', len: 100 }, { id: 'c', kind: 'residential', len: 200 }];
    const state = recordWalk(EMPTY_GAME, { blockIds: ['a', 'b'], lengthM: 5000, climbM: 200, gems: 2, ctx: { ...ctx, night: true } }).state;
    const cover = coverage(state, blocks);
    expect(cover.fraction).toBeCloseTo(0.5);
    const earned = new Set(badges(state, cover).filter((b) => b.earned).map((b) => b.id));
    for (const id of ['first', 'stairs', 'local', 'mapper', 'climb', 'long', 'night']) expect(earned.has(id)).toBe(true);
    expect(earned.has('rain')).toBe(false);
  });

  it('places gems in walking order, spaced apart, favouring stairways and views', () => {
    const legs = Array.from({ length: 12 }, (_, i) => leg(String(i), i));
    const gems = routeGems(legs, (id) => ({ kind: id === '5' ? 'steps' : 'residential', score: 0.4, dims: [id === '8' ? 0.9 : 0.2, 0.2, 0.2, 0.2] }));
    expect(gems.length).toBeGreaterThanOrEqual(3);
    expect(gems.some((g) => g.kind === 'stairs')).toBe(true);
    expect(gems.some((g) => g.kind === 'view')).toBe(true);
    for (let i = 1; i < gems.length; i++) expect(gems[i].at - gems[i - 1].at).toBeGreaterThanOrEqual(170);
  });

  it('suggests the same daily walk all day and a valid one every day', () => {
    expect(dailyWalk('2026-11-21')).toEqual(dailyWalk('2026-11-21'));
    for (let d = 1; d <= 28; d++) {
      const w = dailyWalk(`2026-11-${String(d).padStart(2, '0')}`);
      expect(w.minutes).toBeGreaterThanOrEqual(30);
      expect(w.minutes).toBeLessThanOrEqual(50);
    }
  });
});

describe('ground', () => {
  it('reads height off the slope of the nearest block', () => {
    // 176 m long, rising 10% from west to east, 50 m at its middle.
    const ground = makeGround([{ coords: [[-122.42, 37.8], [-122.418, 37.8]], len: 176, elev: 50, grade: 0.1 }]);
    expect(ground([-122.419, 37.8])).toBeCloseTo(50, 0);
    expect(ground([-122.42, 37.8001])).toBeCloseTo(41.2, 0);
    expect(ground([-122.418, 37.8])).toBeCloseTo(58.8, 0);
  });
});
