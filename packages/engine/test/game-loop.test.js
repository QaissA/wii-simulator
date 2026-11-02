import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GameLoop } from '../dist/index.js';

function makeLoop(options = {}) {
  const updates = [];
  const renders = [];
  const loop = new GameLoop({
    stepHz: 60,
    update: (dt, simTime) => updates.push({ dt, simTime }),
    render: (alpha) => renders.push(alpha),
    ...options,
  });
  return { loop, updates, renders };
}

test('the first tick only establishes a baseline', () => {
  const { loop, updates } = makeLoop();
  const r = loop.tick(1000);
  assert.equal(r.steps, 0);
  assert.deepEqual(updates, [], 'nothing to measure from yet, so nothing to simulate');
});

test('the simulation step is constant regardless of frame pacing', () => {
  const { loop, updates } = makeLoop();
  loop.tick(0);
  // Wildly irregular frames — a 144 Hz display, then a hitch, then 30 Hz.
  for (const t of [7, 14, 21, 60, 93, 126]) loop.tick(t);

  assert.ok(updates.length > 0);
  const step = 1 / 60;
  for (const u of updates) {
    assert.ok(Math.abs(u.dt - step) < 1e-9, 'every update must get exactly one step');
  }
});

test('elapsed time converts to the right number of steps', () => {
  const { loop, updates } = makeLoop();
  loop.tick(0);
  // 105 ms at 16.667 ms/step = 6 steps with ~5 ms left over. Deliberately not
  // 100 ms: six steps come to 100.00000000000001, so an exact-boundary duration
  // yields 5 or 6 depending on float rounding and asserts nothing useful.
  loop.tick(105);
  assert.equal(updates.length, 6);
  assert.ok(loop.pendingMs < loop.stepMs);
  assert.ok(Math.abs(loop.pendingMs - 5) < 0.001);
});

test('leftover time carries into the next frame instead of being lost', () => {
  const { loop } = makeLoop();
  loop.tick(0);
  loop.tick(10); // under one step — no simulation yet
  assert.equal(loop.totalSteps, 0);
  loop.tick(20); // 20 ms total now exceeds one step
  assert.equal(loop.totalSteps, 1, 'the remainder must accumulate, not reset');
});

test('alpha stays in [0,1) and tracks the remainder', () => {
  const { loop, renders } = makeLoop();
  loop.tick(0);
  for (const t of [8, 17, 25, 40, 55, 70]) {
    const r = loop.tick(t);
    assert.ok(r.alpha >= 0 && r.alpha < 1, `alpha out of range: ${r.alpha}`);
    assert.ok(Math.abs(r.alpha - loop.pendingMs / loop.stepMs) < 1e-9);
  }
  assert.equal(renders.length, 6, 'render runs once per tick, not once per step');
});

test('a long stall is dropped rather than simulated — no spiral of death', () => {
  const { loop, updates } = makeLoop({ maxFrameMs: 83 });
  loop.tick(0);

  // Ten seconds vanish: a backgrounded tab, or a closed laptop lid.
  const r = loop.tick(10_000);

  assert.equal(r.steps, 4, '83 ms clamp yields 4 steps, not 600');
  assert.ok(r.droppedMs > 9900, 'the rest is discarded and reported');
  assert.equal(updates.length, 4);
  // Simulation time deliberately falls behind wall-clock: nobody wants ten
  // seconds of physics fast-forwarded on resume.
  assert.ok(loop.simTimeMs < 100);
});

test('resume() skips the invisible gap without losing simulation state', () => {
  const { loop } = makeLoop();
  loop.tick(0);
  loop.tick(100);
  const stepsBefore = loop.totalSteps;
  const simBefore = loop.simTimeMs;

  loop.resume(); // tab became visible again
  const r = loop.tick(60_000);

  assert.equal(r.steps, 0, 'the first tick after resume re-baselines');
  assert.equal(loop.totalSteps, stepsBefore, 'no catch-up storm');
  assert.equal(loop.simTimeMs, simBefore, 'simulation state is preserved');
});

test('time never runs backwards', () => {
  const { loop } = makeLoop();
  loop.tick(1000);
  const r = loop.tick(500); // a clock that jumped backwards
  assert.equal(r.steps, 0);
  assert.ok(r.droppedMs >= 0);
});

test('the same elapsed time yields the same steps whatever the frame rate', () => {
  // Determinism is the whole reason for a fixed step: a 144 Hz machine and a
  // 30 Hz machine must simulate identically over the same wall-clock second.
  const fast = makeLoop();
  const slow = makeLoop();

  // Both must cover exactly the same wall-clock span, so each ends on 1000.
  fast.loop.tick(0);
  for (let t = 7; t < 1000; t += 7) fast.loop.tick(t);
  fast.loop.tick(1000);

  slow.loop.tick(0);
  for (let t = 33; t < 1000; t += 33) slow.loop.tick(t);
  slow.loop.tick(1000);

  assert.equal(fast.loop.totalSteps, slow.loop.totalSteps);
  assert.equal(fast.loop.simTimeMs, slow.loop.simTimeMs);
});

test('reset clears everything', () => {
  const { loop } = makeLoop();
  loop.tick(0);
  loop.tick(200);
  assert.ok(loop.totalSteps > 0);

  loop.reset();
  assert.equal(loop.totalSteps, 0);
  assert.equal(loop.simTimeMs, 0);
  assert.equal(loop.pendingMs, 0);
});
