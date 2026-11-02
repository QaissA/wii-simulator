/**
 * GestureRecognizer — swing and shake from acceleration magnitude.
 *
 * `docs/layer-1-controller.md` §Modules: "swing/shake via acceleration magnitude
 * threshold + cooldown; replace with per-gesture classifiers for real games."
 *
 * Deliberately simple. The thresholds it uses are guesses until a human swings a
 * real phone — see `docs/implementation-plan.md` T1.3. What this class provides
 * for that session is *observability*: `peak` and the fired magnitude let the
 * debug HUD show how close a motion came to firing, which turns tuning from blind
 * guessing into reading a number.
 *
 * TODO(on-device): NOTHING HERE HAS BEEN TESTED AGAINST REAL MOTION. Before
 * tuning anything, use the controller's **Export trace** button to record the
 * fixtures listed in `docs/implementation-plan.md` §Outstanding — three clean
 * swings, three gentle waves that must NOT fire, one shake. Tuning without them
 * means re-swinging a phone for every candidate value; with them, this class
 * becomes offline-testable and stays that way. Plan ref: T1.3.
 */

import {
  GESTURE_COOLDOWN,
  GESTURE_MIN_DOMINANCE,
  GESTURE_ONSET_FRACTION,
  SWING_THRESHOLD,
  magnitude,
} from '@wii/protocol';
import type { Vec3 } from '@wii/protocol';

export type GestureName = 'swing' | 'shake';

/** Screen-relative, never device-relative — see the note on `update`. */
export type GestureDirection = 'up' | 'down' | 'left' | 'right';

export interface GestureEventInfo {
  name: GestureName;
  /**
   * Which way the flick went, or `null` when it was too diagonal to call.
   *
   * `null` is a real answer, not a failure: a game told "left" on a 45° flick
   * commits a lane change the player did not ask for, and that is
   * indistinguishable from a bug. Reporting no direction lets the game fall back
   * to the plain gesture, which is what the `swing:left` → `swing` lookup in
   * `InputAdapter` exists for.
   */
  direction: GestureDirection | null;
  /**
   * The wire name — `"swing"` or `"swing:left"`.
   *
   * Direction rides **in the name** rather than in a new field, so no protocol
   * version bump was needed: `GestureEvent.name` was already a plain string, and
   * `InputMapping.gestures` is already keyed by it. A display that knows only
   * `"swing"` still matches, via the base-name fallback.
   */
  wireName: string;
  /** How far the winning axis beat the other. 1 is a perfect diagonal. */
  dominance: number;
  /** Acceleration magnitude at the moment it fired, m/s². For tuning. */
  magnitude: number;
  t: number;
}

export interface GestureOptions {
  threshold?: number;
  cooldownMs?: number;
  /** Fraction of the threshold at which direction is sampled. */
  onsetFraction?: number;
  /** How much the winning axis must beat the other. */
  minDominance?: number;
  /** Peaks within this window to count as a shake rather than a swing, ms. */
  shakeWindowMs?: number;
  /** Peaks required for a shake. */
  shakePeaks?: number;
}

export class GestureRecognizer {
  readonly #threshold: number;
  readonly #cooldown: number;
  readonly #shakeWindow: number;
  readonly #shakePeaks: number;

  readonly #onsetFraction: number;
  readonly #minDominance: number;

  #lastFired = 0;
  #armed = true;
  #peakTimes: number[] = [];
  #peak = 0;
  /**
   * The acceleration sampled on the way *up*, before the peak.
   *
   * Held from onset until the gesture fires or the motion dies out. This is the
   * vector direction is read from — see `GESTURE_ONSET_FRACTION`.
   */
  #onset: Vec3 | null = null;

  constructor(options: GestureOptions = {}) {
    this.#threshold = options.threshold ?? SWING_THRESHOLD;
    this.#cooldown = options.cooldownMs ?? GESTURE_COOLDOWN;
    this.#onsetFraction = options.onsetFraction ?? GESTURE_ONSET_FRACTION;
    this.#minDominance = options.minDominance ?? GESTURE_MIN_DOMINANCE;
    // TODO(on-device): these two are pure guesses — unlike the swing constants
    // they are not even in the doc. Shake may want a lower threshold than swing
    // rather than the same one, since shaking is typically less forceful per
    // peak. Revisit once the first real game actually uses a shake. Plan ref: T1.3.
    this.#shakeWindow = options.shakeWindowMs ?? 900;
    this.#shakePeaks = options.shakePeaks ?? 3;
  }

