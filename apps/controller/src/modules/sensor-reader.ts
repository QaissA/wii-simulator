/**
 * SensorReader — subscribes to `devicemotion` / `deviceorientation` and exposes
 * the latest raw sample.
 *
 * `docs/layer-1-controller.md` §Modules: "handles null fields (some devices
 * expose `accelerationIncludingGravity` only)". That fallback is the bulk of the
 * code here — on those devices gravity has to be estimated and subtracted, or
 * every frame carries a constant ~9.81 m/s² bias that would trip the gesture
 * threshold while the phone sits still on a table.
 */

import type { Euler, Vec3 } from '@wii/protocol';

/**
 * How acceleration was obtained.
 *
 * TODO(on-device): confirm which branch each target platform actually takes —
 * the debug HUD's `source` row reports it live. iOS and Android are not assumed
 * to agree, and `derived` is the noisier path, so thresholds validated on a
 * `linear` device do not automatically transfer. Plan ref: T1.2.
 */
export type AccelSource = 'linear' | 'derived' | 'none';

export interface SensorSample {
  /** Raw, uncalibrated orientation, degrees. */
  o: Euler;
  /** Linear acceleration excluding gravity, m/s². */
  acc: Vec3;
  /** Rotation rate, deg/s. */
  rot: Euler;
  /** How `acc` was obtained. Surfaced in the debug HUD — it explains a lot. */
  source: AccelSource;
  /** Timestamp of the most recent motion event, ms. */
  t: number;
}

const ZERO_EULER: Euler = { a: 0, b: 0, g: 0 };
const ZERO_VEC: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Low-pass coefficient used to track gravity on devices without a linear
 * acceleration channel. Small = slow to follow, which is what we want: gravity
 * changes only as fast as the phone is re-oriented, so anything faster is signal.
 *
 * TODO(on-device): UNVALIDATED on a `derived` device. Too high and real swings
 * get absorbed into the gravity estimate and stop firing; too low and re-orienting
 * the phone leaves a lingering bias that fires spurious gestures. Check by
 * rotating the phone slowly through 90°, then holding still: |accel| in the debug
 * HUD should settle back to ~0 within a second. Plan ref: T1.2.
 */
const GRAVITY_LOWPASS = 0.08;

const num = (v: number | null | undefined): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : 0;

export class SensorReader {
  #o: Euler = { ...ZERO_EULER };
  #acc: Vec3 = { ...ZERO_VEC };
  #rot: Euler = { ...ZERO_EULER };
  #gravity: Vec3 = { ...ZERO_VEC };
  #source: AccelSource = 'none';
  #t = 0;
  #started = false;

  readonly #onOrientation = (e: DeviceOrientationEvent): void => {
    this.#o = { a: num(e.alpha), b: num(e.beta), g: num(e.gamma) };
  };

  readonly #onMotion = (e: DeviceMotionEvent): void => {
    this.#t = performance.now();

    const rr = e.rotationRate;
    if (rr) this.#rot = { a: num(rr.alpha), b: num(rr.beta), g: num(rr.gamma) };

    // Preferred: the platform already removed gravity for us.
    const lin = e.acceleration;
    if (lin && (lin.x !== null || lin.y !== null || lin.z !== null)) {
      this.#acc = { x: num(lin.x), y: num(lin.y), z: num(lin.z) };
      this.#source = 'linear';
      return;
    }

    // Fallback: track gravity with a low-pass filter and subtract it.
    const incl = e.accelerationIncludingGravity;
    if (incl && (incl.x !== null || incl.y !== null || incl.z !== null)) {
      const raw = { x: num(incl.x), y: num(incl.y), z: num(incl.z) };
      const k = GRAVITY_LOWPASS;
      this.#gravity = {
        x: this.#gravity.x * (1 - k) + raw.x * k,
        y: this.#gravity.y * (1 - k) + raw.y * k,
        z: this.#gravity.z * (1 - k) + raw.z * k,
      };
      this.#acc = {
        x: raw.x - this.#gravity.x,
        y: raw.y - this.#gravity.y,
        z: raw.z - this.#gravity.z,
      };
      this.#source = 'derived';
      return;
    }

    this.#source = 'none';
  };

  start(): void {
    if (this.#started) return;
    this.#started = true;
    // `deviceorientation` does not fire inside a cross-origin iframe on some
    // browsers — serve this page top-level (§Gotchas).
    window.addEventListener('deviceorientation', this.#onOrientation);
    window.addEventListener('devicemotion', this.#onMotion);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    window.removeEventListener('deviceorientation', this.#onOrientation);
    window.removeEventListener('devicemotion', this.#onMotion);
  }

  /** Latest sample. Cheap — safe to call every capture tick. */
  read(): SensorSample {
    return { o: this.#o, acc: this.#acc, rot: this.#rot, source: this.#source, t: this.#t };
  }

  /** True once any motion event has been seen. Distinguishes "denied" from "quiet". */
  get receiving(): boolean {
    return this.#t > 0;
  }
}
