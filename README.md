# Open City — a GTA-style open-world game for the browser

A procedurally generated 2 km × 2 km city you can walk, drive and shoot your way through,
running entirely in the browser with three.js. No downloads, no assets: every building,
vehicle, pedestrian, texture and sound is generated at boot.

## Play

```bash
npm install
npm run dev        # http://localhost:3000
```

Production build: `npm run build` then `npm run preview`.

## Features

- **Big map** — 25 × 25 city blocks with distinct districts: a downtown of 100 m+ towers,
  a midtown ring, suburbs with houses and yards, an industrial zone with container yards,
  a working harbor with a moored cargo ship and cranes, a park with a pond, an airfield with
  runway, hangars and parked planes, and a beach with piers on the eastern shore.
- **On foot** — third-person controls with sprint, jump, camera collision and an
  over-the-shoulder aim mode.
- **Driving** — ten vehicle classes (compact, sedan, taxi, sports, SUV, pickup, van, truck,
  bus, police cruiser) with arcade handling, handbrake drifts, damage, fire and explosions.
  Enter parked cars or carjack moving traffic.
- **Shooting** — fists, bat, pistol, SMG, shotgun, assault rifle, sniper rifle and rocket
  launcher; headshots, drive-bys, ammo and reloading, breakable street props and hydrants.
- **A living city** — traffic that follows lanes and obeys traffic lights, pedestrians that
  wander the sidewalks and panic at gunfire, a full day/night cycle with street lights and
  lit windows, and a five-star wanted system with pursuing cruisers and officers on foot.
- **Things to do** — eight repeatable missions (courier runs, a van delivery, taxi fares,
  two checkpoint races, an assassination contract, vigilante chases and a rampage), cash
  pickups, health/armor pickups, Ammu-Nation gun shops, a Pay n Spray to lose the heat, four
  procedurally generated radio stations, a GPS with waypoints on the full map, and stats and
  progress saved in the browser.

## Controls

| Action | Keys |
| --- | --- |
| Move / drive | `W` `A` `S` `D` or arrow keys |
| Sprint | `Shift` |
| Jump / handbrake | `Space` |
| Look / aim | Mouse (click the game once to capture the pointer) |
| Fire / punch | Left mouse button |
| Aim | Right mouse button |
| Reload | `R` |
| Enter or exit vehicle, interact | `F` or `E` |
| Switch weapon | `Q`, `Tab`, mouse wheel, `1`–`7` |
| Horn | `H` |
| Headlights | `L` |
| Camera (near / far / first person) | `V` |
| Radio station | `N` |
| Map and waypoints | `M` |
| Pause | `Esc` or `P` |

## Tech

- Vite 6, React 19 (HUD only), TypeScript, Tailwind 4, three.js.
- Deterministic seeded world generation; merged per-chunk geometry and instanced props keep
  the whole city at a few hundred draw calls.
- Custom physics: spatial-hash broadphase, oriented-box vehicle collisions with impulse
  response, capsule pedestrians, ray casts for bullets and the camera.
- Web Audio synthesis for every sound, including engine notes, sirens and the radio.

## Headless smoke test

```bash
npm run build && npm run preview &
node scripts/e2e.mjs --url http://localhost:3000 --out ./e2e-out
```

The script boots the game in headless Chromium (software GL), walks, steals a car, drives,
shoots, raises the wanted level, starts a mission and takes screenshots along the way.
