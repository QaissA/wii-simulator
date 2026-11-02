/**
 * Star fighter, driven headlessly — the fourth game's own acceptance check.
 *
 * A separate script rather than another phase of `index.mjs`, for the reason
 * `fruit-slash.mjs` already established: `index.mjs` measures the **link**
 * through the debug cursor, and these measure a **game**. Mixing them means a
 * gameplay regression reports itself as a broken cursor.
 *
 * What this asserts that no other script can: **the guns fire, the swept bullet
 * test connects, and score accrues without any gesture being involved.** Star
 * fighter auto-fires, so unlike fruit slash it does not need the controller to
 * do anything clever — the aliens come to it. That makes the score assertion a
 * clean test of the collision path rather than of the harness's aim.
 *
 * It runs with `--swing-every 0` on purpose. This game has no gesture binding at
 * all, and a swing arriving mid-run would hide a regression where firing had
 * quietly started depending on one.
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Cdp, READ_DISPLAY_STATE, createReporter, devScheme, launchChrome } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOM = 'SH7T';
const SCHEME = devScheme();
const DISPLAY_URL = process.env.DISPLAY_URL ?? `${SCHEME.http}://localhost:8082/?room=${ROOM}`;
const RELAY_URL = process.env.RELAY_URL ?? `${SCHEME.ws}://localhost:8081`;
/** Its own port, so this can run alongside the other checks without a clash. */
const DEBUG_PORT = 9336;

const GAME = 'Star fighter';

/**
 * How long to wait for the first kill, ms.
 *
 * Generous, because the opening wave has to descend into range and the ship
 * fires roughly four times a second at level 1. Still bounded by the round: if
 * the swarm gets through, the game ends and the loop stops early with that as
 * the finding rather than waiting out the clock.
 */
const SCORE_TIMEOUT_MS = 15_000;

const reporter = createReporter();
const { check, waitFor: waitOn } = reporter;

let stepNo = 0;
const chrome = launchChrome({
  port: DEBUG_PORT,
  profileDir: resolve(HERE, '.chrome-profile-shooter'),
});

let controller = null;
const stopController = () => {
  if (controller && !controller.killed) controller.kill();
  controller = null;
};

process.on('exit', () => {
  stopController();
  chrome.kill();
});

let cdp;
try {
  cdp = await Cdp.attach(DEBUG_PORT, 'display');
  await cdp.setViewport(1440, 900);
  await cdp.navigate(DISPLAY_URL);

  const read = () => cdp.evaluate(READ_DISPLAY_STATE);

  /** Walk the menu highlight onto `title` and start it. See `fruit-slash.mjs`. */
  const selectGame = async (title) => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const { games } = await read();
      const at = games.findIndex((g) => g.selected);
      const want = games.findIndex((g) => g.title === title);
      if (want < 0) throw new Error(`no menu entry titled ${title}`);
      if (at === want) {
        await cdp.key('Enter');
        return;
      }
      await cdp.key(at > want || at < 0 ? 'ArrowLeft' : 'ArrowRight');
    }
    throw new Error(`could not settle the menu on ${title}`);
  };

  await waitOn(read, 'display reaches pairing', (s) => s.hasQr, 8000);

  /* 1 — a controller that only aims */
  controller = spawn(
    process.execPath,
    [
      resolve(HERE, '../fake-controller/index.mjs'),
      '--room', ROOM,
      '--relay', RELAY_URL,
      // No gestures at all: this game binds none, and firing them would hide a
      // regression where shooting had started depending on one.
      '--swing-every', '0',
    ],
    { stdio: 'ignore' },
  );

  const lobby = await waitOn(read, 'reaches lobby', (s) => s.centre.includes('Controller connected'));
  check('controller presence moves pairing to lobby', lobby.centre.includes('Controller connected'));

  /* 2 — registered and reachable from the menu */
  const menu = await read();
  check(
    'star fighter appears in the menu',
    menu.games.some((g) => g.title === GAME),
    menu.games.map((g) => g.title).join(', '),
  );

  await selectGame(GAME);

  /* 3 — it starts, with its own HUD */
  const play = await waitOn(read, 'reaches play', (s) => s.hudKeys.includes('score'), 8000);
  check('selecting it from the menu starts the game', play.hudKeys.includes('score'));
  check(
    'the game brings its own HUD',
    ['best', 'wave', 'lives', 'laser', 'bombs'].every((k) => play.hudKeys.includes(k)),
    play.hudKeys.join(','),
  );
  check(
    'the debug cursor HUD is not still up',
    !play.hudKeys.includes('aim.x'),
    play.hudKeys.join(','),
  );
  check('it starts with a full set of lives', play.hud.lives === '***', play.hud.lives);
  check('it starts on wave one at laser level one', play.hud.wave === '1' && play.hud.laser === 'L1',
    `${play.hud.wave}/${play.hud.laser}`);
  await cdp.screenshot(resolve(HERE, `shooter-${++stepNo}-play.png`));

  /* 4 — the display is actually rendering, not just holding a HUD */
  const frames = await cdp.evaluate(`(async () => {
    let n = 0;
    const started = performance.now();
    await new Promise((done) => {
      const tick = () => {
        n++;
        if (performance.now() - started > 1200) return done();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return String(n);
  })()`);
  check('display keeps rendering', Number(frames) > 30, `${frames} frames in 1.2 s`);

  /*
   * 5 — the assertion this script exists for.
   *
   * Score above zero means a bullet segment crossed an alien collider: the
   * fire loop, the swept segment/circle test from `packages/engine` and the
   * scoring all ran end to end, with no gesture anywhere on the path.
   */
  let best = 0;
  const deadline = Date.now() + SCORE_TIMEOUT_MS;
  let ended = false;
  while (Date.now() < deadline && best === 0 && !ended) {
    const s = await read();
    best = Number.parseInt(s.hud.score ?? '0', 10) || 0;
    ended = s.status.includes('round over') || s.centre.includes('play again');
    if (best === 0 && !ended) await sleep(120);
  }
  check(
    'the guns hit something',
    best > 0,
    best > 0 ? String(best) : ended ? 'round ended having hit nothing' : 'timed out',
  );
  await cdp.screenshot(resolve(HERE, `shooter-${++stepNo}-scored.png`));

  /* 6 — the controller goes away */
  stopController();
  const dropped = await waitOn(read, 'falls back to pairing', (s) => s.hasQr, 8000);
  check('losing the controller returns to pairing', dropped.hasQr === true);
  check('HUD is torn down on exit', dropped.hudKeys?.length === 0, dropped.hudKeys?.join(','));

  check('no console errors or exceptions', cdp.logs.length === 0, cdp.logs.join(' | '));
} catch (err) {
  check('harness ran to completion', false, err.message);
} finally {
  cdp?.close();
  await Cdp.shutdown(DEBUG_PORT).catch(() => {});
  stopController();
  chrome.kill();
}

process.exit(reporter.finish() ? 1 : 0);
