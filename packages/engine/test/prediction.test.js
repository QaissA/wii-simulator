import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Predictor, PredictiveAxis, Smoother } from '../dist/index.js';

test('a smoother starts at its first sample rather than at zero', () => {
  const s = new Smoother(40);
  // Seeding from zero would make every axis sweep in from centre on connect.
  assert.equal(s.push(10, 0), 10);
});

test('smoothing converges toward a held value', () => {
  const s = new Smoother(40);
  s.push(0, 0);
  let v = 0;
  for (let t = 20; t <= 400; t += 20) v = s.push(100, t);
  assert.ok(v > 99, `should have converged, got ${v}`);
});

test('one half-life absorbs half the change', () => {
  const s = new Smoother(50);
  s.push(0, 0);
  const v = s.push(100, 50);
  assert.ok(Math.abs(v - 50) < 0.001, `expected ~50, got ${v}`);
});

test('smoothing strength does not depend on sample rate', () => {
  // A fixed alpha would smooth twice as hard at 100 Hz as at 50 Hz; expressing
  // it as a half-life is what makes these agree.
  const slow = new Smoother(40);
  const fast = new Smoother(40);

  slow.push(0, 0);
  for (let t = 20; t <= 200; t += 20) slow.push(100, t);

  fast.push(0, 0);
  for (let t = 5; t <= 200; t += 5) fast.push(100, t);

  assert.ok(Math.abs(slow.value - fast.value) < 1, 'rates must converge alike');
});

test('a predictor extrapolates along constant velocity', () => {
  const p = new Predictor({ maxExtrapolationMs: 100, velocityHalfLifeMs: 1 });
  // 1 unit/ms.
  for (let t = 0; t <= 200; t += 20) p.push(t, t);

  assert.ok(Math.abs(p.velocityPerSecond - 1000) < 50, `got ${p.velocityPerSecond}`);
  const predicted = p.valueAt(250); // 50 ms past the last sample at value 200
  assert.ok(Math.abs(predicted - 250) < 10, `expected ~250, got ${predicted}`);
});

test('extrapolation is capped so a direction change cannot fling the cursor', () => {
  const p = new Predictor({ maxExtrapolationMs: 60, velocityHalfLifeMs: 1 });
  for (let t = 0; t <= 100; t += 20) p.push(t, t);

  // A five-second gap must not extrapolate five seconds forward.
  const wild = p.valueAt(5000);
  assert.ok(wild <= 100 + 60 * 1.05, `capped prediction expected, got ${wild}`);
});

test('a predictor with no samples is neutral rather than NaN', () => {
  const p = new Predictor();
  assert.equal(p.hasSample, false);
  assert.equal(p.valueAt(1000), 0);
  assert.ok(Number.isFinite(p.velocityPerSecond));
});

test('a stationary signal predicts no movement', () => {
  const p = new Predictor({ velocityHalfLifeMs: 10 });
  for (let t = 0; t <= 300; t += 20) p.push(42, t);
  assert.ok(Math.abs(p.valueAt(340) - 42) < 0.5, 'a still hand must not drift');
});

test('angular prediction crosses ±180 without unwinding the long way', () => {
  const p = new Predictor({ angular: true, maxExtrapolationMs: 100, velocityHalfLifeMs: 1 });
  // Rotating past 180: 170 → 175 → 180 → -175 …
  p.push(170, 0);
  p.push(175, 20);
  p.push(-180, 40);
  p.push(-175, 60);

  const next = p.valueAt(80);
  // Should continue to about -170, not swing back toward +170.
  assert.ok(next < 0 || next > 170, `unexpected wrap handling: ${next}`);
  assert.ok(next >= -180 && next <= 180, 'output must stay normalized');
});

test('repeated or out-of-order timestamps do not produce infinities', () => {
  const p = new Predictor();
  p.push(10, 100);
  p.push(20, 100); // same timestamp — a zero dt would divide by zero
  p.push(30, 50); // out of order
  assert.ok(Number.isFinite(p.valueAt(200)));
  assert.ok(Number.isFinite(p.velocityPerSecond));
});

test('PredictiveAxis smooths noise before measuring velocity', () => {
  // Raw prediction over a noisy signal amplifies the noise; the combined axis
  // must stay near the underlying value instead.
  const noisy = new PredictiveAxis({ smoothingHalfLifeMs: 40, velocityHalfLifeMs: 60 });
  let seed = 1;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };

  for (let t = 0; t <= 600; t += 20) noisy.push(50 + rand() * 6, t);

  const v = noisy.valueAt(620);
  assert.ok(Math.abs(v - 50) < 5, `noise should be damped, got ${v}`);
});

test('reset returns an axis to neutral', () => {
  const axis = new PredictiveAxis();
  for (let t = 0; t <= 100; t += 20) axis.push(t, t);
  axis.reset();
  assert.equal(axis.valueAt(500), 0);
});
