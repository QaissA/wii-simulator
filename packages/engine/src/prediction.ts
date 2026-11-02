/**
 * Prediction and smoothing (T3.5).
 *
 * `docs/layer-3-display-engine.md` §Latency & feel: "Apply client-side
 * prediction and interpolation so tilt/aim feels instant despite network jitter."
 *
 * Two problems, opposite in character:
 *
 *   - **Latency** — the pose on screen is always as old as the trip from the
 *     phone. `Predictor` extrapolates forward along the last measured velocity
 *     so the cursor sits where the hand *is*, not where it was 40 ms ago.
 *   - **Jitter** — frames arrive unevenly and carry sensor noise, which reads as
 *     a twitching cursor. `Smoother` low-passes that away.
 *
 * They fight each other: smoothing adds lag, prediction removes it but amplifies
 * noise (differentiating a noisy signal is the classic way to make it worse). So
 * smooth first, predict second — the order used in `PredictiveAxis` below.
 *
 * Extrapolation is capped. Past roughly one frame of prediction the error from a
 * hand that changed direction exceeds the lag being corrected, and overshoot
 * looks worse than delay.
 */

import { deltaDeg, normalizeDeg } from '@wii/protocol';

/** Exponential smoothing over irregularly-spaced samples. */
export class Smoother {
  #value: number | null = null;
  #lastT = 0;
  readonly #halfLifeMs: number;

  /**
   * @param halfLifeMs Time for a step change to be half-absorbed. Framing it as
   * a half-life rather than a raw coefficient makes the smoothing independent of
   * sample rate — a fixed alpha silently smooths twice as hard at 100 Hz as at
   * 50 Hz.
   */
  constructor(halfLifeMs = 40) {
    this.#halfLifeMs = halfLifeMs;
  }

  push(value: number, t: number): number {
    if (this.#value === null || t <= this.#lastT) {
      this.#value = value;
      this.#lastT = t;
      return value;
    }
    const dt = t - this.#lastT;
    this.#lastT = t;
    // 2^(-dt/halfLife): the fraction of the old value surviving this interval.
    const keep = Math.pow(2, -dt / this.#halfLifeMs);
    this.#value = this.#value * keep + value * (1 - keep);
    return this.#value;
  }

  get value(): number | null {
    return this.#value;
  }

  reset(): void {
    this.#value = null;
    this.#lastT = 0;
  }
}

export interface PredictorOptions {
  /** Never extrapolate further than this, ms. */
  maxExtrapolationMs?: number;
  /** Smoothing half-life applied to the velocity estimate itself, ms. */
  velocityHalfLifeMs?: number;
  /** Treat values as degrees and wrap across ±180. */
  angular?: boolean;
}

/**
 * Linear extrapolation from the last two samples.
 *
 * Velocity is smoothed rather than taken raw: a single delayed frame produces a
 * spike in the naive estimate, which extrapolation would then multiply into a
 * visible lurch.
 */
export class Predictor {
  #last: number | null = null;
  #lastT = 0;
  #velocity = 0; // units per ms
  readonly #velocitySmoother: Smoother;
  readonly #maxExtrapolationMs: number;
  readonly #angular: boolean;

  constructor(options: PredictorOptions = {}) {
    this.#maxExtrapolationMs = options.maxExtrapolationMs ?? 60;
    this.#velocitySmoother = new Smoother(options.velocityHalfLifeMs ?? 50);
    this.#angular = options.angular ?? false;
  }

  push(value: number, t: number): void {
    if (this.#last === null || t <= this.#lastT) {
      this.#last = value;
      this.#lastT = t;
      return;
    }
    const dt = t - this.#lastT;
    const delta = this.#angular ? deltaDeg(this.#last, value) : value - this.#last;
    this.#velocity = this.#velocitySmoother.push(delta / dt, t);
    this.#last = value;
    this.#lastT = t;
  }

  /** Value predicted for `now`, clamped to `maxExtrapolationMs` ahead. */
  valueAt(now: number): number {
    if (this.#last === null) return 0;
    const ahead = Math.max(0, Math.min(now - this.#lastT, this.#maxExtrapolationMs));
    const predicted = this.#last + this.#velocity * ahead;
    return this.#angular ? normalizeDeg(predicted) : predicted;
  }

  /** Units per second — handy for HUDs and for deciding if motion is settled. */
  get velocityPerSecond(): number {
    return this.#velocity * 1000;
  }

  get hasSample(): boolean {
    return this.#last !== null;
  }

  reset(): void {
    this.#last = null;
    this.#lastT = 0;
    this.#velocity = 0;
    this.#velocitySmoother.reset();
  }
}

export interface PredictiveAxisOptions extends PredictorOptions {
  smoothingHalfLifeMs?: number;
}

/**
 * Smooth-then-predict, the combination a game actually wants.
 *
 * Order matters: predicting from raw samples amplifies sensor noise, so the
 * signal is smoothed before its velocity is measured.
 */
export class PredictiveAxis {
  readonly #smoother: Smoother;
  readonly #predictor: Predictor;

  constructor(options: PredictiveAxisOptions = {}) {
    this.#smoother = new Smoother(options.smoothingHalfLifeMs ?? 40);
    this.#predictor = new Predictor(options);
  }

  /** Feed a sample with the time it was *captured*, not received. */
  push(value: number, capturedAtMs: number): void {
    this.#predictor.push(this.#smoother.push(value, capturedAtMs), capturedAtMs);
  }

  valueAt(now: number): number {
    return this.#predictor.valueAt(now);
  }

  get velocityPerSecond(): number {
    return this.#predictor.velocityPerSecond;
  }

  reset(): void {
    this.#smoother.reset();
    this.#predictor.reset();
  }
}
