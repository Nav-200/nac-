# Horizon Rush

An open-road racing game for mobile browsers, built with React and Three.js.

**Play it:**
- GitHub Pages (public): https://nav-200.github.io/nac-/ — deploys via
  `.github/workflows/deploy.yml`; enable it once under *Settings → Pages →
  Source: GitHub Actions*.
- claude.ai artifact (single-file build): see the link in the project chat, or
  rebuild it any time with `npm run build:artifact`.

This repository hosts two apps that share one Vite project:

| Route | App |
| --- | --- |
| `/` | **Horizon Rush** — the racing game |
| `/#simulator` | the original **navQtracker** ESP32 hardware simulator (`src/App.tsx`, unchanged) |

## Running it

```bash
npm install
npm run dev             # http://localhost:3000
npm run build           # production bundle in dist/
npm run build:artifact  # single-file page in dist-artifact/
npm run lint            # tsc --noEmit
```

Open it on a phone in landscape for the intended experience.

## Playing

**Touch** — analog steering strip bottom-left (drag your thumb), brake and
handbrake bottom-right. Auto-throttle is on by default, so the big right button
is **NITRO**; turn "Auto gas" off in the menu to get a throttle pedal instead.
Top-right buttons cycle the camera and pause.

**Keyboard** — `WASD` / arrows to drive, `Shift` for nitro, `Space` for the
handbrake, `C` camera, `R` respawn, `Esc` pause.

Three events on the valley loop — **Grand Circuit**, **Valley Sprint** (half
loop) and **Reverse Circuit** — each against three rivals, with per-event best
times kept in `localStorage`. Free roam adds ambient traffic: pass within a
couple of metres at speed for a near-miss bonus. Drifting, airtime and
near-misses all charge the nitro meter. Trees, rocks, chevron barriers and the
arch are solid; bushes just slow you down; the lake will swallow you whole.

Six cars in three silhouettes (coupe / muscle / buggy), five times of day with
procedural clouds and night stars, synthesized engine audio and an optional
synthwave loop — no model, texture or audio files anywhere.

## How it is built

Everything you see and hear is generated in code. The terrain is a noise
heightfield with a lake basin carved in, the road is a spline flattened into
it, the cars are merged boxes and cylinders, and the soundtrack is oscillators
scheduled against the WebAudio clock.

```
src/game/
  Game.ts             orchestrator: owns the world and drives every system
  settings.ts         guarded localStorage facade (works with storage dead)
  engine/Engine.ts    renderer, fixed-timestep loop, adaptive resolution
  engine/input.ts     touch, keyboard and tilt merged into one input state
  car/vehicle.ts      arcade car physics (collisions, nitro, drift)
  car/carModel.ts     procedural low-poly cars, three silhouettes
  world/              terrain, road, scenery + collider grid, sky, lake,
                      grass, trackside furniture
  race/               events, gates, timing, AI rivals, ambient traffic
  fx/                 chase camera, tyre smoke, nitro flames, skid marks
  audio/              synthesized engine, effects and music
  ui/                 HUD, touch controls and menus
scripts/
  build-artifact.mjs  emits the self-contained single-file page
```

### Keeping it smooth

Smoothness on a phone is a design constraint here, not a later optimisation:

- Physics runs at a fixed 120 Hz with render interpolation, so the car handles
  identically at 30, 60 or 120 fps.
- Device pixel ratio is capped, and an adaptive controller lowers render
  resolution when frame times slip and restores it when they recover. If that
  is not enough, the game drops to a lower detail tier on its own.
- React never renders during play. The HUD reads a mutable state object from
  its own animation frame and writes through refs; menus are the only React
  state.
- Nothing in the frame loop allocates — scratch vectors, pooled particles, a
  ring buffer for skid marks, and CSR typed-array spatial grids for both the
  road and the collision world.
- Terrain is chunked, scenery/grass/barriers are instanced per map region, and
  all five traffic cars share one InstancedMesh (one draw call). The sky dome
  renders after the opaques so terrain z-culls its cloud shader. A typical
  frame is around 60–100 draw calls and under 100k triangles.
- three.js ships as its own cached vendor chunk, and the game and simulator
  routes lazy-load independently.
