/**
 * Grip resolution — the tests that would have caught the shipped defect.
 *
 * The existing pointing tests assert that each grip reads **dead centre at its
 * own calibration pose**, which is true and was true throughout: a bug in the
 * forward axis cannot move a vector that has not been rotated yet. What none of
 * them asserted is **which physical motion drives which axis**, and that is
 * exactly where the flat grip was broken — aiming did nothing, and wrist roll
 * drove the horizontal axis backwards.
 *
 * So every test here moves the phone and asks where the cursor went.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  quatConjugate,
  quatFromEuler,
  quatMul,
  quatNormalize,
  quatRotate,
  resolveForward,
  resolveGrip,
  quatFromBasis,
} from '../dist/index.js';

const RAD = 180 / Math.PI;
const DEFAULT_FORWARD = [0, 0, -1];

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/**
 * `pointingDeg` from `packages/engine/src/input-adapter.ts`, with the default
 * forward. Mirrored rather than imported because protocol must not depend on
 * engine — and because the claim under test is precisely that the *default*
 * works once the frame is canonical.
 */
function pointing(q) {
  const f = DEFAULT_FORWARD;
  const right = cross(f, [0, 1, 0]);
  const up = cross(right, f);
  const p = quatRotate(q, f);
  return {
    x: Math.atan2(dot(p, right), dot(p, f)) * RAD,
    y: Math.asin(Math.max(-1, Math.min(1, dot(p, up)))) * RAD,
  };
}

/** What `Calibrator` does: relative rotation, re-expressed in the grip's frame. */
function calibrated(qNeutral, qCurrent) {
  const basis = resolveGrip(qNeutral);
  const relative = quatMul(quatConjugate(qNeutral), quatNormalize(qCurrent));
  return quatMul(quatMul(quatConjugate(basis), relative), basis);
}

/**
 * Motions expressed in the **world** frame, not as Euler deltas.
 *
 * This distinction is the whole subject of T1.7 and it caught two drafts of this
 * file. `gamma + 25` is a wrist roll when the phone is flat and a *yaw* when it
 * is upright — at `beta = 90`, `alpha` and `gamma` both turn about the world
 * vertical. Testing with Euler deltas therefore asks a different question of
 * each grip, which is precisely the confusion the quaternion work removed.
 *
 * A world-frame rotation asks the same question everywhere: turn the phone right
 * about the vertical, tip it up about the horizontal, spin it about the axis it
 * is aimed along. `q` maps device → earth, so an earth-frame rotation composes
 * on the left.
 */
const aimRight = quatFromEuler(-25, 0, 0); // about earth up
const aimUp = quatFromEuler(0, 25, 0); // about earth east
const rollOnly = quatFromEuler(0, 0, 25); // about earth north — the aiming axis

/** Apply a world-frame rotation to a pose. */
const after = (neutral, world) => quatMul(world, neutral);

/**
 * The poses, as quaternions rather than Euler triples — for the same reason.
 *
 * The second draft wrote landscape as `[0, 90, 90]` and it aimed **west**, so
 * "tip it up about earth east" was a roll for that pose alone and the test
 * failed against correct code. Building it as *upright, rolled 90° about the
 * axis it aims along* says what was meant and keeps all three aiming north.
 */
const UPRIGHT = quatFromEuler(0, 90, 0); // screen toward the player, back to the display
const FLAT = quatFromEuler(0, 0, 0); // screen up, top edge aimed away
const LANDSCAPE = after(UPRIGHT, quatFromEuler(0, 0, 90)); // upright, turned on its side

