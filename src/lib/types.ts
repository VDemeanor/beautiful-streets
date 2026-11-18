export type LngLat = [number, number];

/** The four things that make a street worth walking. */
export type Dim = 'views' | 'green' | 'arch' | 'energy';
export const DIMS: Dim[] = ['views', 'green', 'arch', 'energy'];
export type Weights = Record<Dim, number>;
export const DEFAULT_WEIGHTS: Weights = { views: 1, green: 1, arch: 1, energy: 1 };

/** Left and right are relative to the block's stored direction (a -> b). */
export type Side = 'L' | 'R';

export interface SidePrior {
  green: number;
  energy: number;
}

/** Scores in 0..1 derived from map data alone, before anyone votes. */
export interface Prior {
  views: number;
  green: number;
  arch: number;
  energy: number;
  traffic: number;
  L: SidePrior;
  R: SidePrior;
}

/** One stretch of street between two intersections. */
export interface Block {
  id: string;
  name: string;
  highway: string;
  coords: LngLat[];
  len: number;
  /** Compass bearing from a to b, degrees clockwise from north. */
  bearing: number;
  a: string;
  b: string;
  elev: number | null;
  /** Signed rise over run from a to b. */
  grade: number;
  prior: Prior;
}

export interface SideTally {
  sum: number;
  n: number;
}

/** Everything people have told us about a block. */
export interface Community {
  elo?: { rating: number; n: number };
  rate?: SideTally;
  thumbs?: { up: number; down: number };
  L?: SideTally;
  R?: SideTally;
}

export interface Weather {
  tempC: number;
  windKph: number;
  precipMm: number;
  precipProb: number;
  cloudPct: number;
}

export interface WalkContext {
  when: string;
  weather: Weather | null;
  sunAzimuth: number;
  sunAltitude: number;
  goldenHour: boolean;
  night: boolean;
  raining: boolean;
  windy: boolean;
  sunPref: 'sun' | 'shade' | 'none';
  busyHour: boolean;
  notes: string[];
}

export interface RouteLeg {
  blockId: string;
  name: string;
  coords: LngLat[];
  len: number;
  /** Side relative to the direction of travel. */
  side: Side;
  /** Which compass side of the street that is, e.g. "north". */
  sideLabel: string;
  reason: string;
  score: number;
  /** True when walked in the block's stored direction (a -> b). */
  forward: boolean;
  /** Index into Route.steps. */
  step: number;
}

export interface RouteStep {
  name: string;
  side: Side;
  sideLabel: string;
  reason: string;
  len: number;
  heading: string;
}

export interface Route {
  legs: RouteLeg[];
  steps: RouteStep[];
  lengthM: number;
  minutes: number;
  climbM: number;
  meanScore: number;
  repeatFrac: number;
}
