/**
 * Swept collision against a pointer path.
 *
 * `docs/implementation-plan.md` §Phase 3c is explicit that nothing should be
 * abstracted out of the games until a third one reveals what actually wants
 * sharing: *"the second and third games are what reveal what actually wants to
 * be shared, and anything abstracted before then is a guess."*
 *
 * Fruit slash (T3.8) is that third game, and what it revealed is this: **a
 * pointing game collides a path, not a position.** Where the phone points is
 * sampled at the simulation rate, and between two samples a flick of the wrist
 * crosses several object-widths. Testing the sample points alone misses exactly
 * the fastest, most deliberate strokes — the ones a player is most confident
 * they landed.
 *
 * So it lives here rather than in one game: tennis (T3.10) swings a racket
 * through a ball, bowling releases along an arc, and both ask the same question.
 * It is also pure, total and renderer-agnostic, which is the standing argument
 * for `packages/engine` — the parts where mistakes are expensive are the parts
 * that should be testable without a browser.
 */

/**
 * Distance from a point to the nearest point on a line **segment**.
 *
 * Two details, both of which are silent when wrong:
 *
 * 1. **The degenerate segment.** When both endpoints coincide the projection
 *    divides by zero and every distance comes back `NaN`. `NaN` compares false
 *    against any threshold, so collision does not error — it simply stops
 *    happening, which reads as a dead blade rather than a maths fault. A still
 *    hand produces exactly this case.
 * 2. **The clamp.** Without it this measures against the infinite line through
 *    the segment, so a short stroke registers against objects it stopped well
 *    short of — a slice that visibly missed still scores.
 */
export function segmentPointDistance(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  px: number,
  py: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared === 0) return Math.hypot(px - x0, py - y0);

  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lengthSquared));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

/**
 * Did the swept segment touch this circle?
 *
 * The predicate games actually call. Kept alongside the distance function rather
 * than inlined at each call site so the `<=` is decided once: a stroke that
 * grazes a collider exactly on its edge should count, because the alternative is
 * a player who watched the blade cross a fruit and score nothing.
 */
export function segmentIntersectsCircle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  radius: number,
): boolean {
  return segmentPointDistance(x0, y0, x1, y1, cx, cy) <= radius;
}
