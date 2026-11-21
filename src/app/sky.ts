import type { LngLat } from '@/lib/types';
import { cameraDistance, type Shot } from './flight';

/**
 * Life in the air: gulls circling over the city, a jet on its way out of the
 * Bay Area and an airliner high overhead. Everything has a real position and
 * height, and is projected through whichever camera is showing (the drawn
 * city or the photographed one), so it holds its place as the camera moves.
 * Drawn on a canvas laid over the picture.
 */

export interface SkyView {
  shot: Shot;
  width: number;
  height: number;
}

interface Bird {
  flock: number;
  radius: number;
  height: number;
  angle: number;
  clockwise: number;
  wobble: number;
  flap: number;
}

/** Aquatic Park and the bay shore, and Telegraph Hill. Flock 0 follows the camera instead. */
const HOMES: LngLat[] = [
  [-122.4235, 37.8083],
  [-122.4059, 37.8025],
];

interface Plane {
  from: LngLat;
  to: LngLat;
  /** Metres above the streets. */
  height: number;
  /** Metres per second. */
  speed: number;
  /** Seconds between one pass and the next, and where in that cycle it starts. */
  every: number;
  offset: number;
  /** Wingspan in metres, and whether it leaves a contrail. */
  span: number;
  trail: boolean;
}

const PLANES: Plane[] = [
  // Climbing out over the bay and the Golden Gate.
  { from: [-122.3, 37.846], to: [-122.56, 37.792], height: 1500, speed: 115, every: 250, offset: 40, span: 36, trail: false },
  // A long-haul flight at cruising height.
  { from: [-122.53, 37.69], to: [-122.31, 37.91], height: 9500, speed: 235, every: 190, offset: 120, span: 60, trail: true },
  // A small plane sightseeing along the waterfront.
  { from: [-122.47, 37.822], to: [-122.37, 37.806], height: 600, speed: 55, every: 330, offset: 200, span: 11, trail: false },
];

const RAD = Math.PI / 180;

/** A projector for one camera position: world point to screen point and scale. */
function projector(view: SkyView) {
  const { shot, width, height } = view;
  const D = cameraDistance(shot, height);
  const b = shot.bearing * RAD;
  const p = Math.min(89, Math.max(0, shot.pitch)) * RAD;
  const kx = 111320 * Math.cos(shot.look[1] * RAD);
  // Camera position east, north and up of the point it looks at.
  const cx = -Math.sin(b) * D * Math.sin(p);
  const cy = -Math.cos(b) * D * Math.sin(p);
  const cz = D * Math.cos(p);
  const f = [Math.sin(b) * Math.sin(p), Math.cos(b) * Math.sin(p), -Math.cos(p)];
  const r = [Math.cos(b), -Math.sin(b), 0];
  const u = [Math.sin(b) * Math.cos(p), Math.cos(b) * Math.cos(p), Math.sin(p)];
  const F = height / 2 / Math.tan((shot.lens * RAD) / 2);
  return (at: LngLat, up: number): { x: number; y: number; scale: number } | null => {
    const vx = (at[0] - shot.look[0]) * kx - cx;
    const vy = (at[1] - shot.look[1]) * 111320 - cy;
    const vz = up - cz;
    const z = vx * f[0] + vy * f[1] + vz * f[2];
    if (z < 4) return null;
    const x = vx * r[0] + vy * r[1];
    const y = vx * u[0] + vy * u[1] + vz * u[2];
    return { x: width / 2 + (F * x) / z, y: height / 2 - (F * y) / z, scale: F / z };
  };
}

