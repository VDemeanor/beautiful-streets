'use client';

import { useEffect, useRef, useState } from 'react';
import type { LngLat, RouteLeg } from '@/lib/types';
import { cameraDistance, NORMAL_LENS, type Shot, type Stage } from './flight';
import type { Vehicle } from './traffic';

/**
 * The real city: Google's photorealistic 3D Maps, with real facades, roofs and
 * trees captured from aerial imagery. Needs a Google Maps Platform key with the
 * Maps JavaScript API enabled. The film plays on it through the same Stage
 * interface as the built-in scene.
 */

export interface PhotorealApi {
  stage: Stage;
  /** Show the whole walk (or the neighbourhood, with no walk). */
  frame(view: { center: LngLat; zoom: number }, pitch: number, bearing: number): void;
  /** Rotate or tilt by hand. */
  nudge(bearing: number, pitch: number): void;
  /** Show these vehicles, moving the 3D models already placed and adding or removing as needed. */
  vehicles(list: Vehicle[]): void;
  /** Mark the next turn with the name of the street to take, or clear it with null. */
  nextTurn(at: LngLat | null, label?: string): void;
  /** The pickups along the walk still waiting to be collected. */
  gems(list: { where: LngLat; label: string }[]): void;
}

/* The Maps library is loaded at run time and has no bundled types here. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Maps3d = any;

let loading: Promise<Maps3d> | null = null;

function loadMaps3d(key: string): Promise<Maps3d> {
  if (loading) return loading;
  loading = new Promise<Maps3d>((resolve, reject) => {
    const w = window as any;
    const ready = () => w.google.maps.importLibrary('maps3d').then(resolve, reject);
    if (w.google?.maps?.importLibrary) return ready();
    w.__bsMapsReady = ready;
    // Google reports a rejected key through this global hook.
    w.gm_authFailure = () => {
      w.__bsKeyRefused = true;
      reject(new Error('Google rejected the key. Check that the Maps JavaScript API is enabled for it and that this site is allowed.'));
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=beta&loading=async&libraries=maps3d&callback=__bsMapsReady`;
    s.async = true;
    s.onerror = () => reject(new Error('Could not reach Google Maps.'));
    document.head.appendChild(s);
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

const toCoords = (path: LngLat[]) => path.map(([lng, lat]) => ({ lat, lng }));

/** A marker drawn from our own SVG rather than Google's red pin. */
function svgMarker(lib: Maps3d, options: Record<string, unknown>, svg: string): any {
  const marker = new lib.Marker3DElement(options);
  try {
    const template = document.createElement('template');
    template.innerHTML = svg;
    marker.append(template);
  } catch {
    /* fall back to the default pin */
  }
  return marker;
}

/** A glowing marker that floats over the walker. */
const BEACON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">' +
  '<defs><radialGradient id="b"><stop offset="0" stop-color="#ffd27a" stop-opacity=".95"/><stop offset="1" stop-color="#ffb23e" stop-opacity="0"/></radialGradient></defs>' +
  '<circle cx="17" cy="17" r="16" fill="url(#b)"/><circle cx="17" cy="17" r="6" fill="#e2542f" stroke="#fff" stroke-width="2.5"/></svg>';

/** A pickup waiting on the route. */
const PICKUP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">' +
  '<defs><linearGradient id="p" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eaffff"/><stop offset=".45" stop-color="#58d6e8"/><stop offset="1" stop-color="#1f5673"/></linearGradient></defs>' +
  '<path d="M17 2 L30 13 L17 32 L4 13 Z" fill="url(#p)" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/><path d="M4 13 H30 M11 13 L17 2 L23 13 L17 32 Z" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="1"/></svg>';

const TURN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 30 30">' +
  '<circle cx="15" cy="15" r="11" fill="#ffb23e" stroke="#fff" stroke-width="3"/><circle cx="15" cy="15" r="4" fill="#fff"/></svg>';

const GEM_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="46" height="46" viewBox="0 0 46 46">' +
  '<defs><linearGradient id="d" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe9a8"/><stop offset=".4" stop-color="#ffb23e"/><stop offset=".75" stop-color="#e2542f"/><stop offset="1" stop-color="#8f1f1a"/></linearGradient></defs>' +
  '<rect x="11" y="11" width="24" height="24" rx="3" transform="rotate(45 23 23)" fill="url(#d)" stroke="#fff" stroke-width="3"/></svg>';

