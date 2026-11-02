/**
 * Quaternion orientation — the representation `StateFrame.o` should have used.
 *
 * Plan ref: T1.7. Every axis problem seen on hardware traced back to one choice,
 * not to a tuning error:
 *
 *   - Calibrating by subtracting Euler angles is not composing rotations, so it
 *     is only valid near the pose it was captured in.
 *   - `alpha` and `gamma` couple as `beta` approaches ±90°, which is exactly
 *     where a phone sits when it is held upright. Leaning left/right then shows
 *     up in `alpha` while a `gamma`-driven axis reads a flat zero — an axis that
 *     looks broken rather than mis-mapped.
 *   - No mapping table can undo that, which is why the display's `X`/`Y`/`S`
 *     keys could never fix it.
 *
 * Quaternions have none of those properties: composition is multiplication,
 * there is no degenerate attitude, and interpolation is well defined everywhere.
 *
 * ## Conventions, stated because they are the whole contract
 *
 * **Layout** is `[x, y, z, w]` — vector part first, scalar last. This matches
 * Three.js and WebXR. Getting it backwards produces rotations that look almost
 * right, so it is fixed here rather than left to each caller.
 *
 * **Device frame** is the W3C one: `+x` right across the screen, `+y` up the
 * screen, `+z` out of the screen toward the viewer.
 *
 * **Earth frame** is `+x` east, `+y` north, `+z` up.
 *
 * A quaternion here rotates a vector **from the device frame into the earth
 * frame**, matching `deviceorientation`'s own definition:
 * `R = Rz(alpha) · Rx(beta) · Ry(gamma)`, intrinsic Z-X'-Y''.
 */

/** Unit quaternion, `[x, y, z, w]`. */
export type Quat = readonly [number, number, number, number];

/** A 3-vector as a tuple, for the pointing math. */
export type Vec3Tuple = readonly [number, number, number];

/** No rotation. */
export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Hamilton product — `a` then `b` applied to a vector reads `mul(b, a)`. */
export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/**
 * Inverse of a **unit** quaternion — the conjugate.
 *
 * Named `conjugate` rather than `inverse` on purpose: for a non-unit quaternion
 * the two differ by a division by the squared norm, and silently returning the
 * conjugate for one would be wrong. Everything this module produces is
 * normalized, so the distinction never bites, but the name says which is assumed.
 */
export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n === 0) return QUAT_IDENTITY;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

/**
 * Build a quaternion from `deviceorientation`'s three angles, degrees.
 *
 * Composed from the three axis rotations rather than transcribed as a closed
 * form. The closed form is a dozen sign-bearing terms that cannot be checked by
 * reading them; this version is the spec's `Rz · Rx · Ry` written out, and the
 * round-trip test pins it.
 */
export function quatFromEuler(alphaDeg: number, betaDeg: number, gammaDeg: number): Quat {
  const ha = (alphaDeg * DEG) / 2;
  const hb = (betaDeg * DEG) / 2;
  const hg = (gammaDeg * DEG) / 2;

  const qz: Quat = [0, 0, Math.sin(ha), Math.cos(ha)];
  const qx: Quat = [Math.sin(hb), 0, 0, Math.cos(hb)];
  const qy: Quat = [0, Math.sin(hg), 0, Math.cos(hg)];

  return quatMul(quatMul(qz, qx), qy);
}

/**
 * Rotate a vector by a unit quaternion: `q · v · q*`.
 *
 * Uses the cross-product form, which is the usual one — it costs fewer
 * multiplies than expanding to a matrix and avoids materialising one.
 */
