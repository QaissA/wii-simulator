/**
 * End-to-end acceptance check for the display (T3.1 + T3.4).
 *
 * `docs/implementation-plan.md` §Outstanding for 3b: "The deliverable is a
 * rendered picture; typechecking proves nothing about it. Re-enable browser
 * verification before starting, or these ship as unverified code the way Layer
 * 1's sensor path did."
 *
 * This is that verification, scripted so it stays true rather than being true
 * once. It drives a real headless Chrome over the DevTools protocol — no test
 * framework, no browser-automation dependency — and walks the whole state
 * machine against a live relay:
 *
 *   1. pairing renders a QR and the room code
 *   2. a controller appears        -> lobby
 *   3. it presses a button         -> play, with frame age inside the budget
 *   4. it goes away                -> back to pairing, HUD torn down
 *
 * Step 4 is the one worth having automated. It is a *timeout*, so it cannot be
 * confirmed by looking at a screenshot at the wrong moment — which is exactly
 * how it was nearly missed.
 *
 * Preconditions: the relay and the display dev server are already running.
 *
 *   pnpm --filter @wii/server dev       # :8081
 *   pnpm --filter @wii/display dev      # :8082
 *   node tools/display-check/index.mjs
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Cdp, READ_DISPLAY_STATE, createReporter, devScheme, launchChrome } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOM = 'W9XD';
const SCHEME = devScheme();
const DISPLAY_URL = process.env.DISPLAY_URL ?? `${SCHEME.http}://localhost:8082/?room=${ROOM}`;
const RELAY_URL = process.env.RELAY_URL ?? `${SCHEME.ws}://localhost:8081`;
const DEBUG_PORT = 9333;

/** Frame age ceiling, ms. Mirrors LATENCY_BUDGET_MS.max in the protocol package. */
const AGE_BUDGET_MS = 80;
/** The menu entry this check measures. Title, because that is what the DOM shows. */
const DEBUG_GAME = 'Debug cursor';

const reporter = createReporter();
const { check, waitFor: waitOn } = reporter;

let stepNo = 0;

/* ------------------------------------------------------------------ steps */

const chrome = launchChrome({ port: DEBUG_PORT, profileDir: resolve(HERE, '.chrome-profile') });

let controller = null;
/**
 * Walk the menu highlight onto `title` and start it.
 *
 * Written as read → step → re-read rather than "press left N times" because the
 * fake controller is tilting the whole time and moves the highlight underneath
 * us. Re-reading after every step means the drift is corrected rather than
 * accumulated, and the confirm only fires once the right row is actually lit.
 */
