/**
 * Full end-to-end check: the **real controller** driving the **real display**.
 *
 * `index.mjs` proves the display against a synthetic controller. This proves the
 * actual Layer 1 app — `SensorReader` → `Calibrator` → `SensorFusion` →
 * `GestureRecognizer` → `InputSerializer` → `NetClient` — reaching Layer 3
 * through the relay, with nothing stubbed on the path between them.
 *
 * The one thing it substitutes is the sensor hardware itself: `devicemotion` and
 * `deviceorientation` events are synthesised and dispatched into the page. That
 * is the honest boundary. Everything downstream of the event listener is the
 * shipping code; everything upstream of it — whether a real phone reports
 * `acceleration` or only `accelerationIncludingGravity`, whether iOS grants
 * permission, whether a human swing clears SWING_THRESHOLD — is untouched and
 * still requires a device.
 *
 * It also verifies the **pairing contract** rather than assuming it: the
 * controller URL is read off the display's own pairing screen, exactly as a
 * phone camera would take it from the QR.
 *
 * Preconditions:
 *   pnpm --filter @wii/server dev        # :8081
 *   pnpm --filter @wii/controller dev    # :8080
 *   pnpm --filter @wii/display dev       # :8082
 *   node tools/display-check/e2e.mjs
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  Cdp,
  READ_DISPLAY_STATE,
  createReporter,
  devScheme,
  launchChrome,
} from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOM = 'K7RM';
const SCHEME = devScheme();
const DISPLAY_URL = process.env.DISPLAY_URL ?? `${SCHEME.http}://localhost:8082/?room=${ROOM}`;
const RELAY_URL = process.env.RELAY_URL ?? `${SCHEME.ws}://localhost:8081`;
const DEBUG_PORT = 9334;

/** Frame age ceiling, ms. Mirrors LATENCY_BUDGET_MS.max in the protocol package. */
const AGE_BUDGET_MS = 80;

/**
 * Synthetic sensor driver, injected into the controller page.
 *
 * Dispatches `deviceorientation` and `devicemotion` at animation rate, which is
 * what a phone does. The orientation sweep uses two incommensurate frequencies
 * so both axes move independently — a single shared frequency would let a
 * swapped binding pass unnoticed.
 *
 * `acceleration` is supplied alongside `accelerationIncludingGravity` so the
 * reader takes its `linear` branch. The `derived` branch, where gravity has to
 * be estimated and subtracted, is the noisier path and is only reachable on
 * devices that withhold `acceleration` — testing it means testing a real phone,
 * not this.
 *
 * Setting `window.__e2e.hold` freezes the sweep where it stands while events
 * keep flowing, which is what a player does to press a button. The sweep's phase
 * accumulates rather than being read off the clock, so releasing the hold
 * resumes from where it paused instead of jumping to wherever the clock got to.
 */
const SENSOR_DRIVER = `(() => {
  const s = (window.__e2e = window.__e2e || {});
  if (s.running) return 'already running';
  s.running = true;
  s.t0 = performance.now();
  s.frames = 0;
  s.swingUntil = 0;
  s.hold = false;
  s.phase = 0;
  s.last = 0;

  const tick = () => {
    if (!s.running) return;
    const now = performance.now();
    const t = (now - s.t0) / 1000;
    if (!s.hold) s.phase += (now - (s.last || now)) / 1000;
    s.last = now;

    const beta = Math.sin(s.phase * 0.61) * 30;
    const gamma = Math.sin(s.phase * 0.9) * 35;

    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', {
      alpha: 0, beta, gamma, absolute: true,
    }));

    // A swing is a short burst well past the threshold, not a step change: the
    // recognizer re-arms on the way down, so a sustained value would fire once
    // and then sit latched.
    const swinging = performance.now() < s.swingUntil;
    const ax = swinging ? 26 : 0.2 * Math.sin(t * 3);

    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      acceleration: { x: ax, y: 0, z: 0 },
      accelerationIncludingGravity: { x: ax, y: 0, z: 9.81 },
      rotationRate: { alpha: 0, beta: 0, gamma: 0 },
      interval: 16,
    }));

    s.frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 'started';
})()`;

/** The menu entry this check measures. Title, because that is what the DOM shows. */
const DEBUG_GAME = 'Debug cursor';

const reporter = createReporter();
const { check, waitFor } = reporter;

/**
 * Walk the menu highlight onto `title`, without starting it.
 *
 * Read → step → re-read rather than "press left N times": even held still the
 * highlight can take one late step as the filters settle, and re-reading
 * corrects that instead of accumulating it.
 */
const settleMenu = async (read, title) => {
  for (let attempt = 0; attempt < 12; attempt++) {
    const { games } = await read();
    const at = games.findIndex((g) => g.selected);
    const want = games.findIndex((g) => g.title === title);
    if (want < 0) throw new Error(`no menu entry titled ${title}`);
    if (at === want) return;
    await display.key(at > want || at < 0 ? 'ArrowLeft' : 'ArrowRight');
  }
  throw new Error(`could not settle the menu on ${title}`);
};

