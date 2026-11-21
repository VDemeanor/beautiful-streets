'use client';

import { useEffect, useRef } from 'react';
import type { Weather } from '@/lib/types';

/**
 * The forecast, made visible: fog and low cloud drifting through at the speed
 * of the wind, rain falling at its slant, and a small readout of the numbers.
 * It sits over whichever city is showing.
 */

export function conditionWord(w: Weather, night: boolean): string {
  if (w.precipMm >= 0.3 || w.precipProb >= 60) return 'Rain';
  if (w.cloudPct >= 88) return w.windKph < 14 ? 'Fog' : 'Overcast';
  if (w.cloudPct >= 45) return 'Partly cloudy';
  return night ? 'Clear night' : 'Clear';
}

export default function WeatherLayer({ weather, night, quiet }: { weather: Weather | null; night: boolean; quiet: boolean }) {
  const rainEl = useRef<HTMLCanvasElement>(null);
  const raining = !!weather && (weather.precipMm >= 0.3 || weather.precipProb >= 60);
  const wind = weather?.windKph ?? 0;

  useEffect(() => {
    const canvas = rainEl.current;
    if (!canvas || !raining || quiet) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    let raf = 0;
    const fit = () => {
      const box = canvas.getBoundingClientRect();
      canvas.width = box.width;
      canvas.height = box.height;
    };
    fit();
    window.addEventListener('resize', fit);
    // Heavier rain, more drops; more wind, more slant.
    const heavy = Math.min(1, (weather?.precipMm ?? 0.5) / 3);
    const drops = Array.from({ length: Math.round(90 + 220 * heavy) }, () => ({ x: Math.random(), y: Math.random(), v: 0.7 + Math.random() * 0.6, l: 9 + Math.random() * 14 }));
    const slant = Math.min(0.6, wind / 60);
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.strokeStyle = 'rgba(215, 228, 240, 0.5)';
      g.lineWidth = 1.1;
      g.beginPath();
      for (const d of drops) {
        d.y += d.v * dt * 1.5;
        d.x += slant * d.v * dt * 1.5;
        if (d.y > 1.05) {
          d.y = -0.05;
          d.x = Math.random() * 1.3 - 0.3;
        }
        const x = d.x * canvas.width;
        const y = d.y * canvas.height;
        g.moveTo(x, y);
        g.lineTo(x + slant * d.l, y + d.l);
      }
      g.stroke();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', fit);
    };
  }, [raining, quiet, wind, weather?.precipMm]);

  if (!weather) return null;
  // Low cloud and fog thicken from about two-thirds cover; the wind sets how fast they move.
  const fog = Math.max(0, Math.min(1, (weather.cloudPct - 62) / 38));
  const drift = `${Math.max(18, 110 - wind * 2.2)}s`;
  const f = Math.round((weather.tempC * 9) / 5 + 32);
  return (
    <>
      {fog > 0.02 && (
        <div className="wx-fog" style={{ opacity: 0.25 + fog * 0.6, ['--drift' as string]: drift }} aria-hidden="true">
          <i />
          <i />
        </div>
      )}
      {raining && <div className="wx-wet" aria-hidden="true" />}
      {raining && !quiet && <canvas ref={rainEl} className="wx-rain" aria-hidden="true" />}
      <div className="wx-chip" role="status">
        <strong>{f}°F</strong>
        <span>{conditionWord(weather, night)}</span>
        <span>wind {Math.round(wind / 1.609)} mph</span>
      </div>
    </>
  );
}
