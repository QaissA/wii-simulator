/**
 * T1.8 — directional gestures, tested where they can be tested.
 *
 * `GestureRecognizer` lives in `apps/controller`, which has no test setup, and
 * the classifier is the part worth pinning rather than the plumbing. So the
 * classification rule is reproduced here against the real constants, alongside
 * the `InputAdapter` half — the `swing:left` → `swing` fallback — which *is*
 * directly testable and is what stops direction breaking every existing mapping.
 *
 * The plan is explicit that this wants recorded traces before the thresholds are
 * touched (§Outstanding item 2: *"T1.8 needs them more than T1.3 did, because
 * directional classification has four outcomes to confuse instead of two"*).
 * These tests pin the **rules**, not the tuning: what must stay true whatever
 * `GESTURE_MIN_DOMINANCE` ends up being.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GESTURE_MIN_DOMINANCE, GESTURE_ONSET_FRACTION, SWING_THRESHOLD } from '@wii/protocol';
import { InputAdapter } from '../dist/index.js';

/** `#classify` from `apps/controller/src/modules/gesture-recognizer.ts`. */
function classify(v, minDominance = GESTURE_MIN_DOMINANCE) {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const major = Math.max(ax, ay);
  const minor = Math.min(ax, ay);
  if (major < 1e-6) return { direction: null, dominance: 0 };
  const dominance = minor < 1e-6 ? Infinity : major / minor;
  if (dominance < minDominance) return { direction: null, dominance };
  return {
    direction: ax >= ay ? (v.x > 0 ? 'right' : 'left') : v.y > 0 ? 'up' : 'down',
    dominance,
  };
}

test('the four cardinal flicks classify as themselves', () => {
  assert.equal(classify({ x: 20, y: 1, z: 0 }).direction, 'right');
  assert.equal(classify({ x: -20, y: 1, z: 0 }).direction, 'left');
  assert.equal(classify({ x: 1, y: 20, z: 0 }).direction, 'up');
  assert.equal(classify({ x: 1, y: -20, z: 0 }).direction, 'down');
});

test('a diagonal flick reports no direction rather than guessing', () => {
  // The failure this prevents is a lane change the player did not ask for,
  // which is indistinguishable from a bug.
  assert.equal(classify({ x: 14, y: 14, z: 0 }).direction, null);
  assert.equal(classify({ x: -13, y: 12, z: 0 }).direction, null);
});

test('z is ignored, so a flick that is mostly toward the screen still resolves', () => {
  // A wrist rotates about the forearm, so almost every real flick carries some
  // z. Letting it compete would make "toward me" a fifth outcome nobody asked
  // for, and would suppress directions that are perfectly clear on screen.
  assert.equal(classify({ x: 18, y: 1, z: 40 }).direction, 'right');
});

test('a pure-z flick has no direction and does not divide by zero', () => {
  const { direction, dominance } = classify({ x: 0, y: 0, z: 30 });
  assert.equal(direction, null);
  assert.ok(Number.isFinite(dominance), 'dominance must not be NaN or Infinity here');
});

test('a perfectly axis-aligned flick is maximally dominant, not NaN', () => {
  const { direction, dominance } = classify({ x: 25, y: 0, z: 0 });
  assert.equal(direction, 'right');
  assert.equal(dominance, Infinity);
});

test('the onset fraction sits below the threshold and above the noise floor', () => {
  // The whole point of sampling direction on the way up: it must fire before the
  // peak, or it catches the deceleration and reports the flick backwards.
  assert.ok(GESTURE_ONSET_FRACTION > 0 && GESTURE_ONSET_FRACTION < 1);
  assert.ok(
    SWING_THRESHOLD * GESTURE_ONSET_FRACTION > 3,
    'the onset must sit above ordinary hand tremor',
  );
});

/* ------------------------------------------------- the InputAdapter half */

const collect = (adapter) => {
  const events = [];
  adapter.onAction((e) => events.push(e));
  return events;
};

test('a directional gesture matches its specific binding', () => {
  const adapter = new InputAdapter({ gestures: { 'swing:left': 'laneLeft', swing: 'generic' } });
  const events = collect(adapter);

  adapter.apply({ type: 'gesture', name: 'swing:left', recvTs: 5 });

  assert.deepEqual(
    events.map((e) => e.action),
    ['laneLeft'],
    'the specific binding must win over the base name',
  );
});

test('a directional gesture falls back to the base name', () => {
  // The compatibility guarantee. Flappy maps `swing` and knows nothing about
  // direction, but a T1.8 controller now sends `swing:left`. It must still flap.
  const adapter = new InputAdapter({ gestures: { swing: 'flap' } });
  const events = collect(adapter);

  adapter.apply({ type: 'gesture', name: 'swing:left', recvTs: 1 });
  adapter.apply({ type: 'gesture', name: 'swing:up', recvTs: 2 });
  adapter.apply({ type: 'gesture', name: 'swing', recvTs: 3 });

  assert.deepEqual(
    events.map((e) => e.action),
    ['flap', 'flap', 'flap'],
    'every form must reach the same action',
  );
});

test('an unmapped gesture stays unmapped, colon or not', () => {
  const adapter = new InputAdapter({ gestures: { swing: 'flap' } });
  const events = collect(adapter);

  adapter.apply({ type: 'gesture', name: 'shake:left', recvTs: 1 });

  assert.deepEqual(events, [], 'a base name with no binding must not fire anything');
});

test('a game can bind directions without inheriting the generic swing', () => {
  // The endless runner's case (T3.9): four bindings, and a diagonal flick — which
  // arrives as plain `swing` — must do nothing rather than pick a lane.
  const adapter = new InputAdapter({
    gestures: {
      'swing:left': 'laneLeft',
      'swing:right': 'laneRight',
      'swing:up': 'jump',
      'swing:down': 'duck',
    },
  });
  const events = collect(adapter);

  adapter.apply({ type: 'gesture', name: 'swing:right', recvTs: 1 });
  adapter.apply({ type: 'gesture', name: 'swing', recvTs: 2 });

  assert.deepEqual(
    events.map((e) => e.action),
    ['laneRight'],
    'an unclassifiable flick must not pick a lane',
  );
});
