import { test } from 'node:test';
import assert from 'node:assert/strict';

import { segmentPointDistance, segmentIntersectsCircle } from '../dist/index.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

test('distance to a point beside the segment is the perpendicular one', () => {
  // Segment along x from 0 to 10, point 3 above its middle.
  close(segmentPointDistance(0, 0, 10, 0, 5, 3), 3);
  close(segmentPointDistance(0, 0, 10, 0, 5, -3), 3);
});

test('a point beyond an endpoint measures to the endpoint, not the line', () => {
  // The clamp. Measured against the infinite line this would read 0, and a
  // stroke that stopped at x=10 would slice something at x=20.
  close(segmentPointDistance(0, 0, 10, 0, 20, 0), 10);
  close(segmentPointDistance(0, 0, 10, 0, -6, 0), 6);
  // Off the end *and* off to the side — the hypotenuse to the endpoint.
  close(segmentPointDistance(0, 0, 10, 0, 13, 4), 5);
});

test('a degenerate segment is a point, never NaN', () => {
  // A still hand produces this every step. NaN compares false against any
  // threshold, so the failure would be a blade that silently stops cutting
  // rather than anything that looks like an error.
  const d = segmentPointDistance(4, 4, 4, 4, 7, 8);
  assert.ok(Number.isFinite(d), 'degenerate segment produced a non-finite distance');
  close(d, 5);
});

test('a point on the segment reads zero', () => {
  close(segmentPointDistance(-2, -2, 6, 6, 3, 3), 0);
});

test('a fast stroke slices a collider it jumped clean over', () => {
  // The reason this is swept and not a point test. At 60 Hz a flick moves far
  // more than a fruit-width per step; both endpoints are well clear of the
  // circle, and the path still goes straight through it.
  const [x0, y0, x1, y1] = [-6, 0, 6, 0];
  const radius = 0.52;

  assert.ok(Math.hypot(x0, 0) > radius, 'endpoint must be clear, or this proves nothing');
  assert.ok(Math.hypot(x1, 0) > radius, 'endpoint must be clear, or this proves nothing');
  assert.ok(segmentIntersectsCircle(x0, y0, x1, y1, 0, 0, radius));
});

test('a stroke that passes nearby but wide does not slice', () => {
  assert.equal(segmentIntersectsCircle(-6, 1.4, 6, 1.4, 0, 0, 0.52), false);
});

test('grazing exactly on the edge counts as a hit', () => {
  // Decided once, here, rather than at each call site: a player who watched the
  // blade cross a fruit and scored nothing reads it as the game being broken.
  assert.ok(segmentIntersectsCircle(-5, 0.52, 5, 0.52, 0, 0, 0.52));
});

test('a stroke stopping short of a collider does not slice it', () => {
  // Same direction, same line — only the length differs. Without the clamp in
  // segmentPointDistance this passes when it must not.
  assert.ok(segmentIntersectsCircle(-6, 0, 6, 0, 3, 0, 0.5), 'a long stroke reaches it');
  assert.equal(
    segmentIntersectsCircle(-6, 0, -1, 0, 3, 0, 0.5),
    false,
    'a stroke ending at x=-1 must not reach a collider at x=3',
  );
});
