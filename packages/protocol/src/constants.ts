/**
 * Tuning knobs and budgets shared across layers.
 *
 * Plan rule: tuning constants live HERE and nowhere else. The sensor/gesture
 * tuning sessions (T1.2, T1.3) are the most token-expensive work in the project
 * precisely because they iterate with a human holding a phone — keeping every
 * knob in one file means those sessions edit one file.
 *
 * Defaults from `docs/layer-1-controller.md` §Tuning knobs.
 */

import type { RoomCode } from './types.js';

/** Frames per second pushed to the server. */
export const SEND_HZ = 50;

/** Send loop period, ms. */
export const SEND_INTERVAL_MS = 1000 / SEND_HZ;

/** Sensor capture rate, Hz. Captured faster than sent, then throttled. */
export const CAPTURE_HZ = 60;

/**
 * Acceleration magnitude that counts as a swing, m/s².
 * Lower = more sensitive.
 *
 * TODO(on-device): UNVALIDATED. This is the doc's starting guess, never tested
 * against a human swinging a real phone. The controller's debug HUD shows live
 * |accel| against this number plus a running peak, so tuning is reading a value
 * rather than guessing. Tune here and nowhere else. Plan ref: T1.3.
 */
export const SWING_THRESHOLD = 16;

/**
 * Lockout between recognized gestures, ms. Prevents one swing firing twice.
 *
 * TODO(on-device): UNVALIDATED alongside SWING_THRESHOLD. Note the recognizer
 * also re-arms below 60% of threshold, so this cooldown is the second line of
 * defence against double-fires, not the only one. Plan ref: T1.3.
 */
export const GESTURE_COOLDOWN = 280;

/**
 * End-to-end latency budget, phone capture → screen render, ms.
 *
 * `docs/00-overview.md` §Latency budget calls this "the single most important
 * number". Exceed the max and motion stops feeling connected to the hand.
 */
export const LATENCY_BUDGET_MS = { good: 50, max: 80 } as const;

/**
 * Smoothing half-life for SensorFusion (T1.2), ms.
 *
 * Time for half of a step change in orientation to be absorbed. Framed as a
 * half-life rather than a per-sample coefficient so the smoothing is independent
 * of sample rate — a fixed coefficient smooths twice as hard at 120 Hz as at 60.
 *
 * Lower is more responsive and more jittery. 45 ms is roughly three frames at
 * 60 Hz: enough to take the edge off sensor noise, short enough that it is not
 * the dominant term in the latency budget.
 *
 * TODO(on-device): the value is a starting point, but the *shape* is now right —
 * see the note on FUSION_ALPHA below for what it replaced. Plan ref: T1.2.
 */
export const FUSION_HALF_LIFE_MS = 45;

/**
 * Smoothing half-life while the phone is **still**, ms.
 *
 * A single fixed half-life forces a choice nobody wants to make: raise it and a
 * held-still cursor stops shimmering but the hand outruns it; lower it and the
 * cursor is immediate and never settles. The first device session reported both
 * complaints at once, which is the signature of the wrong *shape* rather than
 * the wrong number — the same diagnosis `FUSION_ALPHA` got.
 *
 * So the half-life now varies with how fast the phone is actually turning. At
 * rest, smooth hard: nothing is happening, so latency costs nothing and the
 * jitter is pure sensor noise. Standard one-euro-filter reasoning, which exists
 * for exactly this trade.
 */
export const FUSION_HALF_LIFE_REST_MS = 120;

/**
 * Smoothing half-life while the phone is **moving fast**, ms.
 *
 * Deliberately short. During a fast motion the eye tracks the hand, not the
 * noise, and any smoothing here reads directly as lag. This is the value that
 * decides whether a slash feels attached to the wrist.
 */
export const FUSION_HALF_LIFE_FAST_MS = 12;

/**
 * Angular speed at which smoothing has fully relaxed to the fast half-life,
 * degrees per second.
 *
 * Below it the filter blends toward the rest half-life. 90 °/s is about the
 * speed of a deliberate re-aim — slower than a slash, far faster than a hand
 * trying to hold still.
 *
 * TODO(on-device): the crossover is the knob to turn if aiming feels sticky
 * (lower it) or if a held cursor still shimmers (raise it). Plan ref: T1.2.
 */
export const FUSION_FAST_DEG_PER_S = 90;

/**
 * @deprecated Kept only to document why it went away.
 *
 * This was the gyro weight of a complementary filter that predicted forward with
 * `rotationRate` and then pulled toward the `deviceorientation` reading. The
 * prediction step integrated angular velocity **into Euler angles**, which is
 * only valid near a flat pose: Euler rates and body angular velocity are related
 * by a transform that depends on the current angles and degenerates as `beta`
 * approaches ±90°.
 *
 * Held upright — `beta` ≈ 90° — `rotationRate.beta` therefore stopped
 * corresponding to `beta`'s derivative and fought the reading instead of
 * predicting it. On a real device that presented as the vertical axis being both
 * reversed and sluggish while the horizontal axis, sitting near `gamma` ≈ 0, was
 * fine.
 *
 * The deeper problem was fusing twice: `deviceorientation` is *already* the
 * platform's accelerometer + gyro + magnetometer fusion, so integrating the gyro
 * on top of it added a second, wrong fusion rather than new information.
 */
