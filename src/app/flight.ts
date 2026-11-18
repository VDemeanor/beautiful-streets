import * as maplibregl from 'maplibre-gl';
import { bearing as bearingBetween, haversine } from '@/lib/geo';
import type { LngLat, RouteLeg } from '@/lib/types';
import { CAMERA_3D } from './scene';

/**
 * The film of a walk. A flight has three acts:
 *   intro   an establishing arc high over the whole route, then a crane down to the start
 *   travel  the walk itself, shot by a camera rig (or by the director, who cuts between rigs)
 *   finale  a slow circle around the finish, then a pull-back to the overview
 * It can be paused, scrubbed, sped up and re-shot with a different rig at any time.
 */

export type Rig = 'director' | 'chase' | 'side' | 'drone' | 'orbit';
export const RIGS: { id: Rig; label: string; hint: string }[] = [
  { id: 'director', label: 'Director', hint: 'Cuts between all the angles' },
  { id: 'chase', label: 'Street', hint: 'Low behind you, looking ahead' },
  { id: 'side', label: 'Tracking', hint: 'Alongside, facing the houses' },
  { id: 'drone', label: 'Drone', hint: 'High above, panning slowly' },
  { id: 'orbit', label: 'Orbit', hint: 'Circling you as you walk' },
];

export interface FlightState {
  playing: boolean;
  phase: 'intro' | 'travel' | 'finale' | 'done';
  /** 0..1 along the walk. */
  progress: number;
  /** Index of the route leg under the walker. */
  leg: number;
  /** Increases by one on every hard cut, so the screen can blink like a film cut. */
  cuts: number;
  rig: Rig;
  speed: number;
}

interface Shot {
  look: LngLat;
  bearing: number;
  pitch: number;
  zoom: number;
  lens: number;
}

