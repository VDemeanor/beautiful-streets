'use client';

import { useEffect, useRef } from 'react';
import type { LngLat, RouteLeg } from '@/lib/types';
import { cameraDistance, NORMAL_LENS, type Shot, type Stage } from './flight';

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
    w.gm_authFailure = () => reject(new Error('Google rejected the key. Check that the Maps JavaScript API is enabled for it.'));
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

interface Props {
  apiKey: string;
  start: LngLat;
  legs: RouteLeg[] | null;
  /** Ground height in metres above sea level near a point, from the walk's own data. */
  altitude: (at: LngLat) => number;
  onReady: (api: PhotorealApi | null) => void;
  onError: (message: string) => void;
}

export default function Photoreal({ apiKey, start, legs, altitude, onReady, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const libRef = useRef<Maps3d>(null);
  const routeRef = useRef<any[]>([]);
  const altitudeRef = useRef(altitude);
  altitudeRef.current = altitude;

  useEffect(() => {
    let cancelled = false;
    let walker: any = null;
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
          walker(at) {
            if (!at) {
              walker?.remove();
              walker = null;
              return;
            }
            const position = { lat: at[1], lng: at[0], altitude: 4 };
            if (!walker) {
              walker = new lib.Marker3DElement({ position, altitudeMode: 'RELATIVE_TO_GROUND', extruded: true });
              map.append(walker);
            } else walker.position = position;
          },
          height,
          settle() {
            try {
              map.stopCameraAnimation?.();
              map.fov = NORMAL_LENS;
            } catch {
              /* nothing to stop */
            }
          },
        };
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
          nudge(bearing, pitch) {
            map.heading = (((Number(map.heading) || 0) + bearing) % 360 + 360) % 360;
            map.tilt = Math.max(0, Math.min(88, (Number(map.tilt) || 0) + pitch));
          },
        });
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      walker?.remove();
      mapRef.current?.remove();
      mapRef.current = null;
      onReady(null);
    };
    // The map is built once per key; the walk and start are drawn by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  // Draw the walk on the ground, visible through buildings, with a pin at the start.
  useEffect(() => {
    const map = mapRef.current;
    const lib = libRef.current;
    for (const el of routeRef.current) el.remove();
    routeRef.current = [];
    if (!map || !lib) return;
    try {
      if (legs?.length) {
        const coordinates = legs.flatMap((l) => l.coords.map(([lng, lat]) => ({ lat, lng })));
        const line = new lib.Polyline3DElement({
          coordinates,
          strokeColor: '#ff6a3d',
          outerColor: '#ffffff',
          strokeWidth: 9,
          outerWidth: 0.35,
          altitudeMode: 'CLAMP_TO_GROUND',
          drawsOccludedSegments: true,
        });
        map.append(line);
        routeRef.current.push(line);
      }
      const pin = new lib.Marker3DElement({
        position: { lat: start[1], lng: start[0], altitude: 22 },
        altitudeMode: 'RELATIVE_TO_GROUND',
        extruded: true,
        label: 'Start',
      });
      map.append(pin);
      routeRef.current.push(pin);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
    // onError is stable enough for this purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legs, start, apiKey]);

  return <div ref={host} className="photoreal" />;
}