export const FUSION_ALPHA = 0.98;

/* ---- room codes ---- */

/**
 * Alphabet for room codes. Deliberately excludes I, O, 0, 1 — codes get read
 * aloud across a room and typed on a phone keyboard.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Room code length. Matches the doc's examples ("7QK2"). */
export const ROOM_CODE_LENGTH = 4;

const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** True if `code` is a well-formed room code. Used by pairing and matchmaking. */
export function isValidRoomCode(code: unknown): code is string {
  return typeof code === 'string' && ROOM_CODE_RE.test(code);
}

/* ---- transport ---- */

/** Heartbeat ping period, ms (T2.4). */
export const HEARTBEAT_INTERVAL_MS = 2000;

/** Connection considered dead after this long with no traffic, ms. */
export const HEARTBEAT_TIMEOUT_MS = 6000;

/**
 * How long a controller may go silent before the display treats it as gone, ms.
 *
 * At 50 Hz this is fifty missed frames, so it cannot trip on ordinary jitter or
 * on the unreliable channel dropping a few state frames under load — only on a
 * controller that has actually stopped sending. Deliberately shorter than
 * `HEARTBEAT_TIMEOUT_MS`: the socket to the relay can be perfectly healthy while
 * the phone at the other end is locked, backgrounded, or gone.
 *
 * Layer 4's `PresenceService` (T4.5) needs the same notion, which is why this
 * lives in the shared package rather than in the display.
 */
export const CONTROLLER_PRESENCE_TIMEOUT_MS = 1000;

/** Reconnect backoff, ms. Exponential between these bounds. */
export const RECONNECT_BACKOFF_MS = { min: 250, max: 8000 } as const;

/**
 * Wire schema version. Bump on any breaking change to `Message`.
 *
 * `docs/layer-4-backend.md` §Gotchas: mismatched schema versions "break sync
 * silently". T4.6 makes the mismatch loud; this constant is what it compares.
 *
 * 1 → 2: `StateFrame` gained a required `q` (T1.7). A version-1 controller's
 * frames now fail `validate` outright, which is the intended behaviour — a
 * stale client that silently pointed nowhere would be far harder to diagnose
 * than one that visibly never connects.
 */
/**
 * Fraction of `SWING_THRESHOLD` at which a flick's **direction** is sampled.
 *
 * Not at the peak, and this is the whole trick of T1.8. A flick is two phases:
 * the hand accelerates into the motion, then decelerates to stop it — and the
 * deceleration is frequently the *larger* of the two, because stopping a wrist
 * is more abrupt than starting it. Classifying at the peak therefore reports the
 * direction backwards on exactly the crispest gestures.
 *
 * Sampling on the way *up*, before the peak, catches the acceleration phase
 * while it is still unambiguous. Too low and the sample is noise; too high and
 * it drifts into the turnaround.
 *
 * TODO(on-device): a guess until the recorded traces exist. The traces make this
 * offline-testable, which is why the plan lists them ahead of T1.8. Plan ref: T1.8.
 */
export const GESTURE_ONSET_FRACTION = 0.45;

/**
 * How much the winning axis must beat the other to be called a direction.
 *
 * A flick at 45° is not "left" or "up" — it is a diagonal, and a game that
 * commits a lane change on it will feel like it fires at random. Below this
 * ratio the gesture still fires, but as a plain `swing` with no direction, so
 * the game gets a truthful "something happened" rather than a coin toss.
 *
 * TODO(on-device): the four-outcome version of the same tuning problem
 * `SWING_THRESHOLD` has. Plan ref: T1.8.
 */
export const GESTURE_MIN_DOMINANCE = 1.35;

export const PROTOCOL_VERSION = 2;

/**
 * Mint a fresh room code.
 *
 * Lives here rather than in the display because Layer 4's `Matchmaker` (T4.2)
 * must generate codes from the identical alphabet — two implementations would
 * eventually disagree about which characters are legal, and the failure mode is
 * a code that displays fine and can never be typed in.
 *
 * Rejection sampling rather than `% length`: the alphabet is 32 characters, so
 * modulo happens to be unbiased today, but it silently stops being so the moment
 * a character is added or removed. The loop is correct regardless.
 */
export function generateRoomCode(length = ROOM_CODE_LENGTH): RoomCode {
  const alphabet = ROOM_CODE_ALPHABET;
  const limit = 256 - (256 % alphabet.length);
  const out: string[] = [];
  const buf = new Uint8Array(1);

  while (out.length < length) {
    let byte: number;
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(buf);
      byte = buf[0] as number;
    } else {
      byte = Math.floor(Math.random() * 256);
    }
    if (byte >= limit) continue; // discard the biased tail
    out.push(alphabet[byte % alphabet.length] as string);
  }
  return out.join('');
}