  /**
   * Feed one acceleration sample.
   *
   * `acc` must already be in the **calibrated, screen-relative frame** — the
   * caller rotates it, exactly as `docs/implementation-plan.md` T1.8 requires:
   * *"direction has to be resolved in the device frame and then rotated into the
   * world by the calibrated orientation — otherwise 'swipe left' means something
   * different every time the wrist rolls."*
   *
   * Magnitude is invariant under rotation, so swing and shake behave exactly as
   * they did before this change; only direction depends on the frame.
   *
   * @returns the gesture that fired, or `null`.
   */
  update(acc: Vec3, now: number): GestureEventInfo | null {
    const mag = magnitude(acc);
    if (mag > this.#peak) this.#peak = mag;

    // Capture the direction on the way up, well before the peak. Once captured
    // it is held: a later, larger sample is likely the *deceleration* and points
    // the wrong way.
    if (this.#armed && this.#onset === null && mag >= this.#threshold * this.#onsetFraction) {
      this.#onset = { x: acc.x, y: acc.y, z: acc.z };
    }

    // Re-arming on the way down is what stops one swing firing repeatedly across
    // the several frames its peak spans. The cooldown alone would not: a long
    // swing can stay above threshold for longer than the cooldown.
    //
    // TODO(on-device): the 0.6 re-arm ratio is a guess. Too high and a swing that
    // decays slowly never re-arms, so the second swing of a rally is swallowed;
    // too low and one swing's tail fires twice. The recorded traces settle it.
    if (mag < this.#threshold * 0.6) {
      this.#armed = true;
      // A motion that rose past the onset and then died without firing must not
      // leave its direction behind for the next one to inherit.
      if (mag < this.#threshold * this.#onsetFraction * 0.8) this.#onset = null;
    }

    if (!this.#armed || mag < this.#threshold) return null;
    if (now - this.#lastFired < this.#cooldown) return null;

    this.#armed = false;
    this.#lastFired = now;

    this.#peakTimes.push(now);
    this.#peakTimes = this.#peakTimes.filter((t) => now - t <= this.#shakeWindow);

    const name: GestureName = this.#peakTimes.length >= this.#shakePeaks ? 'shake' : 'swing';
    // A shake consumes its peaks, so a long wobble reports shake once rather
    // than on every subsequent peak.
    if (name === 'shake') this.#peakTimes = [];

    const { direction, dominance } = this.#classify(this.#onset ?? acc);
    this.#onset = null;

    // A shake has no meaningful direction — it is several peaks in alternating
    // directions by definition, so naming one of them would be arbitrary.
    const directed = name === 'swing' ? direction : null;

    return {
      name,
      direction: directed,
      wireName: directed ? name + ':' + directed : name,
      dominance,
      magnitude: mag,
      t: now,
    };
  }

  /**
   * Dominant screen axis of a flick.
   *
   * `z` is deliberately ignored. It is the axis into and out of the screen, and
   * a player's flick almost always carries some of it simply because a wrist
   * rotates about the forearm rather than sliding in a plane. Including it would
   * make "toward me" compete with "left", which is not a distinction any of the
   * planned games asks for.
   */
  #classify(v: Vec3): { direction: GestureDirection | null; dominance: number } {
    const ax = Math.abs(v.x);
    const ay = Math.abs(v.y);
    const major = Math.max(ax, ay);
    const minor = Math.min(ax, ay);

    // Guard the divide: a flick with no lateral component at all is pure `z`,
    // which has no direction to report rather than an infinitely confident one.
    if (major < 1e-6) return { direction: null, dominance: 0 };

    const dominance = minor < 1e-6 ? Infinity : major / minor;
    if (dominance < this.#minDominance) return { direction: null, dominance };

    const direction: GestureDirection =
      ax >= ay ? (v.x > 0 ? 'right' : 'left') : v.y > 0 ? 'up' : 'down';
    return { direction, dominance };
  }

  /** Highest magnitude seen since the last `resetPeak()`. Drives the HUD. */
  get peak(): number {
    return this.#peak;
  }

  resetPeak(): void {
    this.#peak = 0;
  }

  /** Effective threshold, so the HUD can show how close a motion came. */
  get threshold(): number {
    return this.#threshold;
  }
}
