/**
 * SensorFusion — attitude-safe smoothing of the platform's orientation estimate.
 *
 * `docs/layer-1-controller.md` §Modules asks for a "complementary filter fusing
 * accel + gyro into stable orientation". This deliberately does **not** do that,
 * and the reason is worth keeping.
 *
 * `deviceorientation` is not a raw accelerometer reading. It is already the
 * platform's own fusion of accelerometer, gyroscope and magnetometer — smooth,
 * absolute and drift-free. Running a second complementary filter on top of it
 * does not add information; it adds a second set of assumptions.
 *
 * The assumption that broke was this one: an earlier version predicted forward
 * with `state + rotationRate * dt`, treating `rotationRate.{alpha,beta,gamma}`
 * as the derivatives of the orientation angles of the same name. They are not.
 * Euler rates and body angular velocity are related by a transform that depends
 * on the current attitude and **degenerates as `beta` approaches ±90°** — which
 * is precisely where a phone sits when it is held upright rather than flat.
 *
 * On a real device that showed up as the vertical axis being both reversed and
 * sluggish while the horizontal axis behaved perfectly: `gamma` stays near 0 in
 * that grip, so its gyro term remained roughly valid, while `beta`'s did not and
 * fought the reading.
 *
 * ## Why this smooths quaternions rather than angles
 *
 * The gyro path is gone; what remains is an exponential smoother. The version
 * before this one smoothed the three angles independently with `lerpDeg`, which
 * carries the same latent flaw in a quieter form: three angles interpolated
 * separately do not trace a rotation between two attitudes, and near the `beta`
 * ±90° degeneracy an `alpha` that jumps 180° while the actual orientation barely
 * moves makes the filter sweep the long way round for no reason.
 *
 * Slerping the quaternion has no such case. It follows the shortest arc between
 * two orientations, which is both what the hand did and what the eye expects.
 * Plan ref: T1.7.
 *
 * Responsiveness is not lost with the gyro: the platform's estimate is already
 * low-latency, and Layer 3 adds prediction of its own (`PredictiveAxis`, T3.5)
 * where it can be tuned against what the player actually sees.
 *
 * TODO(on-device): `FUSION_HALF_LIFE_MS` is still a starting guess. Judge it by
 * pointing at a fixed spot for ~20 s and watching for jitter, then by whether
 * fast tilt feels immediate. Those pull in opposite directions. Plan ref: T1.2.
 */

import type { Euler, Quat } from '@wii/protocol';
import {
  FUSION_FAST_DEG_PER_S,
  FUSION_HALF_LIFE_FAST_MS,
  FUSION_HALF_LIFE_REST_MS,
  quatAngleDeg,
  quatNormalize,
  quatSlerp,
} from '@wii/protocol';

export interface FusionOptions {
  /** Half-life while still, ms. Default `FUSION_HALF_LIFE_REST_MS`. */
  restHalfLifeMs?: number;
  /** Half-life while moving fast, ms. Default `FUSION_HALF_LIFE_FAST_MS`. */
  fastHalfLifeMs?: number;
  /** Speed at which the fast half-life is reached, deg/s. */
  fastDegPerS?: number;
}

export class SensorFusion {
  #state: Quat | null = null;
  #lastT = 0;
  /** Smoothed angular speed, deg/s — see `#speedFor`. */
  #speed = 0;
  readonly #restHalfLifeMs: number;
  readonly #fastHalfLifeMs: number;
  readonly #fastDegPerS: number;

  constructor(options: FusionOptions = {}) {
    this.#restHalfLifeMs = options.restHalfLifeMs ?? FUSION_HALF_LIFE_REST_MS;
    this.#fastHalfLifeMs = options.fastHalfLifeMs ?? FUSION_HALF_LIFE_FAST_MS;
    this.#fastDegPerS = options.fastDegPerS ?? FUSION_FAST_DEG_PER_S;
  }

  /**
   * Fold one sample into the estimate and return the smoothed orientation.
   *
   * @param absolute Calibrated orientation quaternion.
   * @param _rate    Rotation rate, deg/s. Accepted but unused — see the note at
   *                 the top of this file. Kept in the signature because the
   *                 gesture path still reads the raw rate, and because a
   *                 quaternion-integrating fusion would want it back.
   * @param now      Monotonic clock, ms.
   */
  update(absolute: Quat, _rate: Euler, now: number): Quat {
    const target = quatNormalize(absolute);

    // First sample: nothing to smooth toward, so take the reading outright.
    if (this.#state === null) {
      this.#state = target;
      this.#lastT = now;
      return this.#state;
    }

    const dt = now - this.#lastT;
    this.#lastT = now;

    // A long gap means the page was backgrounded or the screen locked. Smoothing
    // across it would crawl toward a pose the hand left long ago, so re-seed.
    if (dt <= 0 || dt > 250) {
      this.#state = target;
      return this.#state;
    }

    // How fast the phone is actually turning, from the angle this sample covers.
    //
    // The speed estimate is itself smoothed, and deliberately asymmetrically:
    // it rises instantly and decays gently. A filter that reacted slowly to the
    // *start* of a motion would smooth hard through exactly the first frames of
    // a flick — the ones that decide whether it feels attached to the hand —
    // while a speed that collapsed the instant a hand paused would let jitter
    // back in between strokes.
    const measured = quatAngleDeg(this.#state, target) / (dt / 1000);
    this.#speed =
      measured > this.#speed ? measured : this.#speed + (measured - this.#speed) * 0.1;

    // Blend the half-life across the speed range. Smooth hard when still,
    // barely at all when moving — so responsiveness and steadiness stop being
    // the same knob pulled in opposite directions.
    const fast = Math.min(1, this.#speed / this.#fastDegPerS);
    const halfLife =
      this.#restHalfLifeMs + (this.#fastHalfLifeMs - this.#restHalfLifeMs) * fast;

    // Fraction of the *new* reading to take this step. Derived from elapsed time
    // rather than fixed per sample, so the behaviour does not change with the
    // device's refresh rate.
    const t = 1 - Math.pow(2, -dt / halfLife);

    // slerp takes the short arc, so a reading on the far side of the double
    // cover converges directly instead of sweeping most of the way around.
    this.#state = quatSlerp(this.#state, target, t);
    return this.#state;
  }

  /** Drop the estimate — call after calibration so the old pose isn't dragged along. */
  reset(): void {
    this.#state = null;
    this.#lastT = 0;
    this.#speed = 0;
  }
}
