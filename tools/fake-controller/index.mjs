/**
 * A phone-shaped thing, without the phone.
 *
 * `docs/implementation-plan.md` splits sessions on "needs a human" versus "does
 * not". This tool moves the line: it drives the relay exactly as Layer 1 does —
 * same protocol package, same 50 Hz cadence, same clock discipline — so the
 * display's rendering (T3.1/T3.4) can be verified end to end without anyone
 * holding a device.
 *
 * What it does NOT replace is the on-device work. It has no sensors, so it says
 * nothing about SWING_THRESHOLD, about whether iOS grants motion permission, or
 * about how the thing feels in a hand. Those stay human. This exists so that
 * when a human finally does pick up a phone, everything except the sensors has
 * already been proven.
 *
 *   node tools/fake-controller/index.mjs --room 7QK2 [--relay ws://localhost:8081]
 *
 * One artifact to know about: on Windows the default timer granularity is
 * ~15.6 ms, so `setInterval(20)` actually fires about every 31 ms and the
 * display reads ~32 Hz rather than 50. That is this tool, not the app — a real
 * controller drives its send loop from requestAnimationFrame, which is tied to
 * the refresh rate and has no such floor. Do not tune anything against it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WebSocket } from 'ws';
import {
  ClockSync,
  SEND_INTERVAL_MS,
  SWING_THRESHOLD,
  encode,
  isValidRoomCode,
  quatFromEuler,
  quatToEuler,
  tryDecode,
} from '@wii/protocol';

// Skip a bare `--`: `pnpm fake-controller -- --room X` forwards the separator
// as a real argument, and pairing positionally from it would silently read the
// room as "--room". Filtering first means both invocations behave the same.
const argv = process.argv.slice(2).filter((a) => a !== '--');
const args = new Map();
for (let i = 0; i < argv.length; i += 2) {
  args.set(String(argv[i]).replace(/^--/, ''), argv[i + 1]);
}

const room = (args.get('room') ?? '').toUpperCase();
/**
 * The relay switches to `wss://` whenever a dev certificate exists, so default
 * to whichever scheme is actually in play rather than to `ws://`. Guessing wrong
 * fails as a connection refusal, which reads as "the relay is down".
 */
const devCa = fileURLToPath(new URL('../dev-cert/certs/dev-ca.crt', import.meta.url));
const secure = existsSync(devCa);
const relay = args.get('relay') ?? `${secure ? 'wss' : 'ws'}://localhost:8081`;
/** Seconds between synthetic swings. 0 disables them. */
const swingEvery = Number(args.get('swing-every') ?? 4);
/**
 * Seconds between synthetic *slashes*. 0 disables them.
 *
 * A slash is a fast orientation sweep, not an acceleration spike — which is the
 * whole distinction T3.8 rests on. Fruit slash has no `swing` binding at all: it
 * cuts when the *pointer* crosses a collider above `CUT_SPEED`, so the only way
 * to exercise it is to actually move where the phone is aiming, quickly.
 *
 * The idle Lissajous below deliberately cannot do this. Its peak pointer speed
 * sits just under the cut threshold, which is correct behaviour — a slow re-aim
 * must not slice — and it means a fruit-slash check driven by the sweep alone
 * would be testing nothing.
 */
const slashEvery = Number(args.get('slash-every') ?? 0);
/** How long one slash takes, ms. A real flick of the wrist is 100–150 ms. */
const SLASH_MS = 110;

if (!isValidRoomCode(room)) {
  if (room) console.error(`"${room}" is not a valid room code.`);
  console.error('Room codes are 4 characters from 23456789ABCDEFGHJKLMNPQRSTUVWXYZ — no I, O, 0 or 1.');
  console.error(
    'usage: node index.mjs --room <CODE> [--relay ws://host:8081] [--swing-every 4] [--slash-every 0]',
  );
  process.exit(1);
}

const clock = new ClockSync();
// Trust the local CA explicitly rather than disabling verification: this is a
// test tool, and a tool that skips certificate checks cannot notice a broken
// certificate — which is one of the things worth catching.
const socket = new WebSocket(relay, secure ? { ca: readFileSync(devCa) } : {});
const startedAt = Date.now();

let sendTimer = null;
let pingTimer = null;
let swingTimer = null;
let slashTimer = null;
let frames = 0;
let holdingA = false;

/** Active slash, or null. Interpolated across in `tick`. */
let slash = null;
/** Cycles through SLASH_PATTERNS, so strokes cover the area instead of retracing one line. */
let slashIndex = 0;

