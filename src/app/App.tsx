'use client';

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as SunCalc from 'suncalc';
import { haversine } from '@/lib/geo';
import { Bay } from './bay';
import { Flight, mapStage, RIGS, type FlightState } from './flight';
import Photoreal, { type PhotorealApi } from './Photoreal';
import { badges, coverage, dailyWalk, day, EMPTY_GAME, liveStreak, loadGame, recordWalk, routeGems, saveGame, type GameState } from './game';
import { makeGround } from './ground';
import { horizonY, skySpot, startSky, type SkyView } from './sky';
import { Sound } from './sound';
import { Traffic } from './traffic';
import WeatherLayer from './Weather';
import { applySun, CAMERA_3D, drawVehicles, installLights, installScene, installTrees, setSceneMode, sunOnScreen, type Sun } from './scene';
import type { LngLat, Route, RouteLeg, Side, WalkContext } from '@/lib/types';

interface MapBlock {
  id: string;
  name: string;
  kind: string;
  coords: LngLat[];
  len: number;
  bearing: number;
  score: number;
  votes: number;
  dims: [number, number, number, number];
  elev: number | null;
  grade: number;
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
type Tab = 'walk' | 'vote' | 'rank' | 'you';

type Mood = 'balanced' | 'views' | 'quiet' | 'lively';
/** What each mood asks of the four beauty scores: views, greenery, architecture, street life. */
const MOODS: { id: Mood; label: string; hint: string; weights: [number, number, number, number] }[] = [
  { id: 'balanced', label: 'A bit of everything', hint: 'The best all-round streets', weights: [1, 1, 1, 1] },
  { id: 'views', label: 'Views', hint: 'Hilltops, stairways and the bay', weights: [2.2, 0.8, 1, 0.4] },
  { id: 'quiet', label: 'Quiet and green', hint: 'Trees, gardens, little traffic', weights: [0.8, 2.2, 1, 0.15] },
  { id: 'lively', label: 'Lively', hint: 'Cafes, shopfronts, people', weights: [0.5, 0.5, 1, 2.2] },
];

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

export default function App({ mapStyle, googleKey }: { mapStyle: string; googleKey: string }) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const startMarker = useRef<maplibregl.Marker | null>(null);
  const panelEl = useRef<HTMLDivElement>(null);
  const birdsEl = useRef<HTMLCanvasElement>(null);
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
  const flightRef = useRef<Flight | null>(null);
  const [film, setFilm] = useState<FlightState | null>(null);
  const [scores, setScores] = useState(false);
  // The photoreal city: Google's real buildings in place of the drawn ones.
  const [real, setReal] = useState(false);
  const [gKey, setGKey] = useState(googleKey);
  const [askKey, setAskKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const realApi = useRef<PhotorealApi | null>(null);
  const [realReady, setRealReady] = useState(false);
  const introFor = useRef<unknown>(null);
  const [sunSpot, setSunSpot] = useState<{ x: number; y: number; above: boolean } | null>(null);
  const [skyPhase, setSkyPhase] = useState<'night' | 'golden' | 'day'>('day');
  /** The hour shown: the real one, or day or night on request. */
  const [timeMode, setTimeMode] = useState<'auto' | 'day' | 'night'>('auto');
  const [treesIn, setTreesIn] = useState(false);
  const [nightSky, setNightSky] = useState<{ horizon: number; fade: number; moon: { x: number; y: number } | null } | null>(null);
  const [game, setGame] = useState<GameState>(EMPTY_GAME);
  const [logged, setLogged] = useState<{ newStreets: number; gems: number; streak: number } | null>(null);
  const [isDaily, setIsDaily] = useState(false);
  const [muted, setMuted] = useState(false);
  const [pickup, setPickup] = useState<{ n: number; label: string } | null>(null);
  const sound = useRef<Sound | null>(null);
  const gemMarkers = useRef<maplibregl.Marker[]>([]);
  const realNow = useRef(false);
  const nightNow = useRef(false);

  const [start, setStart] = useState<LngLat | null>(null);
  const [minutes, setMinutes] = useState(45);
  const [when, setWhen] = useState('');
  // The few choices that really change a walk. Remembered between visits.
  const [mood, setMood] = useState<Mood>('balanced');
  const [hills, setHills] = useState<'avoid' | 'ok' | 'seek'>('ok');
  const [noStairs, setNoStairs] = useState(false);
  const [startLabel, setStartLabel] = useState('');
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<{ label: string; at: LngLat }[]>([]);
  const [nowCtx, setNowCtx] = useState<WalkContext | null>(null);
  const prefsLoaded = useRef(false);
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
        // Streets already walked stay lit: a soft glow under a bright gold line.
        map.addSource('walked', { type: 'geojson', data: empty });
        map.addLayer({
          id: 'walked-glow',
          type: 'line',
          source: 'walked',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffc93c', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 5, 17, 20], 'line-blur': 8, 'line-opacity': 0.55 },
        });
        map.addLayer({
          id: 'walked',
          type: 'line',
          source: 'walked',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffd966', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.6, 17, 5] },
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
        // Start with the map credits folded to their (i) button so they do not cover the picture.
        const credits = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
        credits?.classList.remove('maplibregl-compact-show');
        credits?.removeAttribute('open');
        fetch('/api/trees')
          .then((r) => r.json())
          .then((j: { trees: LngLat[] }) => {
            if (!cancelled && map) {
              installTrees(map, j.trees);
              setTreesIn(true);
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
        setStartLabel('the dropped pin');
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
          // MapLibre positions a marker by transforming its element, so the
          // animated block has to be a child or the animation would move it away.
          const el = document.createElement('div');
          const block = document.createElement('div');
          block.className = 'crumb';
          block.style.setProperty('--n', String(crumbs.current.length));
          el.appendChild(block);
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

  // Remember the walker's choices and starting point between visits.
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem('bs.prefs') ?? 'null');
      if (saved) {
        if (MOODS.some((m) => m.id === saved.mood)) setMood(saved.mood);
        if (['avoid', 'ok', 'seek'].includes(saved.hills)) setHills(saved.hills);
        setNoStairs(saved.noStairs === true);
        if (saved.minutes >= 15 && saved.minutes <= 120) setMinutes(saved.minutes);
        if (Array.isArray(saved.start) && saved.start.length === 2) {
          setStart(saved.start);
          setStartLabel(typeof saved.startLabel === 'string' ? saved.startLabel : '');
        }
      }
    } catch {
      /* nothing saved, or storage unavailable */
    }
    prefsLoaded.current = true;
  }, []);
  useEffect(() => {
    if (!prefsLoaded.current) return;
    try {
      window.localStorage.setItem('bs.prefs', JSON.stringify({ mood, hills, noStairs, minutes, start, startLabel }));
    } catch {
      /* storage unavailable */
    }
  }, [mood, hills, noStairs, minutes, start, startLabel]);

  // Conditions right now at the start, so the scene shows today's weather before a walk is designed.
  const startKey = start ? `${start[0].toFixed(3)},${start[1].toFixed(3)}` : '';
  useEffect(() => {
    if (!start) return;
    let stale = false;
    fetch(`/api/weather?lng=${start[0].toFixed(4)}&lat=${start[1].toFixed(4)}`)
      .then((r) => r.json())
      .then((j: { ctx?: WalkContext }) => {
        if (!stale && j.ctx) setNowCtx(j.ctx);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey]);

  // Look up places as the walker types a starting point.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setPlaces([]);
      return;
    }
    const timer = window.setTimeout(() => {
      // Photon is OpenStreetMap's free place search; results are limited to the map's area.
      fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5&lat=37.8&lon=-122.42&bbox=-122.447,37.787,-122.4,37.811`)
        .then((r) => r.json())
        .then((j: { features?: { geometry: { coordinates: [number, number] }; properties: Record<string, string> }[] }) => {
          setPlaces(
            (j.features ?? []).map((f) => {
              const p = f.properties;
              const line = [p.name, [p.housenumber, p.street].filter(Boolean).join(' ')].filter(Boolean);
              return { label: [...new Set(line)].join(', ') || p.street || 'Unnamed place', at: f.geometry.coordinates };
            }),
          );
        })
        .catch(() => setPlaces([]));
    }, 280);
    return () => window.clearTimeout(timer);
  }, [query]);

  /** Move the start of the walk, and the camera with it. */
  const startAt = (at: LngLat, label: string) => {
    setStart(at);
    setStartLabel(label);
    setQuery('');
    setPlaces([]);
    setPlan(null);
    mapRef.current?.easeTo({ center: at, zoom: Math.max(mapRef.current.getZoom(), 15.6), duration: 900 });
    realApi.current?.frame({ center: at, zoom: 15.8 }, CAMERA_3D.pitch, CAMERA_3D.bearing);
  };

  const locateMe = () => {
    if (!navigator.geolocation) {
      setToast('This browser cannot share its location.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const at: LngLat = [pos.coords.longitude, pos.coords.latitude];
        // Outside the mapped neighbourhoods there are no streets to plan on.
        if (at[0] < -122.447 || at[0] > -122.4 || at[1] < 37.787 || at[1] > 37.811) {
          setToast('You are outside the area this version covers: Russian Hill and its neighbours.');
          return;
        }
        startAt(at, 'My location');
      },
      () => setToast('Location was not shared. Search for a place or drag the pin instead.'),
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  // Street life: cars and the Hyde Street cable car, around wherever the camera is looking.
  const traffic = useMemo(() => (blocks.length ? new Traffic(blocks.map((b) => ({ name: b.name, kind: b.kind, coords: b.coords }))) : null), [blocks]);
  const bay = useMemo(() => new Bay(), []);
  useEffect(() => {
    if (!mapReady || !traffic || !threeD || calm()) return;
    const map = mapRef.current!;
    let raf = 0;
    let last = performance.now();
    let drawn = 0;
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const api = real ? realApi.current : null;
      const c = map.getCenter();
      const focus: LngLat = api ? api.stage.current().look : [c.lng, c.lat];
      const vehicles = [...traffic.step(dt, focus), ...bay.step(dt)];
      // The real city redraws models, which is heavier, so it updates a little less often.
      if (now - drawn > (api ? 50 : 33)) {
        drawn = now;
        if (api) api.vehicles(vehicles);
        else if (!real && map.getZoom() > 13) drawVehicles(map, vehicles, nightNow.current);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, traffic, bay, threeD, real, realReady]);

  realNow.current = real;
  nightNow.current = skyPhase === 'night';
  /** The camera in use, whichever city is showing: what the sky is drawn through. */
  const skyView = useCallback((): SkyView | null => {
    const map = mapRef.current;
    const el = birdsEl.current;
    if (!map || !el) return null;
    const box = el.getBoundingClientRect();
    if (realNow.current) {
      const api = realApi.current;
      return api ? { shot: api.stage.current(), width: box.width, height: box.height } : null;
    }
    const c = map.getCenter();
    return { shot: { look: [c.lng, c.lat], bearing: map.getBearing(), pitch: map.getPitch(), zoom: map.getZoom(), lens: map.getVerticalFieldOfView?.() ?? 36.87 }, width: box.width, height: box.height };
  }, []);

  // Gulls and aircraft over the city, in 3D only.
  useEffect(() => {
    if (!mapReady || !threeD || !birdsEl.current || calm()) return;
    return startSky(birdsEl.current, skyView, () => nightNow.current);
  }, [mapReady, threeD, skyView]);

  // Flat or 3D, by day or by night. Street lamps go in once the streets are known.
  useEffect(() => {
    if (!mapReady) return;
    const map = mapRef.current!;
    if (blocks.length) installLights(map, blocks);
    setSceneMode(map, threeD, scores, skyPhase === 'night');
    // The You tab shows the collection: every other street fades back.
    if (tab === 'you' && map.getLayer('blocks')) map.setPaintProperty('blocks', 'line-opacity', threeD ? 0 : 0.2);
  }, [mapReady, threeD, scores, skyPhase, blocks, treesIn, tab]);

  // Progress in the game, kept in this browser.
  useEffect(() => {
    setGame(loadGame());
    try {
      setMuted(window.localStorage.getItem('bs.sound') === 'off');
    } catch {
      /* storage unavailable */
    }
    sound.current = new Sound();
    return () => sound.current?.dispose();
  }, []);
  useEffect(() => {
    sound.current?.setMuted(muted);
  }, [muted]);

  // Light up the streets already walked.
  useEffect(() => {
    if (!mapReady) return;
    (mapRef.current!.getSource('walked') as GeoJSONSource | undefined)?.setData(lines(blocks.filter((b) => game.walked[b.id]).map((b) => line(b.coords, {}))));
  }, [mapReady, blocks, game.walked]);

  // Where the sun is: at the walk's start time once a walk is designed, otherwise now.
  const sun: Sun = useMemo(() => {
    const cloud = plan?.ctx.weather?.cloudPct ?? nowCtx?.weather?.cloudPct ?? 20;
    if (timeMode === 'day') return { azimuth: 205, altitude: 46, cloud };
    if (timeMode === 'night') return { azimuth: 300, altitude: -32, cloud };
    if (plan) return { azimuth: plan.ctx.sunAzimuth, altitude: plan.ctx.sunAltitude, cloud: plan.ctx.weather?.cloudPct ?? 20 };
    if (nowCtx) return { azimuth: nowCtx.sunAzimuth, altitude: nowCtx.sunAltitude, cloud: nowCtx.weather?.cloudPct ?? 20 };
    const at = start ?? [-122.4194, 37.8021];
    const pos = SunCalc.getPosition(new Date(), at[1], at[0]);
    return { azimuth: pos.azimuth, altitude: pos.altitude, cloud: 20 };
  }, [plan, start, nowCtx, timeMode]);

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

  // Stars and the moon. They sit over the picture, so they fade out when the camera
  // comes down among the buildings, where rooftops would cut into the sky.
  useEffect(() => {
    if (!mapReady || !threeD || skyPhase !== 'night') {
      setNightSky(null);
      return;
    }
    const tick = () => {
      const v = skyView();
      if (!v) return;
      const horizon = Math.round(horizonY(v));
      const fade = Math.max(0, Math.min(1, (77 - v.shot.pitch) / 9));
      const at = start ?? [-122.4194, 37.8021];
      const moonAt = SunCalc.getMoonPosition(plan ? new Date(plan.ctx.when) : new Date(), at[1], at[0]);
      const moon = skySpot(v, moonAt.azimuth, moonAt.altitude);
      setNightSky((cur) => {
        const next = horizon > 24 && fade > 0.02 ? { horizon, fade: Math.round(fade * 20) / 20, moon: moon ? { x: Math.round(moon.x), y: Math.round(moon.y) } : null } : null;
        return JSON.stringify(cur) === JSON.stringify(next) ? cur : next;
      });
    };
    tick();
    const timer = window.setInterval(tick, 90);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, threeD, skyPhase, skyView, plan, start?.[0], start?.[1]]);

  const calm = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  /** End the film and hand the map back. */
  const endFilm = useCallback(() => {
    flightRef.current?.dispose();
    flightRef.current = null;
    setFilm(null);
  }, []);

  /** Start the film of the walk: an establishing shot, the walk itself, and a finale. */
  const startFilm = useCallback(() => {
    const map = mapRef.current;
    const view = overview();
    if (!map || !plan || !view) return;
    flightRef.current?.dispose();
    sound.current?.unlock();
    setThreeD(true);
    const flight = new Flight(real && realApi.current ? realApi.current.stage : mapStage(map), plan.route.legs, view, setFilm, calm());
    if (!flight.valid) {
      flight.dispose();
      return;
    }
    flightRef.current = flight;
    flight.play();
  }, [plan, overview, real]);

  // After the last frame, hold briefly, then hand the map back.
  useEffect(() => {
    if (film?.phase !== 'done') return;
    const t = window.setTimeout(endFilm, 1200);
    return () => window.clearTimeout(t);
  }, [film?.phase, endFilm]);

  useEffect(() => () => flightRef.current?.dispose(), []);

  // A key saved in this browser earlier.
  useEffect(() => {
    if (gKey) return;
    try {
      const saved = window.localStorage.getItem('bs.googleKey');
      if (saved) setGKey(saved);
    } catch {
      /* storage unavailable */
    }
  }, [gKey]);

  /** Ground height anywhere on the streets, in metres above sea level. */
  const ground = useMemo(() => makeGround(blocks), [blocks]);

  const toggleReal = () => {
    if (real) {
      endFilm();
      setReal(false);
      return;
    }
    if (!gKey) {
      setAskKey(true);
      return;
    }
    endFilm();
    setThreeD(true);
    setReal(true);
  };

  const saveKey = (e: React.FormEvent) => {
    e.preventDefault();
    const k = keyDraft.trim();
    if (!k) return;
    try {
      window.localStorage.setItem('bs.googleKey', k);
    } catch {
      /* storage unavailable; the key still works for this visit */
    }
    setGKey(k);
    setKeyDraft('');
    setAskKey(false);
    endFilm();
    setThreeD(true);
    setReal(true);
  };

  // Keep the photoreal camera on the walk when it changes.
  useEffect(() => {
    if (!real || !realReady || film) return;
    const view = overview() ?? (start ? { center: start, zoom: 15.6 } : null);
    if (view) realApi.current?.frame(view, CAMERA_3D.pitch, CAMERA_3D.bearing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, realReady, plan]);

  /** Nudge the camera by hand: rotate around the view, or tilt up and down. */
  const nudge = (bearing: number, pitch: number) => {
    if (real && realApi.current) {
      realApi.current.nudge(bearing, pitch);
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    map.easeTo({ bearing: map.getBearing() + bearing, pitch: Math.max(0, Math.min(85, map.getPitch() + pitch)), duration: 500 });
  };

  /** Every change of street along the walk: where it is, which way it bends, and what comes next. */
  const turns = useMemo(() => {
    const legs = plan?.route.legs ?? [];
    const steps = plan?.route.steps ?? [];
    // The whole path with running distance, so headings can be measured a little
    // before and after each corner instead of between two neighbouring points.
    const pts: LngLat[] = [];
    const cum: number[] = [];
    const starts: number[] = [];
    for (const leg of legs) {
      starts.push(cum.length ? cum[cum.length - 1] : 0);
      for (const c of leg.coords) {
        const prev = pts[pts.length - 1];
        if (prev && prev[0] === c[0] && prev[1] === c[1]) continue;
        cum.push(prev ? cum[cum.length - 1] + haversine(prev, c) : 0);
        pts.push(c);
      }
    }
    const total = cum[cum.length - 1] ?? 0;
    const at = (d: number): LngLat => {
      const x = Math.max(0, Math.min(total, d));
      let i = 1;
      while (i < cum.length - 1 && cum[i] < x) i++;
      const span = cum[i] - cum[i - 1];
      const f = span ? (x - cum[i - 1]) / span : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f];
    };
    const toDeg = (p: LngLat, q: LngLat) => (Math.atan2((q[0] - p[0]) * Math.cos((p[1] * Math.PI) / 180), q[1] - p[1]) * 180) / Math.PI;
    const out: { at: number; where: LngLat; angle: number; name: string }[] = [];
    if (pts.length < 2) return out;
    for (let i = 1; i < legs.length; i++) {
      if (legs[i].step === legs[i - 1].step) continue;
      const d = starts[i];
      const angle = ((toDeg(at(d + 4), at(d + 30)) - toDeg(at(d - 30), at(d - 4)) + 540) % 360) - 180;
      // The same street continuing, only on its other side, is not a turn.
      if (steps[legs[i].step]?.name !== steps[legs[i - 1].step]?.name || Math.abs(angle) > 30)
        out.push({ at: d, where: at(d), angle, name: steps[legs[i].step]?.name ?? '' });
    }
    return out;
  }, [plan]);

  const nextTurn = film && film.phase === 'travel' ? turns.find((t) => t.at > film.metres + 4) ?? null : null;
  const turnWord = (angle: number) =>
    Math.abs(angle) > 150 ? 'Turn around' : Math.abs(angle) < 25 ? 'Continue' : `${Math.abs(angle) < 60 ? 'Bear' : 'Turn'} ${angle < 0 ? 'left' : 'right'}`;
  const feetOrMiles = (m: number) => (m < 300 ? `${Math.max(10, Math.round((m * 3.28084) / 10) * 10)} ft` : `${miles(m)} mi`);

  // Gems wait at the best spots of the walk and are picked up as the walker passes.
  const gems = useMemo(() => (plan ? routeGems(plan.route.legs, (id) => byId.get(id)) : []), [plan, byId]);
  const gemsGot = film ? gems.filter((g) => g.at <= film.metres + 3).length : 0;
  useEffect(() => {
    for (const m of gemMarkers.current) m.remove();
    gemMarkers.current = [];
    if (!mapReady || tab !== 'walk') return;
    for (const gem of gems) {
      // The marker's own element is moved by the map, so the animated gem is a child.
      const el = document.createElement('div');
      const inner = document.createElement('div');
      inner.className = `gem ${gem.kind}`;
      inner.title = gem.label;
      el.appendChild(inner);
      gemMarkers.current.push(new maplibregl.Marker({ element: el, anchor: 'bottom', opacityWhenCovered: '1' }).setLngLat(gem.where).addTo(mapRef.current!));
    }
  }, [mapReady, gems, tab]);
  const gotBefore = useRef(0);
  useEffect(() => {
    gemMarkers.current.forEach((m, i) => m.getElement().classList.toggle('got', i < gemsGot));
    if (real) realApi.current?.gems(tab === 'walk' ? gems.slice(gemsGot).map((g) => ({ where: g.where, label: g.label })) : []);
    if (film?.playing && film.phase === 'travel' && gemsGot > gotBefore.current) {
      sound.current?.chime(gemsGot);
      setPickup({ n: gemsGot, label: gems[gemsGot - 1].label });
    }
    gotBefore.current = gemsGot;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gemsGot, gems, real, realReady, tab]);
  useEffect(() => {
    if (!pickup) return;
    const t = window.setTimeout(() => setPickup(null), 2800);
    return () => window.clearTimeout(t);
  }, [pickup]);

  // Footsteps and city air while the walker is moving; a flourish at the finish.
  const moving = !!film?.playing && film.phase === 'travel';
  useEffect(() => {
    sound.current?.walking(moving, skyPhase !== 'night');
    return () => sound.current?.walking(false);
  }, [moving, skyPhase, muted]);
  useEffect(() => {
    if (film?.phase === 'finale') sound.current?.fanfare();
  }, [film?.phase]);

  // Label the coming turn out in the city, when the stage can.
  const turnKey = nextTurn ? `${nextTurn.at}` : '';
  useEffect(() => {
    if (!real) return;
    realApi.current?.nextTurn(nextTurn ? nextTurn.where : null, nextTurn?.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turnKey, real, realReady]);

  // Dim the part of the block trail that has been walked.
  useEffect(() => {
    const done = film ? Math.floor(film.metres / 35) : -1;
    crumbs.current.forEach((c, i) => c.getElement().classList.toggle('walked', i < done));
  }, [film?.metres, film]);

  const filmLeg = film && plan ? plan.route.legs[Math.min(film.leg, plan.route.legs.length - 1)] : null;
  const filmStep = filmLeg && plan ? plan.route.steps[filmLeg.step] : null;
  // The cable car rings its bell as the walk joins Hyde Street.
  const onHyde = moving && !!filmStep?.name.includes('Hyde');
  useEffect(() => {
    if (onHyde) sound.current?.bell();
  }, [onHyde]);

  const [today, setToday] = useState('');
  useEffect(() => setToday(day()), []);
  const daily = useMemo(() => (today ? dailyWalk(today) : null), [today]);
  const cover = useMemo(() => coverage(game, blocks), [game, blocks]);
  const badgeList = useMemo(() => badges(game, cover), [game, cover]);
  const streak = today ? liveStreak(game, today) : 0;

  /** Count the designed walk as walked: its streets, its gems and today's streak. */
  const logWalk = () => {
    if (!plan || logged) return;
    const result = recordWalk(game, { blockIds: plan.route.legs.map((l) => l.blockId), lengthM: plan.route.lengthM, climbM: plan.route.climbM, gems: gems.length, ctx: plan.ctx });
    setGame(result.state);
    saveGame(result.state);
    setLogged({ newStreets: result.newStreets, gems: gems.length, streak: result.state.streak });
    sound.current?.fanfare();
  };

  const toggleSound = () => {
    const next = !muted;
    setMuted(next);
    try {
      window.localStorage.setItem('bs.sound', next ? 'off' : 'on');
    } catch {
      /* storage unavailable */
    }
  };

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 6000);
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

  const designWalk = async (preset?: { mood: Mood; minutes: number; hills: 'avoid' | 'ok' | 'seek' }) => {
    if (!start) return;
    if (preset) {
      setMood(preset.mood);
      setMinutes(preset.minutes);
      setHills(preset.hills);
    }
    setIsDaily(!!preset);
    setLogged(null);
    setPlanning(true);
    setPlanError('');
    setRating(false);
    setStars({});
    setSidePick({});
    try {
      const weights = MOODS.find((m) => m.id === (preset?.mood ?? mood))!.weights;
      const weightsObj = Object.fromEntries(DIM_KEYS.map((k, i) => [k, weights[i]]));
      setPlan(await api('/api/plan', { start, minutes: preset?.minutes ?? minutes, weights: weightsObj, hills: preset?.hills ?? hills, noStairs, when: when ? new Date(when).toISOString() : undefined }));
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
    <div className={`shell${film ? ' filming' : ''}`}>
      <div className={`map ${skyPhase}${threeD ? ' scene' : ''}${film ? ' cinema' : ''}${real ? ' real' : ''}`}>
        <div ref={mapEl} className="map-canvas" />
        {sunSpot && (
          <div className={`sun ${skyPhase}${sunSpot.above ? ' above' : ''}`} style={{ left: sunSpot.x, top: sunSpot.y }} aria-hidden="true" />
        )}
        {nightSky && <div className="stars" style={{ height: nightSky.horizon, opacity: nightSky.fade }} aria-hidden="true" />}
        {nightSky?.moon && <div className="moon" style={{ left: nightSky.moon.x, top: nightSky.moon.y, opacity: nightSky.fade }} aria-hidden="true" />}
        {real && gKey && start && (
          <Photoreal
            apiKey={gKey}
            start={start}
            legs={plan?.route.legs ?? null}
            altitude={ground}
            onReady={(api) => {
              realApi.current = api;
              setRealReady(!!api);
            }}
            onError={(message, keyRefused) => {
              setReal(false);
              // Forget a key typed here only if Google refused it, so it can be entered again.
              if (keyRefused && !googleKey) {
                try {
                  window.localStorage.removeItem('bs.googleKey');
                } catch {
                  /* storage unavailable */
                }
                setGKey('');
              }
              setToast(`Real buildings could not load. ${message}`);
            }}
          />
        )}
        {askKey && (
          <form className="card key-card" onSubmit={saveKey}>
            <header>
              <strong>Real buildings need a Google Maps key</strong>
              <button type="button" className="close" aria-label="Close" onClick={() => setAskKey(false)}>×</button>
            </header>
            <p className="muted">
              Create a key in Google Cloud with the Maps JavaScript API enabled, then paste it here. It is saved in this browser only.
            </p>
            <div className="row">
              <input type="text" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} placeholder="Google Maps key" aria-label="Google Maps key" autoFocus />
              <button className="btn primary" type="submit">Show the real city</button>
            </div>
          </form>
        )}
        <canvas ref={birdsEl} className="birds" aria-hidden="true" />
        {threeD && <WeatherLayer weather={plan?.ctx.weather ?? nowCtx?.weather ?? null} night={skyPhase === 'night'} quiet={calm()} />}
        {threeD && <div className="grade" aria-hidden="true" />}
        {film && <div className="bars" aria-hidden="true" />}
        {film && film.cuts > 0 && <div key={`cut-${film.cuts}`} className="cut" aria-hidden="true" />}
        {film?.phase === 'finale' && (
          <div className="finale" role="status">
            <span>Walk complete{gems.length ? `: ${gems.length} gems on this route` : ''}</span>
            {Array.from({ length: 14 }, (_, i) => <i key={i} className="spark" style={{ ['--i' as string]: i }} />)}
          </div>
        )}
        {film && film.phase === 'travel' && plan && (
          <div className="hud" role="status">
            <div className="hud-turn" key={nextTurn ? `turn-${nextTurn.at}` : 'finish'}>
              <svg className="hud-arrow" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
                <g transform={`rotate(${nextTurn ? Math.max(-150, Math.min(150, nextTurn.angle)) : 0} 22 22)`}>
                  <path d="M22 36 V12 M12 21 L22 10 L32 21" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
                </g>
              </svg>
              <div className="hud-text">
                <span className="hud-distance">In {feetOrMiles((nextTurn ? nextTurn.at : film.total) - film.metres)}</span>
                <span className="hud-action">{nextTurn ? `${turnWord(nextTurn.angle)} onto ${nextTurn.name}` : 'Finish where you started'}</span>
              </div>
            </div>
            <div className="hud-progress">
              <span>{miles(film.metres)} of {miles(film.total)} mi</span>
              {gems.length > 0 && <span className="hud-gems"><i className="gem-icon" aria-hidden="true" />{gemsGot} of {gems.length} gems</span>}
              <span>{Math.max(0, Math.round(plan.route.minutes * (1 - film.progress)))} min of walking left</span>
            </div>
          </div>
        )}
        {film && filmStep && film.phase === 'travel' && (
          <div className="lower-third" key={`caption-${filmLeg!.step}`}>
            <span className="plate">{filmStep.name}</span>
            {filmStep.sideLabel && <span className="lower-note">{filmStep.sideLabel} side, {filmStep.reason}</span>}
          </div>
        )}

        {film && pickup && (
          <div className="pickup" key={`pickup-${pickup.n}`} role="status">
            <i className="gem-icon" aria-hidden="true" />
            {pickup.label}
          </div>
        )}

        {film ? (
          <div className="transport" role="group" aria-label="Film controls">
            <button className="tbtn big" aria-label={film.playing ? 'Pause' : 'Play'} onClick={() => flightRef.current?.toggle()}>{film.playing ? '❚❚' : '▶'}</button>
            <input
              className="scrub"
              type="range"
              min={0}
              max={1000}
              value={Math.round(film.progress * 1000)}
              aria-label="Position in the walk"
              onChange={(e) => flightRef.current?.seek(Number(e.target.value) / 1000)}
            />
            <button className="tbtn" aria-label="Playback speed" onClick={() => flightRef.current?.setSpeed(film.speed >= 4 ? 1 : film.speed * 2)}>{film.speed}×</button>
            <button className="tbtn" aria-label="Sound" aria-pressed={!muted} title={muted ? 'Sound is off' : 'Sound is on'} onClick={toggleSound}>♪</button>
            <button className="tbtn" aria-label="End film" onClick={endFilm}>✕</button>
            <div className="rigs">
              {RIGS.map((r) => (
                <button key={r.id} className="tbtn" title={r.hint} aria-pressed={film.rig === r.id} onClick={() => flightRef.current?.setRig(r.id)}>{r.label}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="dock" role="group" aria-label="Map view">
            <button className="tbtn" aria-pressed={threeD} onClick={() => { if (real) { setReal(false); return; } setThreeD((v) => !v); }}>3D</button>
            <button className="tbtn" aria-pressed={real} title="Real facades and roofs from aerial imagery" onClick={toggleReal}>Real</button>
            {threeD && (
              <>
                <button className="tbtn" aria-label="Rotate left" onClick={() => nudge(-35, 0)}>↺</button>
                <button className="tbtn" aria-label="Rotate right" onClick={() => nudge(35, 0)}>↻</button>
                <button className="tbtn" aria-label="Tilt toward the horizon" onClick={() => nudge(0, 10)}>▲</button>
                <button className="tbtn" aria-label="Tilt toward the ground" onClick={() => nudge(0, -10)}>▼</button>
                {!real && <button className="tbtn" aria-pressed={scores} title="Colour every street by its beauty score" onClick={() => setScores((v) => !v)}>Scores</button>}
                <button
                  className="tbtn"
                  aria-label={`Time of day shown: ${timeMode === 'auto' ? 'the real time' : timeMode}. Press to change.`}
                  title="Show the city as it is now, by day, or by night"
                  onClick={() => setTimeMode((m) => (m === 'auto' ? 'day' : m === 'day' ? 'night' : 'auto'))}
                >
                  {timeMode === 'auto' ? 'Now' : timeMode === 'day' ? 'Day' : 'Night'}
                </button>
              </>
            )}
            {plan && <button className="tbtn play" onClick={startFilm}>▶ Play the walk</button>}
          </div>
        )}
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
          <button className="tally" onClick={() => setTab('you')} aria-label={`Your progress: ${streak} day streak, ${game.gems} gems`}>
            {streak > 0 && <span className="tally-streak">{streak}-day streak</span>}
            <span><i className="gem-icon" aria-hidden="true" />{game.gems}</span>
          </button>
          {me ? (
            <button className="who" onClick={invite}>{me.name} · invite a friend</button>
          ) : (
            <button className="who" onClick={() => setNeedJoin(true)}>Join to vote</button>
          )}
        </div>
        <div className="tabs" role="tablist">
          {([['walk', 'Walk'], ['vote', 'Vote'], ['rank', 'Ranking'], ['you', 'You']] as [Tab, string][]).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>

        <div className="panel" ref={panelEl}>
          {needJoin && !me && <JoinForm onJoined={(m) => { setMe(m); setNeedJoin(false); }} onCancel={() => setNeedJoin(false)} />}

          {tab === 'walk' && (
            <>
              {!route && (
                <>
                  {daily && (
                    <div className="daily">
                      <div>
                        <span className="label">Today&rsquo;s walk</span>
                        <strong>{daily.title}</strong>
                        <span className="muted">{daily.minutes} minutes. {daily.blurb}.{game.last === today ? ' You have walked today.' : streak > 0 ? ` Walk today to keep your ${streak}-day streak.` : ''}</span>
                      </div>
                      <button className="btn small" disabled={planning || !start || !blocks.length} onClick={() => designWalk(daily)}>Design it</button>
                    </div>
                  )}
                  <div className="field place">
                    <label htmlFor="start">Start from</label>
                    <div className="row">
                      <input
                        id="start"
                        type="text"
                        value={query}
                        placeholder={startLabel || 'An address, cafe or corner'}
                        onChange={(e) => setQuery(e.target.value)}
                        autoComplete="off"
                      />
                      <button type="button" className="btn small" onClick={locateMe}>My location</button>
                    </div>
                    {places.length > 0 && (
                      <ul className="places">
                        {places.map((p, i) => (
                          <li key={`${p.label}-${i}`}>
                            <button type="button" onClick={() => startAt(p.at, p.label)}>{p.label}</button>
                          </li>
                        ))}
                      </ul>
                    )}
                    <span className="muted">{startLabel ? `Starting at ${startLabel}. ` : ''}You can also drag the gem on the map.</span>
                  </div>
                  <div className="field">
                    <label htmlFor="minutes">How long: {minutes} minutes</label>
                    <input id="minutes" type="range" min={15} max={120} step={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
                  </div>
                  <div className="field">
                    <span className="label">In the mood for</span>
                    <div className="chips" role="radiogroup" aria-label="Mood">
                      {MOODS.map((m) => (
                        <button key={m.id} type="button" role="radio" aria-checked={mood === m.id} title={m.hint} className="chip" onClick={() => setMood(m.id)}>{m.label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="field">
                    <span className="label">Hills</span>
                    <div className="chips" role="radiogroup" aria-label="Hills">
                      {([['avoid', 'Keep it gentle'], ['ok', 'As they come'], ['seek', 'Give me a climb']] as const).map(([id, label]) => (
                        <button key={id} type="button" role="radio" aria-checked={hills === id} className="chip" onClick={() => setHills(id)}>{label}</button>
                      ))}
                    </div>
                    <label className="check">
                      <input type="checkbox" checked={noStairs} onChange={(e) => setNoStairs(e.target.checked)} /> No stairways
                    </label>
                  </div>
                  <div className="field">
                    <label htmlFor="when">Leaving (empty means now)</label>
                    <input id="when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                  </div>
                  {planError && <p className="error">{planError}</p>}
                  <button className="btn primary" disabled={planning || !start || !blocks.length} onClick={() => designWalk()}>
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
                  {isDaily && daily && <p className="daily-name">Today&rsquo;s walk: {daily.title}</p>}
                  {logged && (
                    <p className="logged" role="status">
                      Walk logged. {logged.newStreets} new {logged.newStreets === 1 ? 'block' : 'blocks'} on your map, {logged.gems} gems, {logged.streak}-day streak.
                    </p>
                  )}
                  <ul className="notes">
                    {gems.length > 0 && <li>{gems.length} gems on this route, at its best spots.</li>}
                    {plan.ctx.notes.map((n) => <li key={n}>{n}</li>)}
                  </ul>
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
                      <button className="btn primary" onClick={() => { logWalk(); setRating(true); }}>I walked it: rate the streets</button>
                    )}
                    <button className="btn" onClick={startFilm}>▶ Play the walk</button>
                    <button className="btn" onClick={() => { endFilm(); setPlan(null); setRating(false); setLogged(null); }}>Design another</button>
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'you' && (
            <>
              <div className="stats">
                <div><strong>{streak}</strong><span>day streak</span></div>
                <div><strong>{game.gems}</strong><span>gems</span></div>
                <div><strong>{game.walks.length}</strong><span>{game.walks.length === 1 ? 'walk' : 'walks'}</span></div>
                <div><strong>{(cover.fraction * 100).toFixed(1)}%</strong><span>of the map walked</span></div>
              </div>
              <div className="meter" role="img" aria-label={`${(cover.fraction * 100).toFixed(1)} percent of the streets walked`}>
                <i style={{ width: `${Math.max(cover.fraction * 100, 0.6)}%` }} />
              </div>
              <p className="muted">
                {miles(cover.metres)} of {miles(cover.total)} miles of street walked. Streets you have walked glow gold on the map{threeD ? '; turn off 3D to see them all at once' : ''}.
              </p>
              {!game.walks.length && <p className="muted">Design a walk, go and walk it, then press &ldquo;I walked it&rdquo; to light up its streets and keep its gems.</p>}
              <h2>Badges</h2>
              <ul className="badges">
                {badgeList.map((b) => (
                  <li key={b.id} className={b.earned ? 'earned' : undefined}>
                    <strong>{b.name}</strong>
                    <span>{b.earned ? 'Earned' : `${b.how}${b.progress ? ` (${b.progress})` : ''}`}</span>
                  </li>
                ))}
              </ul>
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
