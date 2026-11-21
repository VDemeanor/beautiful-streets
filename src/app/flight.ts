import * as maplibregl from 'maplibre-gl';
import { bearing as bearingBetween, haversine } from '@/lib/geo';
import type { LngLat, RouteLeg } from '@/lib/types';
import { CAMERA_3D } from './scene';
import { drawWalker } from './walker';

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
  /** Metres walked, and the length of the whole walk. */
  metres: number;
  total: number;
  /** Index of the route leg under the walker. */
  leg: number;
  /** Increases by one on every hard cut, so the screen can blink like a film cut. */
  cuts: number;
  rig: Rig;
  speed: number;
}

export interface Shot {
  look: LngLat;
  bearing: number;
  pitch: number;
  zoom: number;
  lens: number;
}

/**
 * Whatever the film is shot on. The built-in 3D map and the photoreal city
 * both implement this, so the same film plays on either.
 */
export interface Stage {
  /** Where the camera is right now. */
  current(): Shot;
  /** Point the camera. */
  apply(shot: Shot): void;
  /** Move the walker and face them along a compass heading, or remove them with null. */
  walker(at: LngLat | null, heading?: number): void;
  /** Ground height in metres, if the stage can tell; used to keep the camera above hills. */
  ground?(at: LngLat): number;
  /** Height of the picture in CSS pixels. */
  height(): number;
  /** Cancel any camera motion in progress and restore the normal lens. */
  settle(): void;
  /** How close the street camera can usefully get: metres from the walker, and its tilt. */
  street?: { distance: number; pitch: number };
  /** How fast the film may travel here, as a share of the normal pace. The real city needs time to load in. */
  pace?: number;
  /** True while the stage is still loading detail for the current view; the film slows to wait for it. */
  busy?(): boolean;
  /** Whether the camera can see what it is looking at from this shot, or something is in the way. */
  sees?(shot: Shot): boolean;
  /** Show this much of the planned path (drawn on during the opening shot). */
  reveal?(path: LngLat[]): void;
  /** The part already walked, drawn brighter over the plan. */
  trail?(path: LngLat[]): void;
}

/** Distance from the camera to what it looks at, in metres. */
export function cameraDistance(shot: Shot, pictureHeight: number): number {
  const rad = Math.PI / 180;
  const metresPerPixel = (78271.5 * Math.cos(shot.look[1] * rad)) / 2 ** shot.zoom;
  return (pictureHeight / 2 / Math.tan((shot.lens * rad) / 2)) * metresPerPixel;
}

/** The stage for the built-in MapLibre scene. */
export function mapStage(map: maplibregl.Map): Stage {
  let orb: maplibregl.Marker | null = null;
  return {
    current() {
      const c = map.getCenter();
      return { look: [c.lng, c.lat], bearing: map.getBearing(), pitch: map.getPitch(), zoom: map.getZoom(), lens: map.getVerticalFieldOfView?.() ?? NORMAL_LENS };
    },
    apply(s) {
      map.setVerticalFieldOfView?.(s.lens);
      map.jumpTo({ center: s.look, bearing: s.bearing, pitch: s.pitch, zoom: s.zoom });
    },
    walker(at, heading = 0) {
      if (!at) {
        orb?.remove();
        orb = null;
        drawWalker(map, null);
        return;
      }
      // Up close the figure is life size; from further off it grows so it can still be found.
      const c = map.getCenter();
      const distance = cameraDistance({ look: [c.lng, c.lat], bearing: 0, pitch: 0, zoom: map.getZoom(), lens: map.getVerticalFieldOfView?.() ?? NORMAL_LENS }, map.getContainer().getBoundingClientRect().height);
      drawWalker(map, at, heading, clamp(distance / 26, 1.15, 9), (performance.now() / 1000) * 2 * Math.PI * 1.7);
      if (!orb) {
        // A pool of light at their feet.
        const el = document.createElement('div');
        el.className = 'walker';
        el.innerHTML = '<span class="walker-glow"></span>' + Array.from({ length: 4 }, (_, i) => `<i class="spark" style="--i:${i}"></i>`).join('');
        orb = new maplibregl.Marker({ element: el, opacityWhenCovered: '1' }).setLngLat(at).addTo(map);
      } else orb.setLngLat(at);
    },
    ground: (at) => map.queryTerrainElevation(at) ?? 0,
    height: () => map.getContainer().getBoundingClientRect().height,
    settle() {
      map.stop();
      map.setVerticalFieldOfView?.(NORMAL_LENS);
    },
  };
}