socket.on('open', () => {
  console.log(`[fake] connected to ${relay}, joining ${room}`);
  socket.send(encode({ type: 'join', room }));

  // Sync before streaming. The display converts `t` back onto its own clock, so
  // a frame stamped before the first pong lands is merely approximate — which is
  // fine, but there is no reason to make every frame approximate.
  const ping = () => socket.send(encode(clock.createPing()));
  ping();
  pingTimer = setInterval(ping, 2000);

  sendTimer = setInterval(tick, SEND_INTERVAL_MS);
  if (swingEvery > 0) swingTimer = setInterval(swing, swingEvery * 1000);
  if (slashEvery > 0) slashTimer = setInterval(startSlash, slashEvery * 1000);
});

socket.on('message', (data) => {
  const msg = tryDecode(data.toString());
  if (msg?.type === 'pong') clock.acceptPong(msg, Date.now());
});

socket.on('close', () => {
  console.log(`[fake] closed after ${frames} frames`);
  for (const t of [sendTimer, pingTimer, swingTimer, slashTimer]) if (t) clearInterval(t);
  process.exit(0);
});

socket.on('error', (err) => {
  console.error(`[fake] ${err.message}`);
  process.exit(1);
});

/**
 * A slow Lissajous sweep rather than a single axis.
 *
 * Two incommensurate frequencies mean the cursor traces the whole reachable area
 * instead of a line, so one glance at the display shows both axes moving, with
 * the right signs, and never simultaneously at their extremes — which is exactly
 * the case where a swapped or inverted binding hides.
 */
function tick() {
  const now = Date.now();
  const elapsed = (now - startedAt) / 1000;

  let gamma = Math.sin(elapsed * 0.9) * 35;
  let beta = Math.sin(elapsed * 0.61) * 30;

  // A slash overrides the idle sweep for its duration: a straight, fast diagonal
  // stroke across the reachable area, which is what a player actually does.
  if (slash) {
    const u = (now - slash.startedAt) / SLASH_MS;
    if (u >= 1) {
      slash = null;
    } else {
      gamma = slash.fromG + (slash.toG - slash.fromG) * u;
      beta = slash.fromB + (slash.toB - slash.fromB) * u;
    }
  }

  // The real controller sends a *calibrated* quaternion and derives `o` from it,
  // so this does the same rather than filling the two fields independently.
  // Frames from a fake controller that disagreed with themselves would be a
  // fault no real device could produce, and would send anyone debugging the
  // display looking in the wrong place.
  const q = quatFromEuler(0, beta, gamma);

  socket.send(
    encode({
      type: 'state',
      // Relay time, exactly as the real controller stamps it. On one machine the
      // offset is ~0, but going through ClockSync keeps this honest about what
      // the wire contract actually says `t` means.
      t: Math.round(clock.toRemote(Date.now())),
      q,
      o: quatToEuler(q),
      acc: { x: 0, y: 0, z: 0 },
      rot: { a: 0, b: 0, g: 0 },
      btn: holdingA ? ['a'] : [],
      room,
    }),
  );
  frames++;
}

/** A gesture plus a button press — the reliable channel, which state frames do not exercise. */
function swing() {
  socket.send(encode({ type: 'gesture', name: 'swing', room }));

  holdingA = true;
  socket.send(encode({ type: 'button', name: 'a', down: true, room }));
  setTimeout(() => {
    holdingA = false;
    socket.send(encode({ type: 'button', name: 'a', down: false, room }));
  }, 120);

  console.log(`[fake] swing (threshold would be ${SWING_THRESHOLD} m/s²) · ${frames} frames sent`);
}

/**
 * Stroke patterns, in `[fromGamma, fromBeta, toGamma, toBeta]` degrees.
 *
 * A single repeated diagonal covers almost none of the play area: the blade is
 * at any given x for about one simulation step, so a fruit is only cut if it
 * happens to sit within a collider's width of that one line at that instant.
 * Driving the check that way produced a game that reliably ran out of lives
 * having sliced nothing — which looked like broken collision and was really a
 * blade that never went anywhere near a fruit.
 *
 * Cycling through crossing strokes sweeps the whole reachable area within a
 * second or so, which is also a fair model of what a player does: nobody slices
 * the same line twice.
 */
const SLASH_PATTERNS = [
  [-32, -20, 32, 20],
  [32, -20, -32, 20],
  [-32, 20, 32, -20],
  [32, 20, -32, -20],
  [-32, 0, 32, 0],
  [0, -22, 0, 22],
  [-20, -22, 20, 22],
  [20, 22, -20, -22],
];

/**
 * A fast pointer stroke across the screen — what fruit slash cuts with.
 *
 * Deliberately separate from `swing()`. A swing is an acceleration event on the
 * reliable channel; a slash is pure orientation, carried by ordinary state
 * frames, and the two exercise completely different paths. Fruit slash reads
 * only the second, which is the point of having both.
 */
function startSlash() {
  const pattern = SLASH_PATTERNS[slashIndex % SLASH_PATTERNS.length];
  slashIndex++;
  const [fromG, fromB, toG, toB] = pattern;
  slash = { startedAt: Date.now(), fromG, fromB, toG, toB };
}
