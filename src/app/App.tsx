'use client';

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as SunCalc from 'suncalc';
import { bearing as bearingBetween, haversine } from '@/lib/geo';
import { applySun, CAMERA_3D, installScene, installTrees, setSceneMode, sunOnScreen, type Sun } from './scene';
import type { LngLat, Route, RouteLeg, Side, WalkContext } from '@/lib/types';

interface MapBlock {
  id: string;
  name: string;
  coords: LngLat[];
  len: number;
  bearing: number;
  score: number;
  votes: number;
  dims: [number, number, number, number];
}
interface Me {
  id: string;
  name: string;
}
interface Card {
  id: string;
  name: string;
  at: LngLat;
  bearing: number;
  coords: LngLat[];
}
type Tab = 'walk' | 'vote' | 'rank';

const DIM_LABELS = ['Views and stairways', 'Trees and gardens', 'Architecture', 'People and energy'] as const;
const DIM_KEYS = ['views', 'green', 'arch', 'energy'] as const;
const CARDINALS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
const cardinal = (deg: number) => CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const miles = (m: number) => (m / 1609.34).toFixed(m < 1609 ? 2 : 1);
const feet = (m: number) => Math.round((m * 3.28084) / 10) * 10;
const flip = (s: Side): Side => (s === 'L' ? 'R' : 'L');

