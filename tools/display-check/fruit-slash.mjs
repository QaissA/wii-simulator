/**
 * Browser acceptance check for fruit slash (T3.8).
 *
 * A separate script rather than another phase of `index.mjs`, because the two
 * assert genuinely different things. `index.mjs` measures the *link* through the
 * debug cursor — frame age, send rate, axes moving. This measures a **game**:
 * that a pointer path crossing a collider actually slices it.
 *
 * The distinction that matters, and the reason this check exists at all: fruit
 * slash has **no gesture binding**. It cuts when the pointer crosses a fruit
 * above `CUT_SPEED`, so nothing about it is exercised by the swing path that
 * every other check drives. The fake controller is run with `--slash-every`,
 * which sweeps orientation fast enough to cut — its idle Lissajous deliberately
 * cannot, since a slow re-aim must not slice.
 *
 * Run the three dev servers first, then:
 *   node tools/display-check/fruit-slash.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Cdp, READ_DISPLAY_STATE, createReporter, devScheme, launchChrome } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOM = 'K3PQ';
const SCHEME = devScheme();
const DISPLAY_URL = process.env.DISPLAY_URL ?? `${SCHEME.http}://localhost:8082/?room=${ROOM}`;
const RELAY_URL = process.env.RELAY_URL ?? `${SCHEME.ws}://localhost:8081`;
const DEBUG_PORT = 9335;

const GAME = 'Fruit slash';

/**
 * How long to wait for a slash to connect with a fruit, ms.
 *
 * Bounded by the round, not by patience: three unsliced fruit end it, which at
 * the spawn rate is under ten seconds. Waiting longer than that just watches a
 * results screen — so if this times out, the interesting fact is almost always
 * "the round ended at zero", which the failure message reports.
 */
const SLICE_TIMEOUT_MS = 12_000;

const reporter = createReporter();
const { check, waitFor: waitOn } = reporter;

let stepNo = 0;
const chrome = launchChrome({ port: DEBUG_PORT, profileDir: resolve(HERE, '.chrome-profile-fruit') });

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

  /**
   * Walk the menu highlight onto `title` and start it.
   *
   * Read → step → re-read, because the fake controller is sweeping the whole
   * time and moves the highlight underneath us. Re-reading after each step
   * corrects the drift rather than accumulating it.
   */
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

  /* 1 — a controller that both aims and slashes */
  controller = spawn(
    process.execPath,
    [
      resolve(HERE, '../fake-controller/index.mjs'),
      '--room', ROOM,
      '--relay', RELAY_URL,
      // No swings: this game ignores them entirely, and firing them would hide a
      // regression where slicing had quietly started depending on the gesture.
      '--swing-every', '0',
      '--slash-every', '0.3',
    ],
    { stdio: 'ignore' },
  );

  const lobby = await waitOn(read, 'reaches lobby', (s) => s.centre.includes('Controller connected'));
  check('controller presence moves pairing to lobby', lobby.centre.includes('Controller connected'));

  /* 2 — the game is registered and reachable from the menu */
  const menu = await read();
  check(
    'fruit slash appears in the menu',
    menu.games.some((g) => g.title === GAME),
    menu.games.map((g) => g.title).join(', '),
  );

  await selectGame(GAME);

  /* 3 — it starts, with its own HUD rather than the cursor's */
  const play = await waitOn(read, 'reaches play', (s) => s.hudKeys.includes('score'), 8000);
  check('selecting it from the menu starts the game', play.hudKeys.includes('score'));
  check(
    'the game brings its own HUD',
    play.hudKeys.includes('lives') && play.hudKeys.includes('best'),
    play.hudKeys.join(','),
  );
  // The cursor scene's rows must be gone — a game showing another game's HUD
  // means PlayScene is not tearing down between rounds.
  check('the debug cursor HUD is not still up', !play.hudKeys.includes('aim.x'), play.hudKeys.join(','));
  check('it starts with a full set of lives', play.hud.lives === '***', play.hud.lives);
  await cdp.screenshot(resolve(HERE, `fruit-${++stepNo}-play.png`));

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
   * 5 — the assertion this whole script exists for.
   *
   * A score above zero means a blade segment crossed a fruit collider: the
   * pointing axes, the predictor, the swept-segment test and the scoring all
   * ran end to end. No gesture was involved at any point.
   */
  let best = 0;
  const deadline = Date.now() + SLICE_TIMEOUT_MS;
  let ended = false;
  while (Date.now() < deadline && best === 0 && !ended) {
    const s = await read();
    best = Number.parseInt(s.hud.score ?? '0', 10) || 0;
    // Stop as soon as the round is over rather than waiting out the clock: a
    // results screen reporting zero is the answer, and it arrives long before
    // any timeout would.
    ended = s.status.includes('round over') || s.centre.includes('play again');
    if (best === 0 && !ended) await sleep(120);
  }
  check(
    'a pointer stroke slices a fruit',
    best > 0,
    best > 0 ? String(best) : ended ? 'round ended having sliced nothing' : 'timed out',
  );
  await cdp.screenshot(resolve(HERE, `fruit-${++stepNo}-sliced.png`));

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