export function quatRotate(q: Quat, v: Vec3Tuple): Vec3Tuple {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;

  // t = 2 * (q_vec × v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);

  // v' = v + qw * t + q_vec × t
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * Spherical interpolation, `t = 0` → `a`, `t = 1` → `b`.
 *
 * Two details that are easy to omit and both visible in the hand:
 *
 * 1. **The double cover.** `q` and `-q` are the same rotation, so a raw slerp
 *    can take the 350° route where a 10° one exists. Flipping `b` when the dot
 *    product is negative always takes the short way.
 * 2. **The near-parallel case.** As the angle goes to zero the `sin` divisor
 *    goes with it. Below the threshold this falls back to a normalized lerp,
 *    which is accurate to well under a pixel there and never divides by ~0.
 */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let cos = quatDot(a, b);

  let end: Quat = b;
  if (cos < 0) {
    end = [-b[0], -b[1], -b[2], -b[3]];
    cos = -cos;
  }

  if (cos > 0.9995) {
    return quatNormalize([
      a[0] + (end[0] - a[0]) * t,
      a[1] + (end[1] - a[1]) * t,
      a[2] + (end[2] - a[2]) * t,
      a[3] + (end[3] - a[3]) * t,
    ]);
  }

  const theta = Math.acos(Math.min(1, cos));
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;

  return quatNormalize([
    a[0] * wa + end[0] * wb,
    a[1] * wa + end[1] * wb,
    a[2] * wa + end[2] * wb,
    a[3] * wa + end[3] * wb,
  ]);
}

/** Angle between two orientations, degrees. Always in [0, 180]. */
export function quatAngleDeg(a: Quat, b: Quat): number {
  const cos = Math.min(1, Math.abs(quatDot(a, b)));
  return 2 * Math.acos(cos) * RAD;
}

/**
 * Back to `deviceorientation`'s angles, degrees — the inverse of `quatFromEuler`.
 *
 * This exists for the debug HUD and for `StateFrame.o`, **not** for anything
 * that has to be correct at every attitude. The Z-X'-Y'' extraction pins `beta`
 * to [-90, 90] and loses the `alpha`/`gamma` distinction entirely at the poles —
 * which is the degeneracy T1.7 exists to route around. Games read the
 * quaternion; only humans read these.
 */
export function quatToEuler(q: Quat): { a: number; b: number; g: number } {
  const [x, y, z, w] = quatNormalize(q);

  // Rows of R = Rz(alpha) · Rx(beta) · Ry(gamma), which is what `q` encodes.
  const r01 = 2 * (x * y - z * w);
  const r11 = 1 - 2 * (x * x + z * z);
  const r20 = 2 * (x * z - y * w);
  const r21 = 2 * (y * z + x * w);
  const r22 = 1 - 2 * (x * x + y * y);
  const r02 = 2 * (x * z + y * w);
  const r00 = 1 - 2 * (y * y + z * z);

  const sinBeta = Math.max(-1, Math.min(1, r21));
  const beta = Math.asin(sinBeta);

  // Gimbal lock: cos(beta) ≈ 0, so alpha and gamma describe the same rotation
  // and only their sum is observable. Attribute all of it to alpha and pin gamma
  // at 0, which keeps the result continuous instead of letting both terms swing.
  if (Math.abs(Math.cos(beta)) < 1e-6) {
    return { a: Math.atan2(r02, r00) * RAD, b: beta * RAD, g: 0 };
  }

  return {
    a: Math.atan2(-r01, r11) * RAD,
    b: beta * RAD,
    g: Math.atan2(-r20, r22) * RAD,
  };
}

/** True when every component is finite — the check `validate` needs. */
export function isQuat(v: unknown): v is Quat {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/**
 * Build a quaternion from an orthonormal basis given as its three columns.
 *
 * `bx`, `by`, `bz` are where the canonical `+x`, `+y`, `+z` axes land — so the
 * result rotates a vector *from* the basis's frame *into* the frame those
 * columns are expressed in. `resolveGrip` is the caller that matters.
 *
 * Shepperd's method: pick the branch whose divisor is largest. The naive
 * trace-only formula divides by `sqrt(trace + 1)`, which goes to zero for any
 * 180° rotation and produces NaN for a basis that is perfectly valid. Choosing
 * the branch off the largest diagonal term keeps every divisor comfortably away
 * from zero at every attitude — the same "no degenerate case" property that made
 * quaternions the right representation in the first place.
 */
export function quatFromBasis(bx: Vec3Tuple, by: Vec3Tuple, bz: Vec3Tuple): Quat {
  const [m00, m10, m20] = bx;
  const [m01, m11, m21] = by;
  const [m02, m12, m22] = bz;

  const trace = m00 + m11 + m22;

  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return quatNormalize([(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]);
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return quatNormalize([s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]);
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return quatNormalize([(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]);
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return quatNormalize([(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]);
}