export const NORMAL_LENS = 36.87;
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
  private pitchLimit: number | null = null;
  private lastTrail = 0;
  private travelMs = 0;
  private faced = 0;
  private frames = 0;
  private sight = 90;
  private flow = 1;
  private from: Shot;
  private state: FlightState;
  private introMs: number;
  private finaleMs: number;

  constructor(
    private stage: Stage,
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
    this.from = stage.current();
    this.faced = this.total > 3 ? bearingBetween(this.at(0), this.at(3)) : 0;
    stage.walker(this.at(0), this.faced);

    this.state = { playing: false, phase: this.introMs ? 'intro' : 'travel', progress: 0, metres: 0, total: this.total, leg: 0, cuts: 0, rig: 'director', speed: 1 };
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

  /** The path from the start up to distance d. */
  private upTo(d: number): LngLat[] {
    const x = clamp(d, 0, this.total);
    const out: LngLat[] = [];
    for (let i = 0; i < this.pts.length && this.cum[i] <= x; i++) out.push(this.pts[i]);
    out.push(this.at(x));
    return out;
  }

  /** How sharply the route bends just ahead, in degrees. */
  private bend(d: number): number {
    const a = this.at(clamp(d - 6, 0, this.total));
    const b = this.at(clamp(d + 6, 0, this.total));
    const c = this.at(clamp(d + 22, 0, this.total));
    if ((a[0] === b[0] && a[1] === b[1]) || (b[0] === c[0] && b[1] === c[1])) return 0;
    return Math.abs((((bearingBetween(b, c) - bearingBetween(a, b) + 540) % 360) - 180));
  }

  /** Which way the walker faces: the direction of the path right under their feet. */
  private facing(d: number): number {
    const a = this.at(clamp(d - 1.5, 0, this.total));
    const b = this.at(clamp(d + 1.5, 0, this.total));
    const want = a[0] === b[0] && a[1] === b[1] ? this.faced : bearingBetween(a, b);
    // Turn through corners rather than snapping round.
    this.faced = turn(this.faced, want, 0.25);
    return this.faced;
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
      case 'chase': {
        // Down in the street: a few metres above the pavement, a short way behind the walker.
        const look = this.at(d + 9);
        const near = this.stage.street ?? { distance: 30, pitch: 79 };
        return { look, bearing: h, pitch: near.pitch, zoom: this.zoomFor(near.distance, 58, look), lens: 58 };
      }
      case 'side': {
        const look = this.at(d);
        return { look, bearing: h + (flip ? -82 : 82), pitch: this.stage.street ? 60 : 74, zoom: this.zoomFor((this.stage.street ? 95 : 62) - 8 * t, 52, look), lens: 52 };
      }
      case 'drone':
        return { look: this.at(d + 45), bearing: h - 28 + 56 * t, pitch: 56, zoom: 16.45, lens: 40 };
      case 'orbit':
        // Among real buildings a low circling camera keeps losing the walker behind them, so it rides higher.
        return { look: this.at(d), bearing: h + 40 + 220 * t, pitch: this.stage.street ? 58 : 72, zoom: 17.1, lens: 50 };
    }
  }

  /** The zoom that puts the camera this many metres from what it looks at. */
  private zoomFor(metres: number, lens: number, at: LngLat): number {
    const rad = Math.PI / 180;
    const f = this.stage.height() / 2 / Math.tan((lens * rad) / 2);
    return Math.log2((78271.5 * Math.cos(at[1] * rad) * f) / metres);
  }

  /**
   * The steepest tilt that keeps the camera above the hill behind it. On San
   * Francisco's slopes a low camera looking uphill can end up underground.
   */
  private safePitch(s: Shot): number {
    const ground = this.stage.ground?.bind(this.stage);
    if (!ground) return s.pitch;
    try {
      const rad = Math.PI / 180;
      const distance = cameraDistance(s, this.stage.height());
      const lookGround = ground(s.look);
      for (let pitch = s.pitch; pitch > 45; pitch -= 3) {
        const back = distance * Math.sin(pitch * rad);
        const up = distance * Math.cos(pitch * rad);
        const b = (s.bearing + 180) * rad;
        const cam: LngLat = [
          s.look[0] + (back * Math.sin(b)) / (111320 * Math.cos(s.look[1] * rad)),
          s.look[1] + (back * Math.cos(b)) / 111320,
        ];
        // A close camera only needs to clear the pavement; a distant one needs to clear rooftops.
        if (lookGround + up > ground(cam) + clamp(distance * 0.1, 2.5, 14)) return pitch;
      }
      return 45;
    } catch {
      return s.pitch;
    }
  }

  /** The steepest tilt from which the walker is not hidden behind a building or a tree. */
  private clearPitch(s: Shot, from: number): number {
    if (!this.stage.sees) return from;
    // Looking is costly, so the answer is refreshed a few times a second.
    if (this.frames++ % 5 === 0) {
      let pitch = from;
      while (pitch > 38 && !this.stage.sees({ ...s, pitch })) pitch -= 6;
      this.sight = pitch;
    }
    return Math.min(from, this.sight);
  }

  private apply(s: Shot) {
    // Ease toward the safe tilt so the correction itself is not a jolt.
    const safe = this.clearPitch(s, this.safePitch(s));
    this.pitchLimit = this.pitchLimit === null ? safe : lerp(this.pitchLimit, safe, 0.12);
    this.stage.apply({ ...s, pitch: Math.min(s.pitch, this.pitchLimit) });
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
        // Establishing shot: drift in an arc over the whole walk while the route draws itself on.
        const t = this.phaseMs / arcMs;
        if (now - this.lastTrail > 60) {
          this.lastTrail = now;
          this.stage.reveal?.(this.upTo(this.total * ease(Math.min(1, t * 1.25))));
        }
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
        this.stage.reveal?.(this.pts);
        this.emit({ phase: 'travel' });
      }
    } else if (s.phase === 'travel') {
      // About 42 m of walk per second at normal speed: easing away from the
      // start, slowing through corners so each turn can be read, and easing
      // into the finish.
      this.travelMs += dt;
      const away = Math.min(1, 0.25 + this.travelMs / 2600);
      const corner = 1 - 0.45 * Math.min(1, this.bend(this.d) / 70);
      const arrive = Math.min(1, 0.3 + (this.total - this.d) / 60);
      // Close to the ground the same speed looks far faster, so street-level shots slow down.
      const shooting = s.rig === 'director' ? SEQUENCE[Math.floor(this.d / SHOT_METRES) % SEQUENCE.length] : s.rig;
      const near = shooting === 'chase' ? 0.5 : shooting === 'side' ? 0.72 : 1;
      // Where the city is still loading in, ease right down and let it catch up.
      this.flow = lerp(this.flow, this.stage.busy?.() ? 0.3 : 1, 0.04);
      this.d = Math.min(this.total, this.d + (dt / 1000) * 42 * s.speed * away * corner * arrive * near * (this.stage.pace ?? 1) * this.flow);
      if (now - this.lastTrail > 110) {
        this.lastTrail = now;
        this.stage.trail?.(this.upTo(this.d));
      }
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
      this.stage.walker(this.at(this.d), this.facing(this.d));
      const progress = this.d / this.total;
      if (this.d >= this.total) {
        this.phaseMs = 0;
        this.stage.trail?.(this.pts);
        this.emit({ progress: 1, metres: this.total, leg: this.legEnds.length - 1, cuts, phase: this.finaleMs ? 'finale' : 'done', playing: !!this.finaleMs });
        if (!this.finaleMs) return this.finish();
      } else this.emit({ progress, metres: this.d, leg: this.legAt(this.d), cuts });
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
    this.stage.settle();
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
    this.travelMs = 3000;
    this.stage.reveal?.(this.pts);
    this.stage.trail?.(this.upTo(this.d));
    this.emit({ phase: 'travel', progress: this.d / this.total, metres: this.d, leg: this.legAt(this.d) });
    if (!this.state.playing) {
      const index = this.shotIndex;
      const rig = this.state.rig === 'director' ? SEQUENCE[index % SEQUENCE.length] : this.state.rig;
      this.cam = this.shot(rig, this.d, (this.d % SHOT_METRES) / SHOT_METRES, index % 2 === 1);
      this.apply(this.cam);
      this.stage.walker(this.at(this.d), this.facing(this.d));
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
    this.stage.settle();
    this.stage.walker(null);
    this.stage.reveal?.(this.pts);
    this.stage.trail?.([]);
  }
}
