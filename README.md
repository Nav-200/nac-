# Horizon Rush

An open-road racing game for mobile browsers, built with React and Three.js.

This repository hosts two apps that share one Vite project:

| Route | App |
| --- | --- |
| `/` | **Horizon Rush** — the racing game |
| `/#simulator` | the original **navQtracker** ESP32 hardware simulator (`src/App.tsx`, unchanged) |

## Running it

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production bundle in dist/
npm run lint     # tsc --noEmit
```

Open it on a phone in landscape for the intended experience.

## Playing

**Touch** — steering pads bottom-left, throttle and brake bottom-right, handbrake
above them. The buttons on the top right cycle the camera and pause.

**Keyboard** — `WASD` / arrows to drive, `Space` for the handbrake, `C` for the
camera, `R` to respawn on the road, `Esc` to pause.

Free-roam the valley or run the twelve-checkpoint circuit against three rivals.
Your best circuit time is kept in `localStorage`. Holding a slide banks a drift
chain; the longer and faster the slide, the better the grade.

## How it is built

Everything you see is generated in code — there are no models, textures or audio
files. The terrain is a noise heightfield, the road is a spline flattened into
it, the cars are merged boxes and cylinders, and the engine note is a stack of
oscillators tracking RPM through a filter.

```
src/game/
  Game.ts             orchestrator: owns the world and drives every system
  engine/Engine.ts    renderer, fixed-timestep loop, adaptive resolution
  engine/input.ts     touch, keyboard and tilt merged into one input state
  car/vehicle.ts      arcade car physics
  car/carModel.ts     procedural low-poly car
  world/              heightfield terrain, road spline, instanced scenery, sky
  race/               checkpoints, timing and AI opponents
  fx/                 chase camera, tyre smoke, skid marks
  audio/              synthesised engine, tyre squeal and wind
  ui/                 HUD, touch controls and menus
```

### Keeping it smooth

Smoothness on a phone is a design constraint here, not a later optimisation:

- Physics runs at a fixed 120 Hz with render interpolation, so the car handles
  identically at 30, 60 or 120 fps.
- Device pixel ratio is capped, and an adaptive controller lowers render
  resolution when frame times slip and restores it when they recover. If that is
  not enough, the game drops to a lower detail tier on its own.
- React never renders during play. The HUD reads a mutable state object from its
  own animation frame and writes through refs; menus are the only React state.
- Nothing in the frame loop allocates — scratch vectors, pooled particles, a ring
  buffer for skid marks.
- Terrain is chunked and scenery is instanced per map region so the frustum can
  throw most of the world away. A typical frame is around 60–100 draw calls and
  under 100k triangles.
