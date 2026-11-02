/**
 * Angle helpers.
 *
 * Every one of these exists because angles wrap. Subtracting a calibration
 * offset from 179° and getting 359° instead of -1° is the kind of bug that only
 * shows up when a player happens to be facing the wrong way, which is to say: in
 * front of an audience.
 */

/** Wrap to (-180, 180]. */
export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Shortest signed distance from `a` to `b`, degrees. */
export function deltaDeg(a: number, b: number): number {
  return normalizeDeg(b - a);
}

/**
 * Interpolate the short way round the circle.
 * `t = 0` returns `a`, `t = 1` returns `b`.
 */
export function lerpDeg(a: number, b: number, t: number): number {
  return normalizeDeg(a + deltaDeg(a, b) * t);
}

/** Euclidean length of a 3-vector. */
export function magnitude(v: { x: number; y: number; z: number }): number {
  return Math.hypot(v.x, v.y, v.z);
}
