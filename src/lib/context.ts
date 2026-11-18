import * as SunCalc from 'suncalc';
import type { LngLat, WalkContext, Weather } from './types';

/** Forecast for the hour of the walk from Open-Meteo. Returns null if unavailable. */
export async function fetchWeather(at: LngLat, when: Date): Promise<Weather | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${at[1].toFixed(4)}&longitude=${at[0].toFixed(4)}` +
      `&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m,cloud_cover` +
      `&timeformat=unixtime&forecast_days=7&past_days=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j = (await res.json()) as {
      hourly: {
        time: number[];
        temperature_2m: number[];
        precipitation_probability: (number | null)[];
        precipitation: number[];
        wind_speed_10m: number[];
        cloud_cover: number[];
      };
    };
    const t = when.getTime() / 1000;
    let best = 0;
    for (let i = 1; i < j.hourly.time.length; i++)
      if (Math.abs(j.hourly.time[i] - t) < Math.abs(j.hourly.time[best] - t)) best = i;
    if (Math.abs(j.hourly.time[best] - t) > 2 * 3600) return null;
    return {
      tempC: j.hourly.temperature_2m[best],
      windKph: j.hourly.wind_speed_10m[best],
      precipMm: j.hourly.precipitation[best],
      precipProb: j.hourly.precipitation_probability[best] ?? 0,
      cloudPct: j.hourly.cloud_cover[best],
    };
  } catch {
    return null;
  }
}

/** Hour of day and weekday in San Francisco, whatever the server's own time zone. */
function localClock(when: Date, timeZone: string): { hour: number; weekend: boolean } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(when);
  const hour = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const day = parts.find((p) => p.type === 'weekday')!.value;
  return { hour, weekend: day === 'Sat' || day === 'Sun' };
}

export function buildContext(at: LngLat, when: Date, weather: Weather | null, timeZone = 'America/Los_Angeles'): WalkContext {
  const pos = SunCalc.getPosition(when, at[1], at[0]);
  // SunCalc 2 reports degrees, with azimuth clockwise from north.
  const sunAzimuth = pos.azimuth;
  const sunAltitude = pos.altitude;
  const times = SunCalc.getTimes(when, at[1], at[0]);
  const toSunset = times.sunset ? (times.sunset.getTime() - when.getTime()) / 60000 : Infinity;
  const goldenHour = toSunset > -10 && toSunset < 75;
  const night = sunAltitude < -4;
  const { hour, weekend } = localClock(when, timeZone);
  const busyHour = weekend ? hour >= 10 && hour <= 21 : (hour >= 7 && hour <= 9) || (hour >= 11 && hour <= 13) || (hour >= 17 && hour <= 21);

  const raining = !!weather && (weather.precipMm >= 0.3 || weather.precipProb >= 60);
  const windy = !!weather && weather.windKph >= 30;
  let sunPref: WalkContext['sunPref'] = 'none';
  if (weather && !night) {
    if (weather.tempC < 17) sunPref = 'sun';
    else if (weather.tempC > 23) sunPref = 'shade';
  }

  const notes: string[] = [];
  if (!weather) notes.push('No forecast for that time, so weather was left out.');
  else
    notes.push(
      `${Math.round((weather.tempC * 9) / 5 + 32)}°F, wind ${Math.round(weather.windKph / 1.609)} mph, ${Math.round(weather.precipProb)}% chance of rain.`,
    );
  if (sunPref === 'sun') notes.push('Cool out: the route keeps you on the sunny side where it can.');
  if (sunPref === 'shade') notes.push('Warm out: the route keeps you in the shade where it can.');
  if (goldenHour) notes.push('Near sunset: streets with views count for more.');
  if (night) notes.push('After dark: stairways and paths are avoided, lively streets preferred.');
  if (raining) notes.push('Rain likely: stairways are avoided.');
  if (windy) notes.push('Windy: exposed hilltops count for less.');

  return {
    when: when.toISOString(),
    weather,
    sunAzimuth,
    sunAltitude,
    goldenHour,
    night,
    raining,
    windy,
    sunPref,
    busyHour,
    notes,
  };
}
