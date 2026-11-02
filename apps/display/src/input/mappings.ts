/**
 * The data-driven half of T3.2's seam, on the display side.
 *
 * `layer-3-display-engine.md` §Gotchas: "Keep the InputAdapter's mapping
 * data-driven so new games don't require netcode changes." This file is the
 * proof that holds — adding tennis (T3.6) means adding a literal here, not
 * touching the transport, the protocol, or `InputAdapter` itself.
 *
 * Names on the left are **wire** names, fixed by Layer 1 (`a`/`b` from the face
 * buttons, `swing`/`shake` from `GestureRecognizer`). Names on the right are
 * abstract engine actions each scene chooses to care about.
 */

import type { InputMapping } from '@wii/engine';

/**
 * ±40° off centre covers the full axis.
 *
 * Comfortably inside the range a wrist reaches without the phone leaving a
 * natural grip: past roughly 50° the screen faces away and a player stops being
 * able to see what they are doing.
 *
 * Since T1.7 this is measured as **degrees off the pointing direction**, not as
 * one Euler angle. The number is unchanged but it now means the same thing in
 * every grip, which it did not before.
 */
const TILT_RANGE_DEG = 40;

/**
 * 1.5° deadzone.
 *
 * `SensorFusion` already smooths, so this only has to absorb the residual
 * jitter of a hand that thinks it is holding still. Larger and the cursor
 * develops a dead patch in the middle that reads as "the tracking is broken".
 */
const TILT_DEADZONE_DEG = 1.5;

/**
 * The pointing mapping, and the thing T1.7 bought.
 *
 * These two axes used to name `gamma` and `beta` and carry `invert: true` each.
 * Both inversions were compensating for the Euler representation rather than for
 * anything a hand does — and neither could fix the real problem, that a phone
 * held upright sits at `beta` ≈ 90° where `alpha` and `gamma` stop being
 * independent and a `gamma`-driven axis reads a flat zero.
 *
 * `point.x`/`point.y` ask where the phone is aiming instead. Right is positive
 * and up is positive with no inversion, at any grip, because the calibrated
 * quaternion has already absorbed the grip.
 */
export const DEBUG_MAPPING: InputMapping = {
  buttons: { a: 'start', b: 'recenter' },
  gestures: { swing: 'swing', shake: 'reset' },
  axes: {
    'aim.x': { source: 'point.x', rangeDeg: TILT_RANGE_DEG, deadzoneDeg: TILT_DEADZONE_DEG },
    'aim.y': { source: 'point.y', rangeDeg: TILT_RANGE_DEG, deadzoneDeg: TILT_DEADZONE_DEG },
  },
};

/**
 * The menu's own mapping.
 *
 * Separate from any game's, so what was played last cannot leak into how the
 * menu behaves. `menu.x` rather than `aim.x` because the grip adjustment only
 * touches axes it recognises as pointing — a menu highlight does not want a
 * player's pointing inversion applied to it twice.
 *
 * `b` is bound to `quit` here and in every game, so backing out is one habit
 * rather than a per-game convention.
 */
export const MENU_MAPPING: InputMapping = {
  buttons: { a: 'confirm', b: 'quit' },
  gestures: { swing: 'confirm' },
  axes: {
    'menu.x': { source: 'point.x', rangeDeg: TILT_RANGE_DEG, deadzoneDeg: TILT_DEADZONE_DEG },
  },
};
