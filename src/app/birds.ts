import * as maplibregl from 'maplibre-gl';
import type { LngLat } from '@/lib/types';

/**
 * Gulls. Each bird circles a point in the real world at a real height, so they
 * hold their place over the city as the camera moves, and a few always keep
 * the camera company. Drawn on a canvas laid over the map.
 */

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

export function startBirds(map: maplibregl.Map, canvas: HTMLCanvasElement): () => void {
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

  let follow: LngLat = [map.getCenter().lng, map.getCenter().lat];
  let raf = 0;
  let last = performance.now();

  const fit = () => {
    const box = map.getContainer().getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  fit();
  map.on('resize', fit);

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const t = now / 1000;
    const box = map.getContainer().getBoundingClientRect();
    g.clearRect(0, 0, box.width, box.height);
    const pitch = (map.getPitch() * Math.PI) / 180;
    if (pitch > 0.35) {
      // The camera's flock drifts after it rather than snapping, so it reads as birds, not a HUD.
      const c = map.getCenter();
      follow = [follow[0] + (c.lng - follow[0]) * Math.min(1, dt * 0.5), follow[1] + (c.lat - follow[1]) * Math.min(1, dt * 0.5)];
      for (const b of birds) {
        const home = b.flock === 0 ? follow : HOMES[b.flock - 1];
        const r = b.radius + 22 * Math.sin(t * 0.21 + b.wobble);
        // Gulls cruise at roughly 9 m/s.
        b.angle += (b.clockwise * 9 * dt) / r;
        const lat = home[1] + (r * Math.cos(b.angle)) / 111320;
        const lng = home[0] + (r * Math.sin(b.angle)) / (111320 * Math.cos((home[1] * Math.PI) / 180));
        const ground = map.project([lng, lat]);
        // How many pixels a metre covers at that spot, measured along the bird's path.
        const ahead = map.project([
          home[0] + (r * Math.sin(b.angle + (b.clockwise * 12) / r)) / (111320 * Math.cos((home[1] * Math.PI) / 180)),
          home[1] + (r * Math.cos(b.angle + (b.clockwise * 12) / r)) / 111320,
        ]);
        const side = map.project([lng + 12 / (111320 * Math.cos((lat * Math.PI) / 180)), lat]);
        const pxPerMetre = Math.hypot(side.x - ground.x, side.y - ground.y) / 12;
        if (!Number.isFinite(pxPerMetre) || pxPerMetre <= 0 || pxPerMetre > 30) continue;
        const height = b.height + 9 * Math.sin(t * 0.4 + b.wobble * 2);
        const x = ground.x;
        const y = ground.y - height * pxPerMetre * Math.sin(pitch);
        if (x < -40 || x > box.width + 40 || y < -40 || y > box.height + 40) continue;
        // Drawn several times life size, or they would be specks.
        const span = Math.max(4.5, Math.min(26, pxPerMetre * 9));
        const heading = Math.atan2(ahead.y - ground.y, ahead.x - ground.x);
        // Flap in bursts, then glide.
        const cycle = (t * 0.33 + b.flap) % 1;
        const beat = cycle < 0.62 ? Math.sin((t * 7.5 + b.flap) * 2) : 0.25;
        const lift = span * 0.34 * beat;

        g.save();
        g.translate(x, y);
        g.rotate(heading + Math.PI / 2);
        g.lineCap = 'round';
        g.lineJoin = 'round';
        const wing = (colour: string, width: number) => {
          g.strokeStyle = colour;
          g.lineWidth = width;
          g.beginPath();
          g.moveTo(-span, -lift * 0.2);
          g.quadraticCurveTo(-span * 0.5, -lift - span * 0.16, 0, 0);
          g.quadraticCurveTo(span * 0.5, -lift - span * 0.16, span, -lift * 0.2);
          g.stroke();
        };
        wing('rgba(38,44,54,0.55)', Math.max(1.6, span * 0.2)); // dark edge so they read against bright sky
        wing('rgba(250,250,248,0.96)', Math.max(1, span * 0.12)); // white wings
        g.fillStyle = 'rgba(250,250,248,0.96)';
        g.beginPath();
        g.ellipse(0, span * 0.06, span * 0.09, span * 0.24, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
    }
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return () => {
    cancelAnimationFrame(raf);
    map.off('resize', fit);
    g.clearRect(0, 0, canvas.width, canvas.height);
  };
}
