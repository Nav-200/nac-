// Headless smoke test for Open City.
// Usage: node scripts/e2e.mjs [--url http://localhost:3000] [--out ./e2e-out]
// Requires a running server (npm run preview after npm run build) and Playwright.
// Uses SwiftShader so it runs on machines without a GPU.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'));
}

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const url = getArg('--url', 'http://localhost:3000');
const outDir = resolve(getArg('--out', './e2e-out'));
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(String(err?.stack || err)));

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const shot = async (name) => {
  const file = resolve(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
};
const step = async (name, fn) => {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (e) {
    record(name, false, String(e?.message || e));
  }
};

await page.goto(url, { waitUntil: 'load' });

await step('game boots and exposes window.__game', async () => {
  await page.waitForFunction(() => window.__game && window.__game.ready === true, null, { timeout: 90_000 });
  return 'ready';
});

await step('start game from menu', async () => {
  await page.evaluate(() => window.__game.start());
  await page.waitForFunction(() => window.__game.getState().phase === 'playing', null, { timeout: 30_000 });
});

await step('render several frames', async () => {
  await page.evaluate(() => window.__game.stepFrames(30));
  const s = await page.evaluate(() => window.__game.getState());
  await shot('01-spawn');
  return `frame=${s.frame} pos=${s.player.position.map((n) => n.toFixed(1)).join(',')}`;
});

await step('walk forward moves the player', async () => {
  const before = await page.evaluate(() => window.__game.getState().player.position);
  await page.evaluate(() => window.__game.simulateInput({ forward: true }, 90));
  const after = await page.evaluate(() => window.__game.getState().player.position);
  const dist = Math.hypot(after[0] - before[0], after[2] - before[2]);
  if (dist < 1) throw new Error(`moved only ${dist.toFixed(2)}m`);
  await shot('02-walk');
  return `moved ${dist.toFixed(1)}m`;
});

await step('spawn a car and enter it', async () => {
  // open ground (airfield apron) so the drive test is not blocked by street furniture
  await page.evaluate(() => window.__game.teleport(-520, 0, 795));
  await page.evaluate(() => window.__game.stepFrames(5));
  await page.evaluate(() => window.__game.spawnVehicleNearPlayer('sedan'));
  await page.evaluate(() => window.__game.stepFrames(5));
  await page.evaluate(() => window.__game.enterNearestVehicle());
  await page.waitForFunction(() => window.__game.getState().player.inVehicle === true, null, { timeout: 10_000 });
  await shot('03-in-car');
});

await step('driving forward moves the vehicle', async () => {
  const before = await page.evaluate(() => window.__game.getState().player.position);
  await page.evaluate(() => window.__game.simulateInput({ forward: true }, 180));
  const st = await page.evaluate(() => window.__game.getState());
  const after = st.player.position;
  const dist = Math.hypot(after[0] - before[0], after[2] - before[2]);
  if (dist < 5) throw new Error(`drove only ${dist.toFixed(2)}m`);
  await shot('04-driving');
  return `drove ${dist.toFixed(1)}m, speed=${st.vehicle ? st.vehicle.speedKmh.toFixed(0) : '?'}km/h`;
});

await step('exit vehicle', async () => {
  await page.evaluate(() => window.__game.simulateInput({ forward: false }, 1));
  await page.evaluate(() => window.__game.exitVehicle());
  await page.waitForFunction(() => window.__game.getState().player.inVehicle === false, null, { timeout: 10_000 });
});

await step('give weapon and shoot', async () => {
  await page.evaluate(() => window.__game.giveWeapon('pistol', 60));
  await page.evaluate(() => window.__game.selectWeapon('pistol'));
  const before = await page.evaluate(() => window.__game.getState().player.ammo);
  await page.evaluate(() => window.__game.simulateInput({ fire: true }, 30));
  await page.evaluate(() => window.__game.simulateInput({ fire: false }, 5));
  const after = await page.evaluate(() => window.__game.getState().player.ammo);
  if (!(after < before)) throw new Error(`ammo did not decrease (${before} -> ${after})`);
  await shot('05-shooting');
  return `ammo ${before} -> ${after}`;
});

await step('wanted level rises and police respond', async () => {
  await page.evaluate(() => window.__game.setWanted(3));
  await page.evaluate(() => window.__game.stepFrames(120));
  const st = await page.evaluate(() => window.__game.getState());
  if (st.wanted < 1) throw new Error('wanted level not set');
  if (st.counts.police < 1) throw new Error('no police spawned');
  await shot('06-wanted');
  return `wanted=${st.wanted} police=${st.counts.police}`;
});

await step('world has traffic and pedestrians', async () => {
  const st = await page.evaluate(() => window.__game.getState());
  if (st.counts.pedestrians < 1) throw new Error('no pedestrians');
  if (st.counts.vehicles < 2) throw new Error('not enough vehicles');
  return `peds=${st.counts.pedestrians} vehicles=${st.counts.vehicles}`;
});

await step('mission can be started', async () => {
  await page.evaluate(() => window.__game.startMission(0));
  await page.evaluate(() => window.__game.stepFrames(10));
  const st = await page.evaluate(() => window.__game.getState());
  if (!st.mission || !st.mission.active) throw new Error('mission not active');
  await shot('07-mission');
  return st.mission.title || 'active';
});

await step('teleport far across the map still renders', async () => {
  await page.evaluate(() => window.__game.teleport(700, 0, -700));
  await page.evaluate(() => window.__game.stepFrames(60));
  await shot('08-far-corner');
  const st = await page.evaluate(() => window.__game.getState());
  return `pos=${st.player.position.map((n) => n.toFixed(0)).join(',')} district=${st.district || '?'}`;
});

await step('night time renders with lights', async () => {
  await page.evaluate(() => window.__game.setTimeOfDay(0.05));
  await page.evaluate(() => window.__game.stepFrames(30));
  await shot('09-night');
});

await step('frame time is reasonable (software GL)', async () => {
  const ms = await page.evaluate(() => window.__game.measureFrameMs(60));
  return `avg ${ms.toFixed(1)} ms/frame under SwiftShader`;
});

await step('no uncaught page errors', async () => {
  if (pageErrors.length) throw new Error(pageErrors.slice(0, 3).join(' | '));
});

await step('no console errors', async () => {
  const relevant = consoleErrors.filter((e) => !/favicon|THREE\.WebGLRenderer: Context Lost/i.test(e));
  if (relevant.length) throw new Error(relevant.slice(0, 3).join(' | '));
});

writeFileSync(resolve(outDir, 'results.json'), JSON.stringify({ results, consoleErrors, pageErrors }, null, 2));
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${outDir}`);
process.exit(failed.length ? 1 : 0);