const selectGame = async (read, title) => {
  for (let attempt = 0; attempt < 12; attempt++) {
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
  await cdp.setViewport();

  const read = () => cdp.evaluate(READ_DISPLAY_STATE);

  /* 1 — pairing */
  await cdp.navigate(DISPLAY_URL);
  const pairing = await waitOn(read, 'pairing renders', (s) => s.hasQr && s.roomCode);
  check('WebGL context acquired', pairing.canvasReady === true);
  check('pairing shows the QR', pairing.hasQr === true);
  check('pairing shows the room code', pairing.roomCode === ROOM, `got ${pairing.roomCode}`);
  check('HUD is absent before play', pairing.hudKeys?.length === 0);

  // Audio. Everything below asserts on counters rather than on sound, because a
  // screenshot cannot show that a speaker moved — the display's `window.__audio`
  // hook exists for exactly this reason.
  check('the audio debug hook is present', pairing.audio !== null);
  check(
    'audio is unlocked in the harness',
    pairing.audio?.blocked === false,
    `blocked=${pairing.audio?.blocked}`,
  );
  // The corollary: with audio working the pairing screen must *not* be nagging
  // for a click. A hint that is always on is worse than no hint, because it
  // trains the player to ignore the one case where it matters.
  check('no audio hint when sound already works', pairing.audioHint === '', pairing.audioHint);
  await cdp.screenshot(resolve(HERE, `shot-${++stepNo}-pairing.png`));

  /* 2 — a controller appears */
  controller = spawn(
    process.execPath,
    [
      resolve(HERE, '../fake-controller/index.mjs'),
      '--room', ROOM,
      '--relay', RELAY_URL,
      '--swing-every', '2',
    ],
    { stdio: 'ignore' },
  );

  const lobby = await waitOn(read, 'reaches lobby', (s) =>
    s.centre.includes('Controller connected'),
  );
  check('controller presence moves pairing to lobby', lobby.centre.includes('Controller connected'));
  await cdp.screenshot(resolve(HERE, `shot-${++stepNo}-lobby.png`));

  /* 3 — pick the debug cursor out of the menu, then start it */

  // The menu arrived with T3.6, and it sits between the lobby and any game. The
  // fake controller sweeps `menu.x` continuously, so the highlight drifts on its
  // own and pressing A blind lands on whatever happened to be selected — which
  // is how this check used to end up in Flappy's results screen rather than in
  // the cursor scene it means to measure.
  //
  // So select deliberately, via the display's own arrow keys, and confirm what
  // is highlighted before starting it.
  check('the menu lists the games', (await read()).games.length >= 2);

  const beforeMenu = (await read()).audio.played;
  await selectGame(read, DEBUG_GAME);
  const afterMenu = await read();
  check(
    'moving through the menu makes a sound',
    afterMenu.audio.played > beforeMenu,
    `${beforeMenu} -> ${afterMenu.audio.played}`,
  );

  const play = await waitOn(read, 'reaches play', (s) => s.hudKeys.includes('age'), 8000);
  check('starting the debug cursor from the menu moves lobby to play', play.hudKeys.includes('age'));
  check('link is online', play.hud.link === 'online', play.hud.link);
  check('room is correct', play.hud.room === ROOM, play.hud.room);

  const age = Number.parseFloat(play.hud.age);
  check(
    `frame age within the ${AGE_BUDGET_MS} ms budget`,
    Number.isFinite(age) && age <= AGE_BUDGET_MS,
    play.hud.age,
  );

  // The axes must actually move. A cursor pinned at zero is what a broken
  // mapping, a dead InputAdapter and an unfed PredictiveAxis all look like, and
  // a single sample cannot tell those apart from a working one.
  const first = await read();
  await sleep(700);
  const second = await read();
  check(
    'aim axes are moving',
    first.hud['aim.x'] !== second.hud['aim.x'] || first.hud['aim.y'] !== second.hud['aim.y'],
    `${first.hud['aim.x']}/${first.hud['aim.y']} then ${second.hud['aim.x']}/${second.hud['aim.y']}`,
  );
  await cdp.screenshot(resolve(HERE, `shot-${++stepNo}-play.png`));

  // A gesture reaching the display should be audible. The fake controller swings
  // every 2 s and the debug cursor answers with `debug.gesture`, so waiting for
  // the counter to move proves the whole path — wire event, InputAdapter, game,
  // cue table, mixer — rather than merely that the mixer can count.
  const beforeSwing = (await read()).audio.played;
  const sounded = await waitOn(
    read,
    'a gesture during play makes a sound',
    (s) => s.audio?.played > beforeSwing,
    8000,
  );
  check(
    'a gesture during play makes a sound',
    sounded.audio?.played > beforeSwing,
    `${beforeSwing} -> ${sounded.audio?.played}`,
  );
  // The debug cursor is the quietest thing in the menu. If even this exhausts the
  // polyphony budget the cap is set wrong, and a real game would be dropping the
  // sounds a player is actually listening for.
  check(
    'no cue was dropped for lack of headroom',
    sounded.audio?.dropped === 0,
    `dropped=${sounded.audio?.dropped}`,
  );

  /* 4 — the controller goes away */
  stopController();
  const dropped = await waitOn(read, 'falls back to pairing', (s) => s.hasQr, 6000);
  check('losing the controller returns to pairing', dropped.hasQr === true);
  check('HUD is torn down on exit', dropped.hudKeys?.length === 0, dropped.hudKeys?.join(','));

  // Every request is accounted for. This is the mixer's own arithmetic — if it
  // stops adding up, cues are being lost somewhere between the game and the
  // speaker, which is the one audio failure that is otherwise invisible.
  const a = dropped.audio ?? {};
  check(
    'every cue request is accounted for',
    a.played + a.throttled + a.dropped + a.silenced === a.requested,
    JSON.stringify(a),
  );
  await cdp.screenshot(resolve(HERE, `shot-${++stepNo}-dropped.png`));

  /* console hygiene */
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