const chrome = launchChrome({ port: DEBUG_PORT, profileDir: resolve(HERE, '.chrome-profile-e2e') });

let display;
let controller;

try {
  /* 1 — the display comes up and advertises how to pair with it */
  display = await Cdp.attach(DEBUG_PORT, 'display');
  await display.setViewport();
  await display.navigate(DISPLAY_URL);

  const readDisplay = () => display.evaluate(READ_DISPLAY_STATE);
  const pairing = await waitFor(readDisplay, 'display reaches pairing', (s) => s.hasQr && s.roomCode);
  check('display shows the room code', pairing.roomCode === ROOM, `got ${pairing.roomCode}`);
  check('display advertises a controller URL', !!pairing.controllerUrl, pairing.controllerUrl ?? '');

  // Follow what the screen actually says, the way a scanned QR would. If the
  // pairing contract in config.ts were wrong, this is where it surfaces.
  const controllerUrl = pairing.controllerUrl;
  check(
    'advertised URL carries the room code',
    typeof controllerUrl === 'string' && controllerUrl.includes(`room=${ROOM}`),
    controllerUrl ?? '',
  );

  /* 2 — open the real controller at that URL and clear its gate */
  controller = await Cdp.openTab(DEBUG_PORT, controllerUrl, 'controller');
  await controller.setViewport(430, 930);

  // 20 s, not the 6 s default. This is the first request to hit the controller's
  // Vite dev server, so it can pay for a cold module graph and dependency
  // pre-bundling while a second Chrome is already running — which on Windows
  // overran 6 s about half the time and failed as "document still loading",
  // looking like a hung page rather than a slow first build.
  await waitFor(
    () => controller.evaluate(`document.readyState`),
    'controller document finishes loading',
    (v) => v === 'complete',
    20_000,
  );

  const secure = await controller.evaluate('window.isSecureContext');
  check('controller origin is secure enough for sensors', secure === true, `isSecureContext=${secure}`);

  /*
   * Tap the gate, and be willing to tap again.
   *
   * `#gate-btn` exists in the parsed HTML long before `main.ts` runs and attaches
   * its listener, so waiting for the element to appear is waiting for the wrong
   * thing — the first tap can land on a button that is not yet wired to anything.
   * A player who tapped and saw nothing would simply tap again, and so does this.
   *
   * The tap goes through Chrome's real input pipeline rather than
   * `element.click()` (see Cdp.click): the controller is built around user
   * activation, and a synthetic click carries none.
   *
   * On desktop Chrome there is no `requestPermission`, so this takes the
   * implicit-access path — precisely the branch a real iPhone will NOT take.
   */
  let started = false;
  for (let attempt = 0; attempt < 6 && !started; attempt++) {
    await controller.click('#gate-btn');
    await sleep(500);
    started = await controller.evaluate(`document.getElementById('app')?.hidden === false`);
  }
  check('permission gate clears on tap', started === true);
  if (!started) {
    const why = await controller.evaluate(`JSON.stringify({
      msg: document.getElementById('gate-msg')?.textContent,
      sub: document.getElementById('gate-sub')?.textContent,
    })`);
    check('gate reported a reason', false, why);
  }

  /* 3 — feed it synthetic sensor events */
  const driver = await controller.evaluate(SENSOR_DRIVER);
  check('sensor driver injected', driver === 'started' || driver === 'already running', String(driver));

  const receiving = await waitFor(
    () => controller.evaluate(`window.__e2e?.frames ?? 0`),
    'controller receives sensor events',
    (n) => typeof n === 'number' && n > 30,
  );
  check('sensor events are flowing', typeof receiving === 'number' && receiving > 30, `${receiving} events`);

  /* 4 — it auto-connects to the room the URL carried, and the display notices */
  // `data-state` rather than the label: when online the status element shows the
  // room code, so matching on text would be matching on the wrong thing.
  const linkState = await waitFor(
    () => controller.evaluate(`document.getElementById('status')?.dataset.state ?? 'none'`),
    'controller connects to the relay',
    (v) => v === 'online',
    8000,
  );
  check('controller reports a live link', linkState === 'online', String(linkState));

  const lobby = await waitFor(
    readDisplay,
    'display sees the real controller',
    (s) => s.centre.includes('Controller connected'),
    8000,
  );
  check('real controller moves display to lobby', lobby.centre.includes('Controller connected'));
  await display.screenshot(resolve(HERE, 'e2e-1-lobby.png'));

  /* 5 — settle the menu, then press A on the controller */

  /*
   * The menu (T3.6) sits between the lobby and any game, and it is steered by
   * the same tilt this driver is sweeping — so the highlight drifts on its own
   * and a blind A press starts whichever game it happened to land on. That is a
   * genuinely intermittent failure: it passes until the sweep's phase lines up
   * differently, and then it starts Flappy and reports the cursor scene missing.
   *
   * Holding the phone still is both the fix and what a real player does. The
   * highlight is then steered deliberately with the display's arrow keys, which
   * the lobby binds, and A on the phone still does the starting — so the
   * assertion below is unchanged in what it claims.
   */
  await controller.evaluate('window.__e2e.hold = true, "held"');
  // Long enough for the fusion filter and the display's predictor to settle at
  // the frozen pose; otherwise the highlight can still take one more step.
  await sleep(400);

  await settleMenu(readDisplay, DEBUG_GAME);
  const settled = await readDisplay();
  check(
    'the menu can be steered onto the debug cursor',
    settled.games.find((g) => g.selected)?.title === DEBUG_GAME,
    settled.games.map((g) => `${g.selected ? '>' : ' '}${g.title}`).join(','),
  );

  await controller.click('[data-button="a"]', { holdMs: 120 });

  const play = await waitFor(readDisplay, 'button press starts play', (s) => s.hudKeys.includes('age'), 8000);
  check('A on the phone moves the display to play', play.hudKeys.includes('age'));

  // Let the sweep run again — everything below measures a moving cursor.
  await controller.evaluate('window.__e2e.hold = false, "released"');

  /* 6 — the numbers that decide whether any of this is usable */
  const age = Number.parseFloat(play.hud.age);
  check(
    `frame age within the ${AGE_BUDGET_MS} ms budget`,
    Number.isFinite(age) && age <= AGE_BUDGET_MS,
    play.hud.age,
  );

  const hz = Number.parseFloat(play.hud.hz);
  // The controller throttles to SEND_HZ (50) off requestAnimationFrame. Anything
  // near it is healthy; a low number here is the `send hz` reading 0 problem from
  // Phase 1, which was never confirmed against a page where rAF actually runs.
  check('send rate is near 50 Hz', Number.isFinite(hz) && hz >= 40, `${play.hud.hz} Hz`);

  /*
   * Sample the cursor from inside the page rather than by taking two snapshots.
   *
   * Two snapshots taken over a CDP round trip can easily land on the same
   * rendered frame and report "not moving" for a cursor that is moving perfectly
   * well — a false failure that cost a debugging round here. Collecting on the
   * display's own animation frames measures what the screen actually did, and
   * the sample count doubles as proof that the display kept rendering at all.
   */
  await display.evaluate(`(() => {
    window.__samples = [];
    const started = performance.now();
    const read = (name) => {
      const row = [...document.querySelectorAll('.hud-row')]
        .find((r) => r.firstElementChild.textContent === name);
      return row ? Number.parseFloat(row.lastElementChild.textContent) : NaN;
    };
    const tick = () => {
      window.__samples.push([read('aim.x'), read('aim.y')]);
      if (performance.now() - started < 1200) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return 'collecting';
  })()`);
  await sleep(1700);

  const sweep = JSON.parse(
    await display.evaluate(`(() => {
      const xs = window.__samples.map((s) => s[0]).filter(Number.isFinite);
      const ys = window.__samples.map((s) => s[1]).filter(Number.isFinite);
      return JSON.stringify({
        n: window.__samples.length,
        spreadX: xs.length ? Math.max(...xs) - Math.min(...xs) : 0,
        spreadY: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
      });
    })()`),
  );

  check('display keeps rendering', sweep.n > 20, `${sweep.n} frames in 1.2 s`);
  check(
    'tilt sweeps the cursor on both axes',
    sweep.spreadX > 0.05 && sweep.spreadY > 0.05,
    `x spread ${sweep.spreadX.toFixed(2)}, y spread ${sweep.spreadY.toFixed(2)}`,
  );
  await display.screenshot(resolve(HERE, 'e2e-2-play.png'));
  await controller.screenshot(resolve(HERE, 'e2e-3-controller.png'));

  /* 7 — a swing: the gesture path, end to end, threshold included */
  await controller.evaluate(`(window.__e2e.swingUntil = performance.now() + 90, 'ok')`);
  const swung = await waitFor(
    readDisplay,
    'a swing reaches the display',
    (s) => (s.hud.action ?? '').includes('swing'),
    6000,
  );
  check('gesture path works end to end', (swung.hud.action ?? '').includes('swing'), swung.hud.action ?? '');

  /* 8 — the phone goes away */
  await controller.evaluate(`(window.__e2e.running = false, 'stopped')`);
  await controller.click('#connect');

  const dropped = await waitFor(readDisplay, 'display falls back to pairing', (s) => s.hasQr, 8000);
  check('losing the controller returns to pairing', dropped.hasQr === true);

  /* console hygiene, both pages */
  const logs = [...display.logs, ...controller.logs];
  check('no console errors or exceptions on either page', logs.length === 0, logs.join(' | '));
} catch (err) {
  check('harness ran to completion', false, err.message);
} finally {
  display?.close();
  controller?.close();
  // Close cleanly first; `kill` is the fallback for a browser that is already
  // wedged. See Cdp.shutdown for why the order matters to the *next* run.
  await Cdp.shutdown(DEBUG_PORT).catch(() => {});
  chrome.kill();
}

process.exit(reporter.finish() ? 1 : 0);