/** Small arrowheads laid on the ground along the path, pointing the way to walk. */
function chevrons(path: LngLat[], everyMetres: number): LngLat[][] {
  const out: LngLat[][] = [];
  const rad = Math.PI / 180;
  let carry = everyMetres * 0.6;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const kx = 111320 * Math.cos(a[1] * rad);
    const dx = (b[0] - a[0]) * kx;
    const dy = (b[1] - a[1]) * 111320;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const ux = dx / len;
    const uy = dy / len;
    let d = everyMetres - carry;
    while (d <= len) {
      const tipX = a[0] * kx + ux * d;
      const tipY = a[1] * 111320 + uy * d;
      const arm = 5.5;
      const wing = (side: number): LngLat => [
        (tipX - ux * arm + -uy * side * arm * 0.75) / kx,
        (tipY - uy * arm + ux * side * arm * 0.75) / 111320,
      ];
      out.push([wing(1), [tipX / kx, tipY / 111320], wing(-1)]);
      d += everyMetres;
    }
    carry = (carry + len) % everyMetres;
  }
  return out;
}

interface Props {
  apiKey: string;
  start: LngLat;
  legs: RouteLeg[] | null;
  /** Ground height in metres above sea level near a point, from the walk's own data. */
  altitude: (at: LngLat) => number;
  onReady: (api: PhotorealApi | null) => void;
  /** keyRefused is true only when Google rejected the key itself. */
  onError: (message: string, keyRefused: boolean) => void;
}

