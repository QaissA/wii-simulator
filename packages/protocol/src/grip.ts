/**
 * Grip resolution — which way the phone is actually aimed, decided from the
 * calibration pose rather than assumed.
 *
 * ## The defect this exists to fix
 *
 * T1.7 made "where is the phone pointing" the question every pointing game
 * asks, and `AxisBinding.forward` the knob that says which device axis does the
 * aiming. The plan then said a grip is data: *"a phone held flat and aimed away
 * like a Wii remote points along its own `+y`, so that grip is
 * `forward: [0, 1, 0]` in a mapping literal."*
 *
 * **No mapping ever set it.** Every game took `DEFAULT_FORWARD` — `-z`, out of
 * the back of the phone — which is right only for a phone held upright with its
 * screen toward the player. Held flat like a Wii remote, `-z` points at the
 * floor, and the floor is parallel to the axis a player yaws about. The
 * consequences were exactly what the first hardware session reported:
 *
 *   - **Aiming left/right did nothing.** Yaw rotates about the world vertical,
 *     and in that grip `-z` *is* the world vertical, so the pointing vector was
 *     being rotated about itself. The horizontal axis read a flat zero.
 *   - **Rolling the wrist moved the cursor sideways, backwards.** Roll about the
 *     axis actually aimed at the screen swings `-z` through the horizontal, so
 *     the one motion that should be invariant was the only one driving the axis.
 *
 * The vertical axis worked throughout, which is what made it read as "half the
 * tracking is broken" rather than as a grip assumption.
 *
 * ## Why this is resolved here and not in a mapping literal
 *
 * Hardcoding `forward: [0, 1, 0]` in each mapping would fix the flat grip and
 * break the upright one. The grip is a property of **how this player is holding
 * this phone right now**, which is knowable exactly once: at calibration, when
 * they are holding it the way they intend to play.
 *
 * So the neutral quaternion answers it. `q_neutral` maps device → earth, so
 * rotating earth-up back through its conjugate says where "up" lies in device
 * coordinates — and the device axis most nearly *perpendicular* to that is the
 * one aimed out at the screen.
 *
 * ## What the caller gets back
 *
 * A single basis quaternion. `Calibrator` conjugates the calibrated rotation by
 * it, which re-expresses every frame in one **canonical pointing frame** where
 * `right` is `+x`, `up` is `+y` and `forward` is `-z` — precisely
 * `DEFAULT_FORWARD` and the axes `pointingFrame()` derives from it.
 *
 * That is what keeps the fix invisible upward: no mapping changes, no protocol
 * change, no game touched. `DEFAULT_FORWARD` stops being an assumption about the
 * player and becomes a statement about the frame the wire already carries.
 *
 * A second bug falls out for free. `right` and `up` are built from **world up at
 * the neutral pose**, not from the device's own `+x`/`+y`, so a phone calibrated
 * in landscape no longer delivers its axes swapped.
 */

import type { Quat, Vec3Tuple } from './quat.js';
import { quatConjugate, quatFromBasis, quatRotate } from './quat.js';

/** Earth-frame up, in the `+x` east / `+y` north / `+z` up convention. */
const EARTH_UP: Vec3Tuple = [0, 0, 1];

/**
 * The grips worth telling apart, in preference order.
 *
 * Only two, deliberately. These are the ways people actually pick a phone up to
 * aim it at a screen, they are the two the plan names, and a longer list would
 * be guessing at grips nobody has held. The order breaks ties: at 45° between
 * the two, `-z` wins, which is the historical default and therefore the less
 * surprising answer.
 *
 * They are orthogonal, which is what makes the choice safe — see `resolveGrip`.
 */
const CANDIDATES: readonly Vec3Tuple[] = [
  [0, 0, -1], // out of the back — phone upright, screen toward the player
  [0, 1, 0], // out of the top edge — phone flat, held like a Wii remote
];

const dot = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function normalize(v: Vec3Tuple): Vec3Tuple {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n === 0 ? [0, 0, -1] : [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * Which device axis this player is aiming with, at the pose they calibrated in.
 *
 * Exported for the HUD and for tests: it is the one part of the resolution a
 * human can sanity-check by looking at their own hand.
 */
export function resolveForward(qNeutral: Quat): Vec3Tuple {
  const upDevice = quatRotate(quatConjugate(qNeutral), EARTH_UP);

  // Most horizontal wins — an axis aimed at the screen is perpendicular to up.
  let best = CANDIDATES[0]!;
  let bestVertical = Infinity;
  for (const f of CANDIDATES) {
    const vertical = Math.abs(dot(f, upDevice));
    // Strict `<` is what makes the array order the tie-break.
    if (vertical < bestVertical - 1e-9) {
      bestVertical = vertical;
      best = f;
    }
  }
  return best;
}

/**
 * The rotation taking canonical pointing coordinates into device coordinates.
 *
 * Compose as `conj(basis) · q_relative · basis` to move a calibrated rotation
 * into the canonical frame. That is a similarity transform — a change of basis,
 * not an extra rotation — so it cannot introduce deflection of its own, and at
 * the calibration pose the result stays exactly identity.
 */
export function resolveGrip(qNeutral: Quat): Quat {
  const forward = resolveForward(qNeutral);
  const upDevice = quatRotate(quatConjugate(qNeutral), EARTH_UP);

  // `forward` was chosen as the *more* horizontal of two orthogonal axes, so it
  // can never be more than 45° from horizontal and this cross product can never
  // collapse. Two orthogonal vectors cannot both be parallel to up.
  const right = normalize(cross(forward, upDevice));
  const up = cross(right, forward);

  // Canonical forward is `-z`, so the third basis column is `-forward`.
  return quatFromBasis(right, up, [-forward[0], -forward[1], -forward[2]]);
}
