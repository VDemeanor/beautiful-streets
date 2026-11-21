'use client';

import { useEffect, useRef, useState } from 'react';
import type { LngLat, RouteLeg } from '@/lib/types';
import type { CinemaApi, SunAt } from './cinema/engine';

/**
 * The cinematic view: the real city in a game-style renderer, with its own
 * sun, shadows, sky and night. Needs a Google Maps Platform key with the Map
 * Tiles API enabled. The film plays on it through the same Stage as the
 * other views. The engine is loaded only when this view is opened.
 */

interface Props {
  apiKey: string;
  start: LngLat;
  legs: RouteLeg[] | null;
  /** Ground height in metres above sea level near a point. */
  altitude: (at: LngLat) => number;
  sun: SunAt;
  onReady: (api: CinemaApi | null) => void;
  onError: (message: string, keyRefused: boolean) => void;
}

export default function Cinematic({ apiKey, start, legs, altitude, sun, onReady, onError }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<CinemaApi | null>(null);
  const [ready, setReady] = useState(false);
  const [credits, setCredits] = useState('');
  const altitudeRef = useRef(altitude);
  altitudeRef.current = altitude;
  const sunRef = useRef(sun);
  sunRef.current = sun;

  useEffect(() => {
    let cancelled = false;
    import('./cinema/engine')
      .then(({ createEngine }) => {
        if (cancelled || !host.current) return;
        const api = createEngine(host.current, { apiKey, start, altitude: (at) => altitudeRef.current(at), sun: sunRef.current, onError });
        engine.current = api;
        // Handy when tuning the look from the browser console.
        (window as unknown as { __bsCinema?: CinemaApi }).__bsCinema = api;
        setReady(true);
        onReady(api);
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err), false);
      });
    const timer = window.setInterval(() => setCredits(engine.current?.credits() ?? ''), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      engine.current?.dispose();
      engine.current = null;
      onReady(null);
    };
    // The scene is built once per key; the walk, the light and the start are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  useEffect(() => {
    if (ready) engine.current?.light(sun);
  }, [ready, sun]);

  useEffect(() => {
    if (ready) engine.current?.route(legs?.length ? legs.flatMap((l) => l.coords) : null);
  }, [ready, legs]);

  return (
    <div className="photoreal cinematic">
      <div ref={host} className="cinematic-canvas" />
      {/* Google requires its name and the imagery credits to stay visible. */}
      <div className="cinematic-credits">
        <strong>Google</strong>
        <span>{credits}</span>
      </div>
    </div>
  );
}
