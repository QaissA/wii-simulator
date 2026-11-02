/**
 * Calibrator — stores a neutral pose and expresses every frame relative to it.
 *
 * `docs/layer-1-controller.md` §Gotchas: "Coordinate frames differ across
 * browsers — always calibrate." Calibration is what makes the same wrist motion
 * produce the same numbers on an iPhone and a Pixel, so nothing downstream ever
 * sees a raw orientation.
 *
 * ## Why this composes rotations instead of subtracting angles
 *
 * The previous version did `o - offset`, per angle. That is not what calibration
 * means. Rotations compose by multiplication, not subtraction, and the two only
 * agree when the pose is near the one the offset was captured in — which is
 * precisely the condition that fails the moment a player turns their wrist.
 *
 * Worse, the error was invisible in the obvious test: hold the phone the way it
 * was calibrated, tilt slightly, and per-angle subtraction looks right. It only
 * breaks where `beta` nears ±90°, where `alpha` and `gamma` stop being
 * independent — which is where a phone sits when it is held upright.
 *
 * So the neutral pose is stored as a quaternion, and calibration is
 * `q_neutral⁻¹ · q_current`: the rotation that takes the phone from where it was
 * calibrated to where it is now. That is correct at every attitude, with no
 * special cases. Plan ref: T1.7.
 */

import type { Euler, Quat, Vec3, Vec3Tuple } from '@wii/protocol';
import {
  QUAT_IDENTITY,
  quatConjugate,
  quatMul,
  quatNormalize,
  quatRotate,
  quatToEuler,
  resolveForward,
  resolveGrip,
} from '@wii/protocol';

/**
 * v3, because v2 stored a neutral pose alone.
 *
 * A v2 value is still a *correct* neutral quaternion, so it would load and look
 * applied — while carrying no grip, which is the whole point of this version.
 * The failure would be the silent one: a calibration that appears fine and aims
 * wrong. One tap of Calibrate is the right price. Plan ref: T1.7.
 */
const STORAGE_KEY = 'wii.calibration.v3';

export class Calibrator {
  #neutral: Quat = QUAT_IDENTITY;
  /**
   * Canonical-pointing-frame basis, resolved from the neutral pose.
   *
   * Identity until someone calibrates, so an uncalibrated controller stays an
   * exact pass-through and the offline harnesses are unaffected.
   */
  #basis: Quat = QUAT_IDENTITY;
  #calibrated = false;

  constructor() {
    this.#load();
  }

  /** Capture the current pose as neutral. Call from the Calibrate button. */
  capture(current: Quat): void {
    this.#neutral = quatNormalize(current);
    // Which way the phone is aimed is knowable exactly once — now, while the
    // player is holding it the way they mean to play. See `grip.ts`.
    this.#basis = resolveGrip(this.#neutral);
    this.#calibrated = true;
    this.#save();
  }

  /**
   * Express an orientation relative to the neutral pose.
   *
   * Safe to call before any calibration: the neutral pose starts as identity, so
   * this is a pass-through until someone taps Calibrate.
   */
  apply(q: Quat): Quat {
    const relative = quatMul(quatConjugate(this.#neutral), quatNormalize(q));
    // Change of basis, not an extra rotation: `conj(B) · R · B` re-reads the
    // same physical motion in the canonical pointing frame, where forward is
    // `-z` and `DEFAULT_FORWARD` is therefore correct for every grip.
    return quatMul(quatMul(quatConjugate(this.#basis), relative), this.#basis);
  }

  /**
   * Re-express a **device-frame vector** in the calibrated screen frame (T1.8).
   *
   * This is not `apply`. `apply` returns the device's *orientation* expressed in
   * canonical coordinates — a similarity transform, `conj(B) · R · B`. Rotating a
   * vector needs the plain change of frame instead: device → neutral → canonical,
   * with no trailing `B`. Using `apply` here would look almost right and be wrong
   * by exactly one basis rotation, which is the kind of error that shows up as
   * "left sometimes means up".
   *
   * At the calibration pose this reduces to `conj(basis)`, which is what turns a
   * device axis into a screen axis — the whole point.
   */
  toScreenFrame(v: Vec3, q: Quat): Vec3 {
    const relative = quatMul(quatConjugate(this.#neutral), quatNormalize(q));
    const toCanonical = quatMul(quatConjugate(this.#basis), relative);
    const [x, y, z] = quatRotate(toCanonical, [v.x, v.y, v.z]);
    return { x, y, z };
  }

  /** The same thing as angles, for the debug HUD. Never for game logic. */
  applyEuler(q: Quat): Euler {
    return quatToEuler(this.apply(q));
  }

  get neutral(): Quat {
    return this.#neutral;
  }

  /** The device axis this grip aims with — for the debug HUD. */
  get forward(): Vec3Tuple {
    return resolveForward(this.#neutral);
  }

  get calibrated(): boolean {
    return this.#calibrated;
  }

  reset(): void {
    this.#neutral = QUAT_IDENTITY;
    this.#basis = QUAT_IDENTITY;
    this.#calibrated = false;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* private mode — calibration just won't persist */
    }
  }

  #save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.#neutral));
    } catch {
      /* private mode — calibration just won't persist */
    }
  }

  /**
   * A versioned key, and the old one is not read.
   *
   * v1 stored an Euler offset. Reinterpreting those three numbers as anything in
   * this scheme would silently produce a wrong neutral pose — a calibration that
   * looks applied and is not. Discarding it costs one tap of the Calibrate
   * button, which is the correct price.
   */
  #load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.length === 4 &&
        parsed.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) {
        this.#neutral = quatNormalize(parsed as unknown as Quat);
        this.#basis = resolveGrip(this.#neutral);
        this.#calibrated = true;
      }
    } catch {
      /* corrupt or unavailable — fall back to an uncalibrated identity */
    }
  }
}
