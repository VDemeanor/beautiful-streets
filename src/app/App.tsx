'use client';

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection } from 'geojson';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const [mapReady, setMapReady] = useState(false);

  const [blocks, setBlocks] = useState<MapBlock[]>([]);
  const [source, setSource] = useState<'osm' | 'demo'>('osm');
  const [loadError, setLoadError] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const [tab, setTab] = useState<Tab>('walk');
  const [selected, setSelected] = useState<MapBlock | null>(null);
  const [needJoin, setNeedJoin] = useState(false);
  const [toast, setToast] = useState('');

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
        attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors' },
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
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
      setStart((cur) => cur ?? [(w + e) / 2, (s + n) / 2]);
      mapRef.current?.fitBounds([[w, s], [e, n]], { padding: 24, duration: 0 });
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
      el.className = 'start-pin';
      el.title = 'Walk starts here';
      startMarker.current = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(start).addTo(mapRef.current!);
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
      const bounds = new maplibregl.LngLatBounds();
      for (const l of legs) for (const c of l.coords) bounds.extend(c);
      map.fitBounds(bounds, { padding: 40 });
    }
  }, [mapReady, plan, tab]);

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
        if (pick) {
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
                        <SideGlyph side={s.side} />
                        <div className="where">
                          <span><span className="plate">{s.name}</span></span>
                          <span className="why">Head {s.heading} on the {s.sideLabel} side: {s.reason}</span>
                        </div>
                        <span className="dist">{miles(s.len)} mi</span>
                        {rating && (
                          <div className="rate-row">
                            <span className="stars" role="group" aria-label={`Rate ${s.name}`}>
                              {[1, 2, 3, 4, 5].map((n) => (
                                <button key={n} aria-label={`${n} of 5`} aria-pressed={(stars[i] ?? 0) >= n} onClick={() => setStars((x) => ({ ...x, [i]: n }))}>★</button>
                              ))}
                            </span>
                            <button className="btn small" aria-pressed={sidePick[i] === 'same'} onClick={() => setSidePick((x) => ({ ...x, [i]: 'same' }))}>Right side to walk</button>
                            <button className="btn small" aria-pressed={sidePick[i] === 'other'} onClick={() => setSidePick((x) => ({ ...x, [i]: 'other' }))}>Other side is nicer</button>
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
                    <button className="btn" onClick={() => { setPlan(null); setRating(false); }}>Design another</button>
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