export default function Photoreal({ apiKey, start, legs, altitude, onReady, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const libRef = useRef<Maps3d>(null);
  const routeRef = useRef<any[]>([]);
  const baseRef = useRef<any>(null);
  const walkedRef = useRef<any>(null);
  const turnRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const altitudeRef = useRef(altitude);
  altitudeRef.current = altitude;

  useEffect(() => {
    let cancelled = false;
    let walker: any[] = [];
    let walkerWarned = false;
    let beacon: any = null;
    let steady = true;
    const fleet = new Map<number, any>();
    const pickups = new Map<string, any>();
    let fleetWarned = false;
    loadMaps3d(apiKey)
      .then((lib) => {
        if (cancelled || !host.current) return;
        libRef.current = lib;
        const map = new lib.Map3DElement({
          center: { lat: start[1], lng: start[0], altitude: altitudeRef.current(start) },
          tilt: 62,
          heading: 342,
          range: 900,
          // Satellite mode has no labels: just the city.
          mode: 'SATELLITE',
          defaultUIDisabled: true,
        });
        map.style.width = '100%';
        map.style.height = '100%';
        host.current.appendChild(map);
        mapRef.current = map;
        map.addEventListener('gmp-steadychange', (event: any) => {
          steady = event.isSteady !== false;
        });

        const height = () => host.current?.getBoundingClientRect().height ?? 600;
        const put = (s: Shot) => {
          map.center = { lat: s.look[1], lng: s.look[0], altitude: altitudeRef.current(s.look) };
          map.heading = ((s.bearing % 360) + 360) % 360;
          map.tilt = Math.max(0, Math.min(88, s.pitch));
          map.range = cameraDistance(s, height());
          try {
            map.fov = s.lens;
          } catch {
            /* this build has a fixed lens */
          }
        };
        const stage: Stage = {
          current() {
            const c = map.center ?? { lat: start[1], lng: start[0] };
            const lens = Number(map.fov) || NORMAL_LENS;
            const range = Number(map.range) || 900;
            const rad = Math.PI / 180;
            const zoom = Math.log2((78271.5 * Math.cos(c.lat * rad) * (height() / 2 / Math.tan((lens * rad) / 2))) / range);
            return { look: [c.lng, c.lat], bearing: Number(map.heading) || 0, pitch: Number(map.tilt) || 0, zoom, lens };
          },
          apply: put,
          walker(at, heading = 0) {
            if (!at) {
              for (const model of walker) model.remove();
              walker = [];
              beacon?.remove();
              beacon = null;
              return;
            }
            try {
              // Four models, one for each moment of the stride; the one in step is shown and the
              // rest wait out of sight below ground. Facing and footing can be tuned from the console.
              const tune = (window as any).__bsWalkerTune ?? { heading: 180, tilt: 270, altitude: 0, mode: 'RELATIVE_TO_MESH' };
              const step = Math.floor((performance.now() / 1000) * 1.7 * 4) % 4;
              // Up close the figure is life size; from further off it grows so it can still be found.
              const scale = Math.max(1.3, Math.min(9, (Number(map.range) || 60) / 26));
              const orientation = { heading: (((heading + tune.heading) % 360) + 360) % 360, tilt: tune.tilt, roll: 0 };
              if (!walker.length) {
                for (let i = 0; i < 4; i++) {
                  const model = new lib.Model3DElement({ src: `/models/walker-${i}.glb`, position: { lat: at[1], lng: at[0], altitude: -500 }, orientation, altitudeMode: tune.mode, scale });
                  map.append(model);
                  walker.push(model);
                }
              }
              // A beacon over their head, so they can be found from the air.
              const over = { lat: at[1], lng: at[0], altitude: 2.4 * scale + 3 };
              if (!beacon) {
                beacon = svgMarker(lib, { position: over, altitudeMode: 'RELATIVE_TO_MESH' }, BEACON_SVG);
                map.append(beacon);
              } else beacon.position = over;
              walker.forEach((model, i) => {
                model.position = { lat: at[1], lng: at[0], altitude: i === step ? tune.altitude : -500 };
                model.orientation = orientation;
                model.scale = scale;
              });
            } catch (err) {
              if (!walkerWarned) console.warn('[beautiful-streets] walker failed', err);
              walkerWarned = true;
            }
          },
          ground: (at) => altitudeRef.current(at),
          // The photographed city is sharp from rooftop height and a rough mesh at eye level, and
          // low cameras get lost behind buildings and trees, so here every shot is flown from above.
          street: { distance: 150, pitch: 60 },
          // Google sends a rough city first and the detail a moment later, so the film travels
          // slower here and waits while detail is still arriving.
          pace: 0.42,
          busy: () => !steady,
          height,
          reveal(path) {
            try {
              if (baseRef.current && path.length > 1) baseRef.current.path = toCoords(path);
            } catch (err) {
              console.warn('[beautiful-streets] reveal failed', err);
            }
          },
          trail(path) {
            try {
              if (path.length < 2) {
                walkedRef.current?.remove();
                walkedRef.current = null;
                return;
              }
              if (!walkedRef.current) {
                walkedRef.current = new lib.Polyline3DElement({
                  path: toCoords(path),
                  altitudeMode: 'CLAMP_TO_GROUND',
                  drawsOccludedSegments: true,
                  strokeColor: '#ff6a3d',
                  outerColor: '#ffffff',
                  strokeWidth: 11,
                  outerWidth: 0.3,
                });
                map.append(walkedRef.current);
              } else walkedRef.current.path = toCoords(path);
            } catch (err) {
              console.warn('[beautiful-streets] trail failed', err);
            }
          },
          settle() {
            try {
              map.stopCameraAnimation?.();
              map.fov = NORMAL_LENS;
            } catch {
              /* nothing to stop */
            }
          },
        };
        setReady(true);
        onReady({
          stage,
          frame(view, pitch, bearing) {
            const end: Shot = { look: view.center, zoom: view.zoom, pitch, bearing, lens: NORMAL_LENS };
            try {
              map.flyCameraTo({
                endCamera: {
                  center: { lat: end.look[1], lng: end.look[0], altitude: altitudeRef.current(end.look) },
                  tilt: pitch,
                  heading: ((bearing % 360) + 360) % 360,
                  range: cameraDistance(end, height()),
                },
                durationMillis: 1800,
              });
            } catch {
              put(end);
            }
          },
          vehicles(list) {
            try {
              // How the models sit in Google's scene. They are built Y-up facing +Z, so they
              // are tipped upright (tilt 270) and turned to face the way they travel.
              const tune = (window as any).__bsCarTune ?? { heading: 180, tilt: 270, roll: 0 };
              const seen = new Set<number>();
              for (const v of list) {
                seen.add(v.id);
                const position = { lat: v.at[1], lng: v.at[0], altitude: 0 };
                const orientation = { heading: (v.heading + tune.heading + 360) % 360, tilt: tune.tilt, roll: tune.roll };
                let model = fleet.get(v.id);
                if (!model) {
                  model = new lib.Model3DElement({
                    src: v.type === 'cable' ? '/models/cable-car.glb' : v.type === 'ferry' ? '/models/ferry.glb' : `/models/car-${v.paint}.glb`,
                    position,
                    orientation,
                    // The photographed street surface sits a little above the plain terrain,
                    // which would bury a ground-clamped car, so vehicles ride on the mesh.
                    altitudeMode: 'RELATIVE_TO_MESH',
                    scale: 1,
                  });
                  map.append(model);
                  fleet.set(v.id, model);
                } else {
                  model.position = position;
                  model.orientation = orientation;
                }
              }
              for (const [id, model] of fleet) {
                if (seen.has(id)) continue;
                model.remove();
                fleet.delete(id);
              }
            } catch (err) {
              if (!fleetWarned) console.warn('[beautiful-streets] traffic failed', err);
              fleetWarned = true;
            }
          },
          nextTurn(at, label) {
            try {
              if (!at) {
                turnRef.current?.remove();
                turnRef.current = null;
                return;
              }
              const position = { lat: at[1], lng: at[0], altitude: 16 };
              if (!turnRef.current) {
                turnRef.current = svgMarker(lib, { position, altitudeMode: 'RELATIVE_TO_GROUND', extruded: true, label: label ?? '' }, TURN_SVG);
                map.append(turnRef.current);
              } else {
                turnRef.current.position = position;
                turnRef.current.label = label ?? '';
              }
            } catch {
              /* turn labels are a nicety */
            }
          },
          gems(list) {
            try {
              const wanted = new Set(list.map((gem) => `${gem.where[0]},${gem.where[1]}`));
              for (const [k, marker] of pickups) {
                if (wanted.has(k)) continue;
                marker.remove();
                pickups.delete(k);
              }
              for (const gem of list) {
                const k = `${gem.where[0]},${gem.where[1]}`;
                if (pickups.has(k)) continue;
                const marker = svgMarker(lib, { position: { lat: gem.where[1], lng: gem.where[0], altitude: 9 }, altitudeMode: 'RELATIVE_TO_GROUND', extruded: true }, PICKUP_SVG);
                map.append(marker);
                pickups.set(k, marker);
              }
            } catch {
              /* pickups are a nicety */
            }
          },
          nudge(bearing, pitch) {
            map.heading = (((Number(map.heading) || 0) + bearing) % 360 + 360) % 360;
            map.tilt = Math.max(0, Math.min(88, (Number(map.tilt) || 0) + pitch));
          },
        });
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err), !!(window as any).__bsKeyRefused);
      });
    return () => {
      cancelled = true;
      for (const model of walker) model.remove();
      beacon?.remove();
      for (const model of fleet.values()) model.remove();
      fleet.clear();
      for (const marker of pickups.values()) marker.remove();
      pickups.clear();
      turnRef.current?.remove();
      turnRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      onReady(null);
    };
    // The map is built once per key; the walk and start are drawn by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // Draw the walk on the ground: the plan as a pale line with arrowheads showing
  // the way, the part already walked in bright orange over it, and a gem at the start.
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    for (const el of routeRef.current) el.remove();
    routeRef.current = [];
    baseRef.current = null;
    if (!map || !lib) return;
    // Each part is drawn on its own, so one unsupported option cannot take the rest down.
    const attempt = (what: string, draw: () => void) => {
      try {
        draw();
      } catch (err) {
        console.warn(`[beautiful-streets] could not draw ${what}`, err);
      }
    };
    const line = (options: Record<string, unknown>) => {
      const el = new lib.Polyline3DElement({ altitudeMode: 'CLAMP_TO_GROUND', drawsOccludedSegments: true, ...options });
      map.append(el);
      routeRef.current.push(el);
      return el;
    };
    if (legs?.length) {
      const path: LngLat[] = legs.flatMap((l) => l.coords);
      attempt('the route', () => {
        baseRef.current = line({ path: toCoords(path), strokeColor: '#ffffff', outerColor: '#1b2a2f', strokeWidth: 8, outerWidth: 0.3 });
      });
      attempt('the direction arrows', () => {
        for (const arrow of chevrons(path, 55)) line({ path: toCoords(arrow), strokeColor: '#1b2a2f', strokeWidth: 4 });
      });
    }
    walkedRef.current?.remove();
    walkedRef.current = null;
    attempt('the start marker', () => {
      const pin = svgMarker(lib, { position: { lat: start[1], lng: start[0], altitude: 24 }, altitudeMode: 'RELATIVE_TO_GROUND', extruded: true, label: 'Start' }, GEM_SVG);
      map.append(pin);
      routeRef.current.push(pin);
    });
    // The map is created asynchronously, so this also re-runs when it becomes ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, start, apiKey, ready]);

  return <div ref={host} className="photoreal" />;
}
