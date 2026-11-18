# Beautiful Streets

Designs walking loops that spend as much time as possible on the most beautiful
blocks, and tells you which side of each street to walk on. Anyone can join and
vote, and every vote changes the next walk.

Version one covers Russian Hill and its neighbours in San Francisco (Marina east,
Pacific Heights, Nob Hill, North Beach, Telegraph Hill).

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

On first load the server downloads the street network from OpenStreetMap and
elevations from Open-Meteo, scores every block, and stores the result in
`data/beautiful-streets.db`. That takes a minute or two, once. To redo it later:

```bash
npm run import:streets
```

No network, or just want to click around? Use the made-up demo grid:

```bash
npm run seed:demo    # or start with BS_SEED=demo on an empty database
```

Tests and production build:

```bash
npm test
npm run build && npm start
```

## How a walk is designed

1. **Blocks.** Every walkable street is cut at each intersection. A block is the
   unit everything else works on.
2. **Map-data score.** Each block gets four scores from 0 to 1 using what
   OpenStreetMap knows: views and stairways (stairs, viewpoints, high ground),
   trees and gardens (mapped trees, park edges), architecture (historic and
   landmark features nearby), people and energy (cafes, restaurants, shops).
   Busy roads lose points. Trees and shopfronts are counted separately for the
   left and right side.
3. **Community score.** Three kinds of vote feed in: A-versus-B matchups (Elo),
   star ratings after a walk, and thumbs on the map. The final score starts at
   the map-data score and moves toward the community's as votes arrive; four
   votes weigh the same as the map data.
4. **This walk's conditions.** The forecast for the walk's start time, the sun's
   position and the hour adjust the weights: views count more near sunset and
   less in strong wind, lively streets count more at busy hours and after dark,
   stairways and paths are avoided at night and in rain.
5. **The loop.** From the start pin the planner tries many triangles
   (start, A, B, start) in different compass directions. Each leg takes the most
   beautiful path, later legs are steered away from blocks already used, and the
   winner is the loop with the best mix of beauty, length fit and no
   backtracking. Hills add time, so the distance is re-fitted to the minutes
   you asked for.
6. **Side of the street.** Each block is scored per side: trees and shopfronts
   on that side, which side walkers said was nicer, and sun or shade (sunny
   side when it is under 17°C, shady side over 23°C). Crossing has a small
   cost, so the route does not zigzag for marginal gains.

## Joining and voting

People join with a name; a cookie remembers them. One person's repeat vote on
the same block replaces their earlier one. This is deliberately light for a
group of friends. Before opening it to strangers it needs real sign-in and
rate limits.

## Deploying

Any Node host works. For a hosted database set `DATABASE_URL` and
`DATABASE_AUTH_TOKEN` to a Turso/libSQL database (see `.env.example`). The
basemap defaults to OpenFreeMap; change `NEXT_PUBLIC_MAP_STYLE` to use another.

## Known limits

- Architecture is the weakest map-data score: OpenStreetMap says little about
  how handsome a facade is. Votes are what will fix it.
- Sun and shade use street direction and sun angle only, not building heights.
- Side-of-street data starts thin and improves as people answer "which side is
  nicer".
- Matchups link out to Street View rather than showing photos in the app.

## Next

- Street photos inside matchups (Mapillary).
- Import your own walks from Apple Health to see which streets you have covered.
- One-way walks to a destination, and walks that pass a chosen cafe or viewpoint.
- Building-height shadows for exact sun and shade.
- More neighbourhoods.

Street data © OpenStreetMap contributors.