const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e6ecea' } }],
};

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status}).`);
  return json as T;
}

const lines = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const line = (coords: LngLat[], properties: Record<string, unknown>): Feature => ({
  type: 'Feature',
  properties,
  geometry: { type: 'LineString', coordinates: coords },
});

/** Two curbs seen from above, heading up the page; the dot is where you walk. */
function SideGlyph({ side }: { side: Side }) {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" role="img" aria-label={side === 'L' ? 'Left side' : 'Right side'}>
      <rect x="9" y="3" width="16" height="28" fill="#e6ecea" />
      <line x1="9" y1="3" x2="9" y2="31" stroke="#14252b" strokeWidth="2" />
      <line x1="25" y1="3" x2="25" y2="31" stroke="#14252b" strokeWidth="2" />
      <line x1="17" y1="6" x2="17" y2="28" stroke="#fff" strokeWidth="1.5" strokeDasharray="4 4" />
      <circle cx={side === 'L' ? 4.5 : 29.5} cy="17" r="4" fill="#c0362c" />
    </svg>
  );
}

export default function App({ mapStyle }: { mapStyle: string }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const startMarker = useRef<maplibregl.Marker | null>(null);
  const panelEl = useRef<HTMLDivElement>(null);
  const crumbs = useRef<maplibregl.Marker[]>([]);
  const [mapReady, setMapReady] = useState(false);

  const [blocks, setBlocks] = useState<MapBlock[]>([]);
  const [source, setSource] = useState<'osm' | 'demo'>('osm');
  const [loadError, setLoadError] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>('walk');
  const [selected, setSelected] = useState<MapBlock | null>(null);
  const [needJoin, setNeedJoin] = useState(false);
  const [toast, setToast] = useState('');
  const [threeD, setThreeD] = useState(true);
  const [flying, setFlying] = useState(false);
  const flight = useRef(0);
  const walker = useRef<maplibregl.Marker | null>(null);
  const finishedRef = useRef(false);
  const introFor = useRef<unknown>(null);
  const [sunSpot, setSunSpot] = useState<{ x: number; y: number; above: boolean } | null>(null);
  const [skyPhase, setSkyPhase] = useState<'night' | 'golden' | 'day'>('day');
  const [finished, setFinished] = useState(false);

  const [start, setStart] = useState<LngLat | null>(null);
  const [minutes, setMinutes] = useState(45);
  const [when, setWhen] = useState('');
  const [weights, setWeights] = useState<number[]>([1, 1, 1, 1]);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState('');
  const [plan, setPlan] = useState<{ route: Route; ctx: WalkContext } | null>(null);
  const [rating, setRating] = useState(false);
  const [stars, setStars] = useState<Record<number, number>>({});
  const [sidePick, setSidePick] = useState<Record<number, 'same' | 'other'>>({});

  const [duel, setDuel] = useState<{ a: Card; b: Card } | null>(null);
  const [board, setBoard] = useState<{ streets: { name: string; score: number; votes: number }[]; voters: { name: string; votes: number }[] } | null>(null);

  const byId = useMemo(() => new Map(blocks.map((b) => [b.id, b])), [blocks]);

  const loadWorld = useCallback(async () => {
    try {
      const w = await api<{ blocks: MapBlock[]; me: Me | null; source: 'osm' | 'demo' }>('/api/world');
      setBlocks(w.blocks);
      setMe(w.me);
      setSource(w.source);
      setLoadError('');
      return w.blocks;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      return [];
    }
  }, []);

  // Create the map once.
  useEffect(() => {
    let cancelled = false;
    let map: maplibregl.Map | undefined;
    (async () => {
      // Fall back to a plain background if the basemap cannot be reached, so the
      // streets and routes still draw.
      let style: string | StyleSpecification = mapStyle;
      try {
        const res = await fetch(mapStyle, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) style = BLANK_STYLE;
      } catch {
        style = BLANK_STYLE;
      }
      if (cancelled || !mapEl.current) return;
      maplibregl.setWorkerUrl('/maplibre-gl-worker.mjs');
      map = new maplibregl.Map({
        container: mapEl.current,
        style,
        center: [-122.418, 37.8],
        zoom: 14,
        maxPitch: 85,
        pitch: CAMERA_3D.pitch,
        bearing: CAMERA_3D.bearing,
        attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors' },
      });
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
      map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
      map.on('load', () => {
        if (!map) return;
        const empty = lines([]);
        map.addSource('blocks', { type: 'geojson', data: empty });
        map.addSource('duel', { type: 'geojson', data: empty });
        map.addSource('route', { type: 'geojson', data: empty });
        map.addLayer({
          id: 'blocks',
          type: 'line',
          source: 'blocks',
          layout: { 'line-cap': 'round' },
          paint: {
            'line-color': ['interpolate', ['linear'], ['get', 'score'], 0.1, '#b9c4c1', 0.35, '#8fb09b', 0.6, '#2f6b4f', 0.85, '#123f2b'],
            'line-width': ['interpolate', ['linear'], ['zoom'], 12, ['+', 0.6, ['*', 1.5, ['get', 'score']]], 17, ['+', 2, ['*', 7, ['get', 'score']]]],
            'line-opacity': 0.85,
          },
        });
        // Wide invisible line so thin streets are easy to tap.
        map.addLayer({ id: 'blocks-hit', type: 'line', source: 'blocks', paint: { 'line-width': 18, 'line-opacity': 0 } });
        map.addLayer({
          id: 'duel',
          type: 'line',
          source: 'duel',
          layout: { 'line-cap': 'round' },
          paint: { 'line-color': ['get', 'color'], 'line-width': 9 },
        });
        map.addLayer({
          id: 'route-bed',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 12, 'line-opacity': 0.75 },
        });
        // The route is drawn on the side of the street you walk on.
        map.addLayer({
          id: 'route',
          type: 'line',
          source: 'route',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#c0362c', 'line-width': 4, 'line-offset': ['get', 'offset'] },
        });
        installScene(map);
        fetch('/api/trees')
          .then((r) => r.json())
          .then((j: { trees: LngLat[] }) => {
            if (!cancelled && map) {
              installTrees(map, j.trees);
              setSceneMode(map, true);
            }
          })
          .catch(() => undefined);
        // Handy when debugging from the browser console.
        (window as unknown as { __bsMap?: maplibregl.Map }).__bsMap = map;
        setMapReady(true);
      });
      mapRef.current = map;
    })();
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [mapStyle]);

  useEffect(() => {
    loadWorld().then((bs) => {
      if (!bs.length) return;
      let w = 180, s = 90, e = -180, n = -90;
      for (const b of bs) for (const [x, y] of b.coords) {
        w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
      }
      // Start on Russian Hill when the map covers it; otherwise the middle of the map.
      const home: LngLat = [-122.4194, 37.8021];
      const covered = home[0] > w && home[0] < e && home[1] > s && home[1] < n;
      setStart((cur) => cur ?? (covered ? home : [(w + e) / 2, (s + n) / 2]));
      // Open on the neighbourhood around the start, close enough for buildings to show.
      mapRef.current?.jumpTo({ center: covered ? home : [(w + e) / 2, (s + n) / 2], zoom: 15.4 });
    });
  }, [loadWorld]);

  // Streets layer.
  useEffect(() => {
    if (!mapReady) return;
    (mapRef.current!.getSource('blocks') as GeoJSONSource).setData(
      lines(blocks.map((b) => line(b.coords, { id: b.id, score: b.score }))),
    );
  }, [mapReady, blocks]);

  // Tap a street to open its card.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current!;
    const onClick = (e: maplibregl.MapLayerMouseEvent) => {
      const id = e.features?.[0]?.properties?.id as string | undefined;
      const b = id ? byId.get(id) : undefined;
      if (b) setSelected(b);
    };
    map.on('click', 'blocks-hit', onClick);
    return () => {
      map.off('click', 'blocks-hit', onClick);
    };
  }, [mapReady, byId]);

  // Start marker.
  useEffect(() => {
    if (!mapReady || !start) return;
    if (!startMarker.current) {
      const el = document.createElement('div');
      el.className = 'beacon';
      el.title = 'Walk starts and ends here';
      el.innerHTML =
        '<span class="beacon-beam"></span><span class="beacon-ring"></span><span class="beacon-ring late"></span>' +
        '<span class="beacon-core"></span>' +
        Array.from({ length: 6 }, (_, i) => `<i class="spark" style="--i:${i}"></i>`).join('');
      startMarker.current = new maplibregl.Marker({ element: el, draggable: true, anchor: 'bottom', opacityWhenCovered: '1' }).setLngLat(start).addTo(mapRef.current!);
      startMarker.current.on('dragend', () => {
        const p = startMarker.current!.getLngLat();
        setStart([p.lng, p.lat]);
      });
    } else startMarker.current.setLngLat(start);
  }, [mapReady, start]);

  // Route layer.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current!;
    const legs = plan?.route.legs ?? [];
    (map.getSource('route') as GeoJSONSource).setData(
      lines(legs.map((l) => line(l.coords, { offset: l.side === 'R' ? 5 : -5 }))),
    );
    // The route would clash with the matchup colours, so it only shows on the Walk tab.
    const visibility = tab === 'walk' ? 'visible' : 'none';
    map.setLayoutProperty('route', 'visibility', visibility);
    map.setLayoutProperty('route-bed', 'visibility', visibility);
    if (legs.length && tab === 'walk') {
      const view = overview();
      if (view) {
        if (threeD && !calm() && introFor.current !== plan) {
          // Reveal a new walk with a swoop: start high and turned away, then settle over it.
          introFor.current = plan;
          map.jumpTo({ center: view.center, zoom: view.zoom - 1.6, pitch: 20, bearing: CAMERA_3D.bearing - 70 });
          map.easeTo({ ...view, ...CAMERA_3D, duration: 2400, easing: (t) => 1 - (1 - t) ** 3 });
        } else map.easeTo({ ...view, duration: 800 });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, plan, tab]);

  // In 3D, buildings hide stretches of the route line, so mark the walk with a
  // trail of small blocks that always draw on top.
  useEffect(() => {
    for (const c of crumbs.current) c.remove();
    crumbs.current = [];
    const legs = plan?.route.legs;
    if (!mapReady || !legs?.length || !threeD || tab !== 'walk') return;
    let carry = 0;
    for (const leg of legs) {
      for (let i = 1; i < leg.coords.length; i++) {
        const a = leg.coords[i - 1];
        const b = leg.coords[i];
        const len = haversine(a, b);
        let d = 35 - carry;
        while (d <= len) {
          const el = document.createElement('div');
          el.className = 'crumb';
          el.style.setProperty('--n', String(crumbs.current.length));
          const f = d / len;
          crumbs.current.push(
            new maplibregl.Marker({ element: el, opacityWhenCovered: '1' })
              .setLngLat([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
              .addTo(mapRef.current!),
          );
          d += 35;
        }
        carry = (carry + len) % 35;
      }
    }
  }, [mapReady, plan, threeD, tab]);

  // Show a new plan, or a new tab, from the top.
  useEffect(() => {
    panelEl.current?.scrollTo({ top: 0 });
  }, [plan, tab]);

  // Matchup highlight.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current!;
    const show = tab === 'vote' && duel;
    (map.getSource('duel') as GeoJSONSource).setData(
      lines(show ? [line(duel.a.coords, { color: '#1f5673' }), line(duel.b.coords, { color: '#c0362c' })] : []),
    );
    if (show) {
      const bounds = new maplibregl.LngLatBounds();
      for (const c of [...duel.a.coords, ...duel.b.coords]) bounds.extend(c);
      map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
    }
  }, [mapReady, tab, duel]);

  // Flat or 3D.
  useEffect(() => {
    if (mapReady) setSceneMode(mapRef.current!, threeD);
  }, [mapReady, threeD]);

  // Where the sun is: at the walk's start time once a walk is designed, otherwise now.
  const sun: Sun = useMemo(() => {
    if (plan) return { azimuth: plan.ctx.sunAzimuth, altitude: plan.ctx.sunAltitude, cloud: plan.ctx.weather?.cloudPct ?? 20 };
    const at = start ?? [-122.4194, 37.8021];
    const pos = SunCalc.getPosition(new Date(), at[1], at[0]);
    return { azimuth: pos.azimuth, altitude: pos.altitude, cloud: 20 };
  }, [plan, start]);

  // Light the scene from the sun and keep the sun disc in the right spot of the sky.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current!;
    setSkyPhase(applySun(map, sun));
    const place = () => setSunSpot(threeD ? sunOnScreen(map, sun) : null);
    place();
    map.on('move', place);
    return () => {
      map.off('move', place);
    };
  }, [mapReady, sun, threeD]);

  const calm = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const stopFlight = useCallback(() => {
    cancelAnimationFrame(flight.current);
    flight.current = 0;
    mapRef.current?.stop();
    walker.current?.remove();
    walker.current = null;
    setFlying(false);
  }, []);

  /** The camera position that shows the whole walk. */
  const overview = useCallback((): { center: LngLat; zoom: number } | null => {
    const map = mapRef.current;
    const legs = plan?.route.legs;
    if (!map || !legs?.length) return null;
    const bounds = new maplibregl.LngLatBounds();
    for (const l of legs) for (const c of l.coords) bounds.extend(c);
    const box = map.getContainer().getBoundingClientRect();
    const lngSpan = Math.max(bounds.getEast() - bounds.getWest(), 1e-4);
    const latSpan = Math.max(bounds.getNorth() - bounds.getSouth(), 1e-4) / Math.cos((bounds.getCenter().lat * Math.PI) / 180);
    const fit = (px: number, span: number) => Math.log2((Math.max(px - 80, 100) * 360) / (span * 512));
    // A tilted view foreshortens north-south, so it can sit a little closer.
    const zoom = Math.min(fit(box.width, lngSpan), fit(box.height, latSpan), 17) + (threeD ? 0.25 : 0);
    const c = bounds.getCenter();
    return { center: [c.lng, c.lat], zoom };
  }, [plan, threeD]);

  /**
   * Fly the walk in three acts: swoop down to the start, travel the route at
   * street level looking ahead, then circle the finish before pulling back out.
   */
  const flyRoute = useCallback(() => {
    const map = mapRef.current;
    const legs = plan?.route.legs;
    if (!map || !legs?.length) return;
    const pts: LngLat[] = [];
    for (const l of legs) for (const c of l.coords) if (!pts.length || pts[pts.length - 1][0] !== c[0] || pts[pts.length - 1][1] !== c[1]) pts.push(c);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    const total = cum[cum.length - 1];
    if (total <= 0) return;
    const at = (d: number): LngLat => {
      const x = Math.max(0, Math.min(total, d));
      let i = 1;
      while (i < cum.length - 1 && cum[i] < x) i++;
      const f = cum[i] === cum[i - 1] ? 0 : (x - cum[i - 1]) / (cum[i] - cum[i - 1]);
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    };
    setThreeD(true);
    setFlying(true);
    setFinished(false);

    const orb = document.createElement('div');
    orb.className = 'walker';
    orb.innerHTML = '<span class="walker-glow"></span><span class="walker-core"></span>' + Array.from({ length: 5 }, (_, i) => `<i class="spark" style="--i:${i}"></i>`).join('');
    walker.current?.remove();
    walker.current = new maplibregl.Marker({ element: orb, opacityWhenCovered: '1' }).setLngLat(at(0)).addTo(map);

    // About 45 m of walk per second, between 25 and 90 seconds in all.
    const travelMs = Math.max(25000, Math.min(90000, (total / 45) * 1000));
    const introMs = calm() ? 0 : 2600;
    const orbitMs = calm() ? 0 : 6000;
    let heading = bearingBetween(at(0), at(40));
    const startHeading = heading;
    const from = { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const turn = (a: number, b: number, t: number) => a + ((((b - a + 540) % 360) - 180) * t);
    const began = performance.now();

    const frame = (now: number) => {
      const elapsed = now - began;
      if (elapsed < introMs) {
        // Act one: swoop from wherever the camera is down to street level at the start.
        const t = ease(elapsed / introMs);
        const p0 = at(0);
        map.jumpTo({
          center: [from.center.lng + (p0[0] - from.center.lng) * t, from.center.lat + (p0[1] - from.center.lat) * t],
          zoom: from.zoom + (17.6 - from.zoom) * t,
          pitch: from.pitch + (80 - from.pitch) * t,
          bearing: turn(from.bearing, startHeading, t),
        });
      } else if (elapsed < introMs + travelMs) {
        // Act two: walk it.
        const d = ((elapsed - introMs) / travelMs) * total;
        const here = at(d);
        const want = bearingBetween(here, at(d + 45));
        heading += (((want - heading + 540) % 360) - 180) * 0.06;
        map.jumpTo({ center: here, bearing: heading, pitch: 80, zoom: 17.6 });
        walker.current?.setLngLat(here);
      } else if (elapsed < introMs + travelMs + orbitMs) {
        // Act three: one slow circle around the finish.
        if (!finishedRef.current) {
          finishedRef.current = true;
          setFinished(true);
        }
        const t = (elapsed - introMs - travelMs) / orbitMs;
        map.jumpTo({ center: at(total), bearing: heading + 360 * ease(t), pitch: 80 - 14 * ease(t), zoom: 17.6 - 0.9 * ease(t) });
      } else {
        cancelAnimationFrame(flight.current);
        flight.current = 0;
        walker.current?.remove();
        walker.current = null;
        setFlying(false);
        const view = overview();
        if (view) map.easeTo({ ...view, ...CAMERA_3D, duration: calm() ? 0 : 2200 });
        window.setTimeout(() => setFinished(false), 4000);
        finishedRef.current = false;
        return;
      }
      flight.current = requestAnimationFrame(frame);
    };
    finishedRef.current = false;
    flight.current = requestAnimationFrame(frame);
  }, [plan, overview]);

  useEffect(() => () => cancelAnimationFrame(flight.current), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  /** Run a voting action, asking the person to join first if they have not. */
  const asMember = (fn: () => Promise<void>) => {
    if (!me) {
      setNeedJoin(true);
      return;
    }
    fn().catch((err) => setToast(err instanceof Error ? err.message : String(err)));
  };

  const nextDuel = useCallback(async () => {
    try {
      setDuel(await api<{ a: Card; b: Card }>('/api/matchup'));
    } catch (err) {
      setToast(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (tab === 'vote' && !duel && blocks.length) nextDuel();
    if (tab === 'rank') api<NonNullable<typeof board>>('/api/leaderboard').then(setBoard).catch(() => setBoard(null));
  }, [tab, duel, blocks.length, nextDuel]);

  const designWalk = async () => {
    if (!start) return;
    setPlanning(true);
    setPlanError('');
    setRating(false);
    setStars({});
    setSidePick({});
    try {
      const weightsObj = Object.fromEntries(DIM_KEYS.map((k, i) => [k, weights[i]]));
      setPlan(await api('/api/plan', { start, minutes, weights: weightsObj, when: when ? new Date(when).toISOString() : undefined }));
    } catch (err) {
      setPlan(null);
      setPlanError(err instanceof Error ? err.message : String(err));
    } finally {
      setPlanning(false);
    }
  };

  const saveRatings = () =>
    asMember(async () => {
      if (!plan) return;
      const votes: unknown[] = [];
      const seen = new Set<string>();
      for (const leg of plan.route.legs as RouteLeg[]) {
        if (seen.has(leg.blockId)) continue;
        seen.add(leg.blockId);
        const s = stars[leg.step];
        if (s) votes.push({ blockId: leg.blockId, kind: 'rate', side: 'B', value: s });
        const pick = sidePick[leg.step];
        if (pick && leg.sideLabel) {
          const travelSide = pick === 'same' ? leg.side : flip(leg.side);
          votes.push({ blockId: leg.blockId, kind: 'side', side: leg.forward ? travelSide : flip(travelSide), value: 1 });
        }
      }
      if (!votes.length) {
        setToast('Rate at least one street first.');
        return;
      }
      await api('/api/rate', { votes });
      await api('/api/walks', { name: `${Math.round(plan.route.minutes)} minute walk`, route: plan.route, ctx: plan.ctx });
      setRating(false);
      setToast('Ratings saved. Thank you.');
      loadWorld();
    });

  const thumb = (b: MapBlock, side: 'L' | 'R' | 'B', value: 0 | 1) =>
    asMember(async () => {
      await api('/api/rate', { votes: [{ blockId: b.id, kind: 'thumb', side, value }] });
      setToast('Vote saved.');
      loadWorld();
    });

  const pickWinner = (winner: Card, loser: Card) =>
    asMember(async () => {
      await api('/api/matchup', { winner: winner.id, loser: loser.id });
      await nextDuel();
    });

  const invite = async () => {
    const url = window.location.origin;
    try {
      if (navigator.share) await navigator.share({ title: 'Beautiful Streets', text: 'Help rank the most beautiful streets to walk.', url });
      else {
        await navigator.clipboard.writeText(url);
        setToast('Link copied.');
      }
    } catch {
      /* share sheet dismissed */
    }
  };

  const route = plan?.route;

  return (
    <div className="shell">
      <div className="map">
        <div ref={mapEl} className="map-canvas" />
        {sunSpot && (
          <div className={`sun ${skyPhase}${sunSpot.above ? ' above' : ''}`} style={{ left: sunSpot.x, top: sunSpot.y }} aria-hidden="true" />
        )}
        {finished && (
          <div className="finale" role="status">
            <span>Walk complete</span>
            {Array.from({ length: 14 }, (_, i) => <i key={i} className="spark" style={{ ['--i' as string]: i }} />)}
          </div>
        )}
        <button className="btn small view-toggle" aria-pressed={threeD} onClick={() => { stopFlight(); setThreeD((v) => !v); }}>
          {threeD ? '3D on' : '3D off'}
        </button>
        {source === 'demo' && <div className="banner">Demo grid: these streets and scores are invented. Import real streets to replace them.</div>}
        {loadError && <div className="banner">{loadError}</div>}
        {toast && <div className="banner" role="status">{toast}</div>}
        {selected && (
          <div className="card">
            <header>
              <span className="plate">{selected.name}</span>
              <button className="close" aria-label="Close" onClick={() => setSelected(null)}>×</button>
            </header>
            <div className="muted">
              Score {Math.round(selected.score * 100)} of 100, from map data and {selected.votes} {selected.votes === 1 ? 'vote' : 'votes'}
            </div>
            <div className="bars">
              {DIM_LABELS.map((label, i) => (
                <FragmentRow key={label} label={label} value={selected.dims[i]} />
              ))}
            </div>
            <div className="row">
              <button className="btn small" onClick={() => thumb(selected, 'B', 1)}>Beautiful</button>
              <button className="btn small" onClick={() => thumb(selected, 'B', 0)}>Not for me</button>
              <button className="btn small" onClick={() => { const m = selected.coords[Math.floor(selected.coords.length / 2)]; setStart(m); setSelected(null); setTab('walk'); }}>
                Start my walk here
              </button>
            </div>
            <div className="row">
              <span className="muted">Nicer side:</span>
              <button className="btn small" onClick={() => thumb(selected, 'L', 1)}>{cardinal(selected.bearing + 270)} side</button>
              <button className="btn small" onClick={() => thumb(selected, 'R', 1)}>{cardinal(selected.bearing + 90)} side</button>
            </div>
          </div>
        )}
      </div>

      <section className="sheet">
        <div className="masthead">
          <h1>Beautiful Streets</h1>
          {me ? (
            <button className="who" onClick={invite}>{me.name} · invite a friend</button>
          ) : (
            <button className="who" onClick={() => setNeedJoin(true)}>Join to vote</button>
          )}
        </div>
        <div className="tabs" role="tablist">
          {([['walk', 'Walk'], ['vote', 'Vote'], ['rank', 'Ranking']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        <div className="panel" ref={panelEl}>
          {needJoin && !me && <JoinForm onJoined={(m) => { setMe(m); setNeedJoin(false); }} onCancel={() => setNeedJoin(false)} />}

          {tab === 'walk' && (
            <>
              {!route && (
                <>
                  <div className="field">
                    <label htmlFor="minutes">How long: {minutes} minutes</label>
                    <input id="minutes" type="range" min={15} max={120} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <label htmlFor="when">When (leave empty for now)</label>
                    <input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                  </div>
                  <div className="field">
                    <span className="label">What matters on this walk</span>
                    <div className="weights">
                      {DIM_LABELS.map((label, i) => (
                        <FragmentWeight key={label} label={label} value={weights[i]} onChange={(v) => setWeights((w) => w.map((x, j) => (j === i ? v : x)))} />
                      ))}
                    </div>
                  </div>
                  <p className="muted">The walk starts and ends at the black pin. Drag it, or tap a street and choose "Start my walk here".</p>
                  {planError && <p className="error">{planError}</p>}
                  <button className="btn primary" disabled={planning || !start || !blocks.length} onClick={designWalk}>
                    {planning ? 'Designing…' : 'Design my walk'}
                  </button>
                </>
              )}

              {route && plan && (
                <>
                  <div className="stats">
                    <div><strong>{Math.round(route.minutes)}</strong><span>minutes</span></div>
                    <div><strong>{miles(route.lengthM)}</strong><span>miles</span></div>
                    <div><strong>{feet(route.climbM)}</strong><span>feet of climb</span></div>
                    <div><strong>{Math.round(route.meanScore * 100)}</strong><span>beauty of 100</span></div>
                  </div>
                  <ul className="notes">{plan.ctx.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                  <ol className="steps">
                    {route.steps.map((s, i) => (
                      <li key={i}>
                        {s.sideLabel ? <SideGlyph side={s.side} /> : <span />}
                        <div className="where">
                          <span><span className="plate">{s.name}</span></span>
                          <span className="why">{s.sideLabel ? `Head ${s.heading} on the ${s.sideLabel} side: ${s.reason}` : `Head ${s.heading}`}</span>
                        </div>
                        <span className="dist">{miles(s.len)} mi</span>
                        {rating && (
                          <div className="rate-row">
                            <span className="stars" role="group" aria-label={`Rate ${s.name}`}>
                              {[1, 2, 3, 4, 5].map((n) => (
                                <button key={n} aria-label={`${n} of 5`} aria-pressed={(stars[i] ?? 0) >= n} onClick={() => setStars((x) => ({ ...x, [i]: n }))}>★</button>
                              ))}
                            </span>
                            {s.sideLabel && (
                              <>
                                <button className="btn small" aria-pressed={sidePick[i] === 'same'} onClick={() => setSidePick((x) => ({ ...x, [i]: 'same' }))}>Right side to walk</button>
                                <button className="btn small" aria-pressed={sidePick[i] === 'other'} onClick={() => setSidePick((x) => ({ ...x, [i]: 'other' }))}>Other side is nicer</button>
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                  <div className="row">
                    {rating ? (
                      <button className="btn primary" onClick={saveRatings}>Save ratings</button>
                    ) : (
                      <button className="btn primary" onClick={() => setRating(true)}>I walked it: rate the streets</button>
                    )}
                    <button className="btn" onClick={flying ? stopFlight : flyRoute}>{flying ? 'Stop flight' : 'Fly the walk'}</button>
                    <button className="btn" onClick={() => { stopFlight(); setPlan(null); setRating(false); }}>Design another</button>
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'vote' && (
            <>
              <h2>Which block would you rather walk?</h2>
              <p className="muted">Both are highlighted on the map. Look at each one, then pick. Every pick sharpens the ranking for everyone.</p>
              {duel ? (
                <div className="duel">
                  {(['a', 'b'] as const).map((slot) => {
                    const c = duel[slot];
                    const other = duel[slot === 'a' ? 'b' : 'a'];
                    return (
                      <article key={c.id} data-slot={slot}>
                        <span><span className="plate">{c.name}</span></span>
                        <a target="_blank" rel="noreferrer" href={`https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${c.at[1]},${c.at[0]}&heading=${c.bearing}`}>
                          Look at it in Street View
                        </a>
                        <button className="btn primary" onClick={() => pickWinner(c, other)}>This one</button>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="muted">Finding two blocks…</p>
              )}
              <p style={{ marginTop: 14 }}><button className="btn small" onClick={nextDuel}>Skip this pair</button></p>
            </>
          )}

          {tab === 'rank' && (
            <>
              <h2>Most beautiful streets</h2>
              {board ? (
                <>
                  <ol className="rank">
                    {board.streets.map((s, i) => (
                      <li key={s.name}>
                        <span className="n">{i + 1}</span>
                        <span><span className="plate">{s.name}</span> <span className="muted">{s.votes} {s.votes === 1 ? 'vote' : 'votes'}</span></span>
                        <span className="score">{s.score}</span>
                      </li>
                    ))}
                  </ol>
                  <h2>Most votes cast</h2>
                  {board.voters.length ? (
                    <ol className="rank">
                      {board.voters.map((v, i) => (
                        <li key={v.name + i}><span className="n">{i + 1}</span><span>{v.name}</span><span className="score">{v.votes}</span></li>
                      ))}
                    </ol>
                  ) : (
                    <p className="muted">Nobody has voted yet. Open the Vote tab to be first.</p>
                  )}
                </>
              ) : (
                <p className="muted">Loading the ranking…</p>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function FragmentRow({ label, value }: { label: string; value: number }) {
  return (
    <>
      <span>{label}</span>
      <i style={{ width: `${Math.round(value * 100)}%` }} />
    </>
  );
}

function FragmentWeight({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const id = `w-${label.replace(/\W+/g, '-')}`;
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input id={id} type="range" min={0} max={2} step={0.25} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </>
  );
}

function JoinForm({ onJoined, onCancel }: { onJoined: (me: Me) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await api<{ me: Me }>('/api/join', { name });
      onJoined(res.me);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <form onSubmit={submit} className="field" style={{ borderBottom: '1px solid var(--line)', paddingBottom: 14 }}>
      <label htmlFor="join-name">Your name, so your votes count once</label>
      <div className="row">
        <input id="join-name" type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={40} />
        <button className="btn primary" type="submit">Join</button>
        <button className="btn" type="button" onClick={onCancel}>Not now</button>
      </div>
      {error && <span className="error">{error}</span>}
    </form>
  );
}
