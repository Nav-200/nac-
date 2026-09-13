/**
 * window.__game — a small debug/test API used by the headless Playwright smoke test and
 * handy in the browser console. Everything here is optional for normal play.
 */
import type { Game } from './Game';

export interface GameDebugApi {
  ready: boolean;
  version: string;
  start(): void;
  stepFrames(n: number): void;
  measureFrameMs(n: number): number;
  getState(): unknown;
  getStats(): unknown;
  simulateInput(input: Record<string, unknown>, frames: number): void;
  teleport(x: number, y: number, z: number): void;
  setTimeOfDay(t: number): void;
  setCamera(x: number, y: number, z: number, tx: number, ty: number, tz: number): void;
  freeCamera(on: boolean): void;
  spawnVehicleNearPlayer(type?: string): number;
  enterNearestVehicle(): boolean;
  exitVehicle(): void;
  giveWeapon(id: string, ammo?: number): void;
  selectWeapon(id: string): void;
  setWanted(stars: number): void;
  startMission(index: number): boolean;
  setGodMode(on: boolean): void;
  game: Game;
}

declare global {
  interface Window {
    __game?: GameDebugApi;
  }
}

export function installDebugApi(game: Game): GameDebugApi {
  const api: GameDebugApi = {
    ready: false,
    version: '0.1.0',
    game,
    start: () => game.startGame(),
    stepFrames: (n) => game.stepFrames(n),
    measureFrameMs: (n) => game.measureFrameMs(n),
    getState: () => game.getDebugState(),
    getStats: () => game.getRenderStats(),
    simulateInput: (input, frames) => game.simulateInput(input, frames),
    teleport: (x, y, z) => game.teleportPlayer(x, y, z),
    setTimeOfDay: (t) => game.setTimeOfDay(t),
    setCamera: (x, y, z, tx, ty, tz) => game.setDebugCamera(x, y, z, tx, ty, tz),
    freeCamera: (on) => game.setFreeCamera(on),
    spawnVehicleNearPlayer: (type) => game.debugSpawnVehicle(type),
    enterNearestVehicle: () => game.debugEnterNearestVehicle(),
    exitVehicle: () => game.debugExitVehicle(),
    giveWeapon: (id, ammo) => game.debugGiveWeapon(id, ammo),
    selectWeapon: (id) => game.debugSelectWeapon(id),
    setWanted: (stars) => game.debugSetWanted(stars),
    startMission: (i) => game.debugStartMission(i),
    setGodMode: (on) => game.debugSetGodMode(on),
  };
  window.__game = api;
  return api;
}