export function startSky(canvas: HTMLCanvasElement, view: () => SkyView | null, night: () => boolean): () => void {
  const g = canvas.getContext('2d');
  if (!g) return () => undefined;
  const birds: Bird[] = [];
  let seed = 11;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let flock = 0; flock <= HOMES.length; flock++)
    for (let i = 0; i < (flock === 0 ? 7 : 6); i++)
      birds.push({
        flock,
        radius: 55 + rand() * 170,
        height: 35 + rand() * 75,
        angle: rand() * Math.PI * 2,
        clockwise: rand() < 0.5 ? 1 : -1,
        wobble: rand() * 10,
        flap: rand() * 10,
      });

  let follow: LngLat | null = null;
  let raf = 0;
  let last = performance.now();
  let sizedFor = '';

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const t = now / 1000;
    const v = view();
    if (!v || v.width < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = `${v.width}x${v.height}x${dpr}`;
    if (size !== sizedFor) {
      sizedFor = size;
      canvas.width = Math.round(v.width * dpr);
      canvas.height = Math.round(v.height * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, v.width, v.height);
    // Looking straight down there is no sky to put anything in.
    if (v.shot.pitch < 20) return;
    const project = projector(v);
    const dark = night();
    const inView = (q: { x: number; y: number }, pad: number) => q.x > -pad && q.x < v.width + pad && q.y > -pad && q.y < v.height + pad;

    // Planes first, so the gulls pass in front of them.
    for (const plane of PLANES) {
      const kx = 111320 * Math.cos(plane.from[1] * RAD);
      const dx = (plane.to[0] - plane.from[0]) * kx;
      const dy = (plane.to[1] - plane.from[1]) * 111320;
      const length = Math.hypot(dx, dy);
      const s = ((t + plane.offset) % plane.every) * plane.speed;
      if (s > length) continue;
      const at = (m: number): LngLat => [plane.from[0] + ((dx / length) * m) / kx, plane.from[1] + ((dy / length) * m) / 111320];
      const here = project(at(s), plane.height);
      const ahead = project(at(s + 150), plane.height);
      if (!here || !ahead || !inView(here, 60)) continue;
      const angle = Math.atan2(ahead.y - here.y, ahead.x - here.x);
      const span = Math.max(dark ? 3 : 4.5, Math.min(30, here.scale * plane.span * 2.2));
      if (plane.trail && !dark) {
        // The contrail: a pale line that widens and fades behind the plane.
        let prev = here;
        for (let i = 1; i <= 14; i++) {
          const q = project(at(Math.max(0, s - i * 420)), plane.height);
          if (!q) break;
          g.strokeStyle = `rgba(255,255,255,${0.5 * (1 - i / 15)})`;
          g.lineWidth = 1 + i * 0.22;
          g.lineCap = 'round';
          g.beginPath();
          g.moveTo(prev.x, prev.y);
          g.lineTo(q.x, q.y);
          g.stroke();
          prev = q;
          if (s - i * 420 <= 0) break;
        }
      }
      g.save();
      g.translate(here.x, here.y);
      g.rotate(angle);
      if (dark) {
        // At night a plane is its lights: steady red and green on the wingtips, a white strobe.
        const dot = (x: number, y: number, radius: number, colour: string) => {
          g.fillStyle = colour;
          g.beginPath();
          g.arc(x, y, radius, 0, Math.PI * 2);
          g.fill();
        };
        dot(0, -span * 0.5, 1.3, 'rgba(255,70,60,0.95)');
        dot(0, span * 0.5, 1.3, 'rgba(90,255,140,0.95)');
        if ((t * 1.1 + plane.offset) % 1 < 0.12) {
          dot(-span * 0.2, 0, 5, 'rgba(255,255,255,0.25)');
          dot(-span * 0.2, 0, 2, 'rgba(255,255,255,1)');
        }
      } else {
        g.lineCap = 'round';
        g.lineJoin = 'round';
        const body = (colour: string, grow: number) => {
          g.strokeStyle = colour;
          g.lineWidth = Math.max(1.2, span * 0.11) + grow;
          g.beginPath();
          g.moveTo(-span * 0.55, 0);
          g.lineTo(span * 0.55, 0);
          g.stroke();
          g.lineWidth = Math.max(1, span * 0.075) + grow;
          g.beginPath(); // swept wings
          g.moveTo(-span * 0.12, -span * 0.5);
          g.lineTo(span * 0.1, 0);
          g.lineTo(-span * 0.12, span * 0.5);
          g.stroke();
          g.beginPath(); // tailplane
          g.moveTo(-span * 0.56, -span * 0.18);
          g.lineTo(-span * 0.46, 0);
          g.lineTo(-span * 0.56, span * 0.18);
          g.stroke();
        };
        body('rgba(40,52,70,0.55)', 1.4);
        body('rgba(250,251,252,0.98)', 0);
      }
      g.restore();
    }

    // The camera's flock drifts after it rather than snapping, so it reads as birds, not a HUD.
    const c = v.shot.look;
    follow = follow ? [follow[0] + (c[0] - follow[0]) * Math.min(1, dt * 0.5), follow[1] + (c[1] - follow[1]) * Math.min(1, dt * 0.5)] : c;
    for (const b of birds) {
      const home = b.flock === 0 ? follow : HOMES[b.flock - 1];
      const r = b.radius + 22 * Math.sin(t * 0.21 + b.wobble);
      // Gulls cruise at roughly 9 m/s.
      b.angle += (b.clockwise * 9 * dt) / r;
      const kx = 111320 * Math.cos(home[1] * RAD);
      const spot = (a: number): LngLat => [home[0] + (r * Math.sin(a)) / kx, home[1] + (r * Math.cos(a)) / 111320];
      const height = b.height + 9 * Math.sin(t * 0.4 + b.wobble * 2);
      const here = project(spot(b.angle), height);
      const ahead = project(spot(b.angle + (b.clockwise * 12) / r), height);
      if (!here || !ahead || !inView(here, 40) || here.scale > 30) continue;
      // Drawn a few times life size, or they would be specks.
      const span = Math.max(3, Math.min(11, here.scale * 3.4));
      // Seen from a distance a gull is a shallow "M"; it banks a little into its turn.
      const bank = Math.max(-0.45, Math.min(0.45, ((ahead.x - here.x) / 12) * 0.12)) * b.clockwise;
      // Flap in bursts, then glide.
      const cycle = (t * 0.33 + b.flap) % 1;
      const beat = cycle < 0.62 ? Math.sin((t * 7.5 + b.flap) * 2) : 0.3;
      const lift = span * 0.42 * beat;
      g.save();
      g.translate(here.x, here.y);
      g.rotate(bank);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const wing = (colour: string, width: number) => {
        g.strokeStyle = colour;
        g.lineWidth = width;
        g.beginPath();
        g.moveTo(-span, -lift);
        g.quadraticCurveTo(-span * 0.45, -lift * 0.2 - span * 0.22, 0, 0);
        g.quadraticCurveTo(span * 0.45, -lift * 0.2 - span * 0.22, span, -lift);
        g.stroke();
      };
      if (dark) wing('rgba(190,200,225,0.4)', Math.max(0.8, span * 0.13)); // a pale shape against the night
      else {
        wing('rgba(34,40,50,0.5)', Math.max(1.5, span * 0.26)); // dark edge so they read against bright sky
        wing('rgba(250,250,248,0.95)', Math.max(0.8, span * 0.13)); // white wings
      }
      g.restore();
    }
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
  };
}

/** How far down the picture the horizon sits, in pixels from the top; negative when no sky shows. */
export function horizonY(view: SkyView): number {
  const f = view.height / 2 / Math.tan((view.shot.lens * RAD) / 2);
  return view.height / 2 - f * Math.tan((90 - view.shot.pitch) * RAD);
}

/** Where something in the sky (the moon) sits on screen, or null when it is out of view. */
export function skySpot(view: SkyView, azimuth: number, altitude: number): { x: number; y: number } | null {
  if (altitude < 2) return null;
  const f = view.height / 2 / Math.tan((view.shot.lens * RAD) / 2);
  const delta = ((azimuth - view.shot.bearing + 540) % 360) - 180;
  if (Math.abs(delta) > 70) return null;
  const lift = altitude + (90 - view.shot.pitch);
  if (lift >= 85) return null;
  const x = view.width / 2 + f * Math.tan(delta * RAD);
  const y = view.height / 2 - f * Math.tan(lift * RAD);
  if (x < -40 || x > view.width + 40 || y < 10 || y > horizonY(view)) return null;
  return { x, y };
}
