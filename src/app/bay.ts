import type { LngLat } from '@/lib/types';
import type { Vehicle } from './traffic';

/**
 * Boats on the bay: the Alcatraz ferry shuttling out from Pier 33, and the
 * Sausalito ferry heading for the Golden Gate. Each runs back and forth along
 * its course, waiting a little at each end.
 */

interface Run {
  id: number;
  course: LngLat[];
  /** Metres per second. */
  speed: number;
  /** Seconds waited at each landing. */
  dwell: number;
  s: number;
  forward: boolean;
  wait: number;
}

const RAD = Math.PI / 180;

export class Bay {
  private runs: Run[] = [
    { id: 9001, course: [[-122.4042, 37.8088], [-122.4075, 37.8135], [-122.4185, 37.8235], [-122.4212, 37.8262]], speed: 13, dwell: 12, s: 400, forward: true, wait: 0 },
    { id: 9002, course: [[-122.4118, 37.8112], [-122.4215, 37.8165], [-122.4475, 37.8262], [-122.4705, 37.8395]], speed: 15, dwell: 12, s: 2600, forward: false, wait: 0 },
  ];

  step(dt: number): Vehicle[] {
    return this.runs.map((run) => {
      const kx = 111320 * Math.cos(run.course[0][1] * RAD);
      const xy = run.course.map((c) => [(c[0] - run.course[0][0]) * kx, (c[1] - run.course[0][1]) * 111320]);
      const cum = [0];
      for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
      const length = cum[cum.length - 1];
      if (run.wait > 0) run.wait -= dt;
      else {
        // Ease off near each landing.
        const toEnd = run.forward ? length - run.s : run.s;
        run.s += (run.forward ? 1 : -1) * run.speed * Math.min(1, 0.25 + toEnd / 160) * dt;
        if (run.s >= length || run.s <= 0) {
          run.s = Math.max(0, Math.min(length, run.s));
          run.forward = !run.forward;
          run.wait = run.dwell;
        }
      }
      let i = 1;
      while (i < cum.length - 1 && cum[i] < run.s) i++;
      const f = (run.s - cum[i - 1]) / (cum[i] - cum[i - 1]);
      const x = xy[i - 1][0] + (xy[i][0] - xy[i - 1][0]) * f;
      const y = xy[i - 1][1] + (xy[i][1] - xy[i - 1][1]) * f;
      const sign = run.forward ? 1 : -1;
      const heading = (Math.atan2((xy[i][0] - xy[i - 1][0]) * sign, (xy[i][1] - xy[i - 1][1]) * sign) / RAD + 360) % 360;
      return { id: run.id, type: 'ferry' as const, paint: 0, at: [run.course[0][0] + x / kx, run.course[0][1] + y / 111320] as LngLat, heading };
    });
  }
}
