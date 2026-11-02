import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  QUAT_IDENTITY,
  quatAngleDeg,
  quatConjugate,
  quatFromEuler,
  quatMul,
  quatNormalize,
  quatRotate,
  quatSlerp,
  quatToEuler,
  isQuat,
} from '../dist/index.js';

const close = (a, b, tol = 1e-9) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (tol ${tol})`);

const closeVec = (a, b, tol = 1e-9) => {
  for (let i = 0; i < 3; i++) close(a[i], b[i], tol);
};

test('the identity quaternion rotates nothing', () => {
  closeVec(quatRotate(QUAT_IDENTITY, [1, 2, 3]), [1, 2, 3]);
  close(quatAngleDeg(QUAT_IDENTITY, QUAT_IDENTITY), 0);
});

test('quatFromEuler → quatToEuler round-trips inside the non-degenerate range', () => {
  // `beta` deliberately stays inside ±90: the Z-X'-Y'' extraction cannot
  // represent anything outside it, which is documented on quatToEuler and is the
  // exact degeneracy the quaternion exists to route around.
  for (const [a, b, g] of [
    [0, 0, 0],
    [30, 15, -20],
    [-170, -45, 80],
    [179, 89, -179],
    [45, -89, 45],
  ]) {
    const back = quatToEuler(quatFromEuler(a, b, g));
    close(back.a, a, 1e-6);
    close(back.b, b, 1e-6);
    close(back.g, g, 1e-6);
  }
});

test('a rotation composed with its own inverse is the identity', () => {
  const q = quatFromEuler(37, -22, 61);
  const back = quatMul(quatConjugate(q), q);
  close(quatAngleDeg(back, QUAT_IDENTITY), 0, 1e-9);
});

test('calibration expresses a pose relative to neutral, at any attitude', () => {
  // The property per-angle subtraction does NOT have, and the reason T1.7 is a
  // rewrite rather than a patch. Held upright — beta near 90 — subtracting Euler
  // angles is wrong; composing rotations is exact.
  const neutral = quatFromEuler(115, 87, -40);
  const relative = quatFromEuler(0, 0, 0);

  // Move to a pose that is `relative` away from neutral, then recover it.
  const current = quatMul(neutral, quatFromEuler(0, 12, 0));
  const recovered = quatMul(quatConjugate(neutral), current);

  // 1e-4 degrees, not 1e-9: four quaternion products at beta = 87° accumulate
  // ~1e-6° of float error. That is six orders of magnitude below anything a
  // sensor resolves, so the tolerance is describing arithmetic, not slack.
  close(quatAngleDeg(recovered, quatFromEuler(0, 12, 0)), 0, 1e-4);
  // Sanity: `relative` is not what we recovered, so the test can actually fail.
  assert.ok(quatAngleDeg(recovered, relative) > 1);
});

test('calibrating at the current pose yields exactly no rotation', () => {
  for (const pose of [
    [0, 0, 0],
    [90, 89, -90],
    [-30, -75, 160],
  ]) {
    const q = quatFromEuler(...pose);
    close(quatAngleDeg(quatMul(quatConjugate(q), q), QUAT_IDENTITY), 0, 1e-9);
  }
});

test('rotating about the pointing axis leaves the pointing vector alone', () => {
  // The property Euler angles could not offer: a player who rolls their wrist
  // must not drag the cursor sideways.
  const forward = [0, 0, -1];
  const roll = quatFromEuler(0, 0, 0);
  // A pure rotation about z, which is the forward axis up to sign.
  const s = Math.sin((50 * Math.PI) / 180 / 2);
  const c = Math.cos((50 * Math.PI) / 180 / 2);
  const aboutForward = [0, 0, s, c];

  closeVec(quatRotate(aboutForward, forward), forward, 1e-9);
  closeVec(quatRotate(roll, forward), forward, 1e-9);
});

test('slerp takes the short way round the double cover', () => {
  const a = quatFromEuler(0, 0, 0);
  const b = quatFromEuler(10, 0, 0);
  // `-b` is the same rotation as `b`. A naive slerp would sweep ~350° to reach it.
  const negB = [-b[0], -b[1], -b[2], -b[3]];

  const viaB = quatSlerp(a, b, 0.5);
  const viaNegB = quatSlerp(a, negB, 0.5);

  close(quatAngleDeg(viaB, viaNegB), 0, 1e-9);
  close(quatAngleDeg(a, viaB), 5, 1e-6);
});

test('slerp endpoints are exact and the midpoint bisects the angle', () => {
  const a = quatFromEuler(-40, 10, 0);
  const b = quatFromEuler(40, 10, 0);

  close(quatAngleDeg(quatSlerp(a, b, 0), a), 0, 1e-9);
  close(quatAngleDeg(quatSlerp(a, b, 1), b), 0, 1e-9);

  const mid = quatSlerp(a, b, 0.5);
  close(quatAngleDeg(a, mid), quatAngleDeg(mid, b), 1e-6);
});

test('slerp survives near-identical inputs without dividing by zero', () => {
  // The sin(theta) divisor goes to zero here; the normalized-lerp fallback is
  // what keeps this finite. A NaN would propagate silently into the render.
  const a = quatFromEuler(12, 34, 56);
  const b = quatFromEuler(12.000001, 34, 56);
  const mid = quatSlerp(a, b, 0.5);
  assert.ok(mid.every(Number.isFinite), 'slerp produced a non-finite component');
  close(quatAngleDeg(a, mid), 0, 1e-4);
});

test('quatNormalize rescues a non-unit quaternion and never divides by zero', () => {
  const scaled = quatNormalize([0, 0, 2, 2]);
  close(Math.hypot(...scaled), 1, 1e-12);
  assert.deepEqual(quatNormalize([0, 0, 0, 0]), QUAT_IDENTITY);
});

test('quatToEuler stays finite at the gimbal-locked poles', () => {
  // beta = ±90 is where alpha and gamma stop being independent. The extraction
  // cannot recover both, but it must not return NaN — a HUD reading NaN is a
  // worse failure than one reading a defensible number.
  for (const beta of [90, -90]) {
    const e = quatToEuler(quatFromEuler(30, beta, 20));
    assert.ok([e.a, e.b, e.g].every(Number.isFinite), `NaN at beta=${beta}`);
    // Loose on purpose. `beta` comes out of `asin`, whose derivative is
    // unbounded at ±1, so the last ulp of the sine becomes ~1e-3 degrees here.
    // That is a property of the extraction at the pole, not an error to fix —
    // and it is one more reason nothing downstream reads these angles.
    close(e.b, beta, 1e-2);
  }
});

test('isQuat rejects everything that is not four finite numbers', () => {
  assert.ok(isQuat([0, 0, 0, 1]));
  for (const bad of [null, undefined, [0, 0, 1], [0, 0, 0, 1, 0], [0, 0, 0, 'a'], [0, 0, 0, NaN], [0, 0, 0, Infinity], {}, 'q']) {
    assert.equal(isQuat(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});