const NORMAL_LENS = 36.87;
const SHOT_METRES = 170;
/** The director's running order. Tracking shots alternate sides of the street. */
const SEQUENCE: Exclude<Rig, 'director'>[] = ['chase', 'side', 'drone', 'chase', 'orbit', 'side', 'chase', 'drone'];

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const turn = (from: number, to: number, t: number) => from + (((to - from + 540) % 360) - 180) * t;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Flight {
  private pts: LngLat[] = [];
  private cum: number[] = [0];
  private legEnds: number[] = [];
  private total = 0;
  private raf = 0;
  private last = 0;
  private phaseMs = 0;
  private d = 0;
  private cam: Shot | null = null;
  private shotIndex = -1;
  private from: Shot;
  private walker: maplibregl.Marker;
  private state: FlightState;
  private introMs: number;
  private finaleMs: number;

  constructor(
    private map: maplibregl.Map,
    legs: RouteLeg[],
    private overview: { center: LngLat; zoom: number },
    private onState: (s: FlightState) => void,
    calm: boolean,
  ) {
    for (const l of legs) {
      for (const c of l.coords) {
        const prev = this.pts[this.pts.length - 1];
        if (prev && prev[0] === c[0] && prev[1] === c[1]) continue;
        if (prev) this.cum.push(this.cum[this.cum.length - 1] + haversine(prev, c));
        this.pts.push(c);
      }
      this.legEnds.push(this.cum[this.cum.length - 1]);
    }
    this.total = this.cum[this.cum.length - 1];
    this.introMs = calm ? 0 : 7200;
    this.finaleMs = calm ? 0 : 8600;
    const c = map.getCenter();
    this.from = { look: [c.lng, c.lat], bearing: map.getBearing(), pitch: map.getPitch(), zoom: map.getZoom(), lens: NORMAL_LENS };

    const orb = document.createElement('div');
    orb.className = 'walker';
    orb.innerHTML =
      '<span class="walker-glow"></span><span class="walker-core"></span>' +
      Array.from({ length: 5 }, (_, i) => `<i class="spark" style="--i:${i}"></i>`).join('');
    this.walker = new maplibregl.Marker({ element: orb, opacityWhenCovered: '1' }).setLngLat(this.at(0)).addTo(map);

    this.state = { playing: false, phase: this.introMs ? 'intro' : 'travel', progress: 0, leg: 0, cuts: 0, rig: 'director', speed: 1 };
  }

  get valid() {
    return this.total > 0;
  }

  private at(d: number): LngLat {
    const x = clamp(d, 0, this.total);
    let i = 1;
    while (i < this.cum.length - 1 && this.cum[i] < x) i++;
    const span = this.cum[i] - this.cum[i - 1];
    const f = span === 0 ? 0 : (x - this.cum[i - 1]) / span;
    return [lerp(this.pts[i - 1][0], this.pts[i][0], f), lerp(this.pts[i - 1][1], this.pts[i][1], f)];
  }

  /** Direction of travel, looking a little ahead so corners are anticipated. */
  private heading(d: number): number {
    const a = this.at(clamp(d - 8, 0, this.total));
    const b = this.at(clamp(d + 40, 0, this.total));
    return a[0] === b[0] && a[1] === b[1] ? 0 : bearingBetween(a, b);
  }

  /** What a rig wants the camera to do at distance d, t of the way through its shot. */
  private shot(rig: Exclude<Rig, 'director'>, d: number, t: number, flip: boolean): Shot {
    const h = this.heading(d);
    switch (rig) {
      case 'chase':
        return { look: this.at(d + 18), bearing: h, pitch: 79, zoom: 17.8, lens: 54 };
      case 'side':
        return { look: this.at(d), bearing: h + (flip ? -82 : 82), pitch: 71, zoom: 17.45 + 0.25 * t, lens: 50 };
      case 'drone':
        return { look: this.at(d + 45), bearing: h - 28 + 56 * t, pitch: 56, zoom: 16.45, lens: 40 };
      case 'orbit':
        return { look: this.at(d), bearing: h + 40 + 220 * t, pitch: 73, zoom: 17.4, lens: 50 };
    }
  }

  private apply(s: Shot) {
    this.map.setVerticalFieldOfView?.(s.lens);
    this.map.jumpTo({ center: s.look, bearing: s.bearing, pitch: s.pitch, zoom: s.zoom });
  }

  private emit(patch: Partial<FlightState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  private legAt(d: number): number {
    let i = 0;
    while (i < this.legEnds.length - 1 && this.legEnds[i] < d) i++;
    return i;
  }

  private frame = (now: number) => {
    const dt = Math.min(now - this.last, 80);
    this.last = now;
    const s = this.state;

    if (s.phase === 'intro') {
      this.phaseMs += dt;
      const arcMs = this.introMs * 0.62;
      const first = this.shot('chase', 0, 0, false);
      const high: Shot = { look: this.overview.center, bearing: CAMERA_3D.bearing + 55, pitch: 66, zoom: this.overview.zoom + 0.35, lens: NORMAL_LENS };
      if (this.phaseMs < arcMs) {
        // Establishing shot: drift in an arc over the whole walk.
        const t = this.phaseMs / arcMs;
        const startArc: Shot = { ...high, bearing: CAMERA_3D.bearing - 35, pitch: 52, zoom: this.overview.zoom - 0.25 };
        const k = ease(Math.min(1, t * 4)); // blend out of wherever the camera was
        const arc: Shot = { look: high.look, bearing: lerp(startArc.bearing, high.bearing, t), pitch: lerp(startArc.pitch, high.pitch, t), zoom: lerp(startArc.zoom, high.zoom, t), lens: NORMAL_LENS };
        this.apply({
          look: [lerp(this.from.look[0], arc.look[0], k), lerp(this.from.look[1], arc.look[1], k)],
          bearing: turn(this.from.bearing, arc.bearing, k),
          pitch: lerp(this.from.pitch, arc.pitch, k),
          zoom: lerp(this.from.zoom, arc.zoom, k),
          lens: NORMAL_LENS,
        });
      } else if (this.phaseMs < this.introMs) {
        // Crane down to the start.
        const t = ease((this.phaseMs - arcMs) / (this.introMs - arcMs));
        this.apply({
          look: [lerp(high.look[0], first.look[0], t), lerp(high.look[1], first.look[1], t)],
          bearing: turn(high.bearing, first.bearing, t),
          pitch: lerp(high.pitch, first.pitch, t),
          zoom: lerp(high.zoom, first.zoom, t),
          lens: lerp(NORMAL_LENS, first.lens, t),
        });
      } else {
        this.cam = first;
        this.shotIndex = 0;
        this.emit({ phase: 'travel' });
      }
    } else if (s.phase === 'travel') {
      // About 42 m of walk per second at normal speed.
      this.d = Math.min(this.total, this.d + (dt / 1000) * 42 * s.speed);
      const index = Math.floor(this.d / SHOT_METRES);
      const t = (this.d % SHOT_METRES) / SHOT_METRES;
      const rig = s.rig === 'director' ? SEQUENCE[index % SEQUENCE.length] : s.rig;
      const want = this.shot(rig, this.d, t, index % 2 === 1);
      let cuts = s.cuts;
      if (!this.cam || (s.rig === 'director' && index !== this.shotIndex)) {
        // A new shot from the director is a hard cut, like a film edit.
        if (this.cam) cuts++;
        this.cam = want;
        this.shotIndex = index;
      } else {
        // Within a shot the camera glides toward where the rig wants it.
        const k = 1 - Math.exp(-dt / 420);
        this.cam = {
          look: want.look,
          bearing: turn(this.cam.bearing, want.bearing, k),
          pitch: lerp(this.cam.pitch, want.pitch, k),
          zoom: lerp(this.cam.zoom, want.zoom, k),
          lens: lerp(this.cam.lens, want.lens, k),
        };
      }
      this.apply(this.cam);
      this.walker.setLngLat(this.at(this.d));
      const progress = this.d / this.total;
      if (this.d >= this.total) {
        this.phaseMs = 0;
        this.emit({ progress: 1, leg: this.legEnds.length - 1, cuts, phase: this.finaleMs ? 'finale' : 'done', playing: !!this.finaleMs });
        if (!this.finaleMs) return this.finish();
      } else this.emit({ progress, leg: this.legAt(this.d), cuts });
    } else if (s.phase === 'finale') {
      this.phaseMs += dt;
      const end = this.at(this.total);
      const orbitMs = this.finaleMs * 0.66;
      const base = this.cam ?? this.shot('chase', this.total, 1, false);
      const hero: Shot = { look: end, bearing: base.bearing + 300, pitch: 62, zoom: 16.7, lens: 44 };
      if (this.phaseMs < orbitMs) {
        const t = ease(this.phaseMs / orbitMs);
        this.apply({ look: end, bearing: lerp(base.bearing, hero.bearing, t), pitch: lerp(base.pitch, hero.pitch, t), zoom: lerp(base.zoom, hero.zoom, t), lens: lerp(base.lens, hero.lens, t) });
      } else if (this.phaseMs < this.finaleMs) {
        // Pull back and up until the whole walk is in view again.
        const t = ease((this.phaseMs - orbitMs) / (this.finaleMs - orbitMs));
        this.apply({
          look: [lerp(end[0], this.overview.center[0], t), lerp(end[1], this.overview.center[1], t)],
          bearing: turn(hero.bearing, CAMERA_3D.bearing, t),
          pitch: lerp(hero.pitch, CAMERA_3D.pitch, t),
          zoom: lerp(hero.zoom, this.overview.zoom, t),
          lens: lerp(hero.lens, NORMAL_LENS, t),
        });
      } else {
        return this.finish();
      }
    }
    if (this.state.playing) this.raf = requestAnimationFrame(this.frame);
  };

  private finish() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.map.setVerticalFieldOfView?.(NORMAL_LENS);
    this.emit({ phase: 'done', playing: false });
  }

  play() {
    if (this.state.playing || this.state.phase === 'done') return;
    this.last = performance.now();
    this.emit({ playing: true });
    this.raf = requestAnimationFrame(this.frame);
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.emit({ playing: false });
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  /** Jump to a point in the walk. Skips the intro; the next frame is a fresh shot. */
  seek(progress: number) {
    this.d = clamp(progress, 0, 1) * this.total;
    this.cam = null;
    this.shotIndex = Math.floor(this.d / SHOT_METRES);
    this.phaseMs = 0;
    this.emit({ phase: 'travel', progress: this.d / this.total, leg: this.legAt(this.d) });
    if (!this.state.playing) {
      const index = this.shotIndex;
      const rig = this.state.rig === 'director' ? SEQUENCE[index % SEQUENCE.length] : this.state.rig;
      this.cam = this.shot(rig, this.d, (this.d % SHOT_METRES) / SHOT_METRES, index % 2 === 1);
      this.apply(this.cam);
      this.walker.setLngLat(this.at(this.d));
    }
  }

  setSpeed(speed: number) {
    this.emit({ speed });
  }

  setRig(rig: Rig) {
    if (this.state.phase === 'intro') this.seek(0);
    this.emit({ rig });
    if (!this.state.playing && this.state.phase === 'travel') this.seek(this.state.progress);
  }

  /** End the film and put the camera's lens back. Does not move the camera. */
  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.map.stop();
    this.map.setVerticalFieldOfView?.(NORMAL_LENS);
    this.walker.remove();
  }
}