for (const [name, neutral] of [
  ['upright (screen toward the player)', UPRIGHT],
  ['flat (held like a Wii remote)', FLAT],
  ['landscape (upright, rolled 90°)', LANDSCAPE],
]) {
  test(`${name}: the calibration pose reads dead centre`, () => {
    const p = pointing(calibrated(neutral, neutral));
    assert.ok(Math.abs(p.x) < 1e-9, `x should be 0, got ${p.x}`);
    assert.ok(Math.abs(p.y) < 1e-9, `y should be 0, got ${p.y}`);
  });

  test(`${name}: aiming right moves the cursor right`, () => {
    const p = pointing(calibrated(neutral, after(neutral, aimRight)));
    assert.ok(p.x > 20, `aiming right must drive x positive, got ${p.x}`);
    assert.ok(Math.abs(p.y) < 5, `aiming right must not move y, got ${p.y}`);
  });

  test(`${name}: aiming up moves the cursor up`, () => {
    const p = pointing(calibrated(neutral, after(neutral, aimUp)));
    assert.ok(p.y > 20, `aiming up must drive y positive, got ${p.y}`);
    assert.ok(Math.abs(p.x) < 5, `aiming up must not move x, got ${p.x}`);
  });

  test(`${name}: rolling about the aiming axis moves nothing`, () => {
    // The T1.7 claim, and the one the flat grip violated worst: a rotation about
    // the axis the phone is aimed along cannot move where it is aimed.
    const p = pointing(calibrated(neutral, after(neutral, rollOnly)));
    assert.ok(Math.abs(p.x) < 1e-6, `roll must not move x, got ${p.x}`);
    assert.ok(Math.abs(p.y) < 1e-6, `roll must not move y, got ${p.y}`);
  });
}

test('the grip is read off the calibration pose, not assumed', () => {
  // The whole defect in one assertion: these two poses must not resolve to the
  // same forward axis, and the flat one must not resolve to the old default.
  assert.deepEqual(resolveForward(UPRIGHT), [0, 0, -1]);
  assert.deepEqual(resolveForward(FLAT), [0, 1, 0]);
  // Landscape still aims out of the back — turning the phone on its side changes
  // which device axis is "up", not which one is aimed at the display.
  assert.deepEqual(resolveForward(LANDSCAPE), [0, 0, -1]);
});

test('a phone lying flat resolves the flat grip, not the historical default', () => {
  // An identity neutral IS a flat phone, so it resolves `+y` and produces a
  // basis that is deliberately not identity.
  //
  // `Calibrator` still passes frames through untouched until someone taps
  // Calibrate — it holds its basis at identity rather than consulting this — so
  // the offline harnesses, which never calibrate, are unaffected. That is a
  // property of the caller, not of this function.
  const basis = resolveGrip(quatFromEuler(0, 0, 0));
  assert.deepEqual(resolveForward(quatFromEuler(0, 0, 0)), [0, 1, 0]);
  assert.ok(
    Math.abs(basis[3] - 1) > 1e-6,
    'a flat neutral must re-base, or the flat grip is still broken',
  );
});

test('a phone aimed straight down still resolves a usable frame', () => {
  // Nobody calibrates like this on purpose, but a phone set face-up on a table
  // mid-session must not produce NaN — one NaN axis propagates silently all the
  // way into the render.
  for (const pose of [
    [0, 0, 0],
    [0, 90, 0],
    [0, -90, 0],
    [45, 45, 45],
    [180, 89.9, -179],
  ]) {
    const basis = resolveGrip(quatFromEuler(...pose));
    for (const c of basis) assert.ok(Number.isFinite(c), `basis must be finite at ${pose}`);
  }
});

test('quatFromBasis survives a 180° rotation', () => {
  // The trace-only formula divides by zero here and yields NaN. Shepperd's
  // branch choice is the reason this is a test and not an outage.
  const q = quatFromBasis([-1, 0, 0], [0, -1, 0], [0, 0, 1]);
  for (const c of q) assert.ok(Number.isFinite(c), 'a 180° basis must not produce NaN');
  const v = quatRotate(q, [1, 0, 0]);
  assert.ok(Math.abs(v[0] + 1) < 1e-9, 'the rotation must actually be by 180°');
});
