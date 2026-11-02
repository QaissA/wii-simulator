import { test } from 'node:test';
import assert from 'node:assert/strict';

import { quatFromEuler } from '@wii/protocol';

import { InputAdapter, applyBinding } from '../dist/index.js';

/** A game supplies exactly this and nothing else — the data-driven claim. */
const tennis = {
  buttons: { a: 'swing', b: 'lob' },
  gestures: { swing: 'swing', shake: 'taunt' },
  axes: {
    'aim.x': { source: 'gamma', rangeDeg: 45, deadzoneDeg: 2 },
    'aim.y': { source: 'beta', rangeDeg: 45, invert: true },
  },
};

const state = (o, btn = [], recvTs = 100) => ({
  type: 'state',
  t: recvTs,
  // Derived from `o` the way the controller derives `o` from `q`, so the two
  // orientation fields on a test frame describe the same rotation. A test frame
  // whose fields disagreed could pass an assertion no real frame could satisfy.
  q: quatFromEuler(o.a, o.b, o.g),
  o,
  acc: { x: 0, y: 0, z: 0 },
  rot: { a: 0, b: 0, g: 0 },
  btn,
  recvTs,
  latencyMs: 10,
});

/** An `applyBinding` argument built from a partial Euler pose. */
const orientation = (partial) => {
  const o = { a: 0, b: 0, g: 0, ...partial };
  return { q: quatFromEuler(o.a, o.b, o.g), o };
};

function collect(adapter) {
  const events = [];
  adapter.onAction((e) => events.push(e));
  return events;
}

test('a button maps to its abstract action, emitting edges only', () => {
  const adapter = new InputAdapter(tennis);
  const events = collect(adapter);

  adapter.apply({ type: 'button', name: 'a', down: true, recvTs: 1 });
  adapter.apply({ type: 'button', name: 'a', down: true, recvTs: 2 }); // repeat
  adapter.apply({ type: 'button', name: 'a', down: false, recvTs: 3 });

  assert.deepEqual(
    events.map((e) => [e.action, e.phase]),
    [
      ['swing', 'started'],
      ['swing', 'ended'],
    ],
    'a repeated down must not re-fire started',
  );
});

test('a gesture is a one-shot with no matching end', () => {
  const adapter = new InputAdapter(tennis);
  const events = collect(adapter);

  adapter.apply({ type: 'gesture', name: 'swing', recvTs: 5 });

  assert.deepEqual(events, [{ action: 'swing', phase: 'triggered', t: 5 }]);
  assert.equal(adapter.isActive('swing'), false, 'one-shots are never held');
});

test('unmapped inputs are ignored rather than throwing', () => {
  const adapter = new InputAdapter(tennis);
  const events = collect(adapter);

  adapter.apply({ type: 'button', name: 'zzz', down: true, recvTs: 1 });
  adapter.apply({ type: 'gesture', name: 'cartwheel', recvTs: 2 });
  adapter.apply({ type: 'join', room: '7QK2', recvTs: 3 });
  adapter.apply({ type: 'ping', t: 1, recvTs: 4 });

  assert.deepEqual(events, []);
});

test('orientation drives named axes, normalized and clamped', () => {
  const adapter = new InputAdapter(tennis);

  adapter.apply(state({ a: 0, b: 0, g: 45 }));
  assert.equal(Math.round(adapter.axis('aim.x') * 100) / 100, 1, 'full range reads 1');

  adapter.apply(state({ a: 0, b: 0, g: 900 }));
  assert.equal(adapter.axis('aim.x'), 1, 'beyond range clamps rather than overshooting');

  adapter.apply(state({ a: 0, b: 45, g: 0 }));
  assert.equal(adapter.axis('aim.y'), -1, 'invert flips the sign');

  assert.equal(adapter.axis('nope'), 0, 'unknown axes read 0, not undefined');
});

test('a deadzone suppresses resting drift without losing full travel', () => {
  const binding = { source: 'gamma', rangeDeg: 45, deadzoneDeg: 5 };

  assert.equal(applyBinding(orientation({ g: 3 }), binding), 0, 'inside the deadzone reads 0');
  assert.equal(applyBinding(orientation({ g: -3 }), binding), 0);
  // The key property: the axis still reaches ±1 at full range despite the
  // deadzone eating the first 5°.
  assert.equal(applyBinding(orientation({ g: 45 }), binding), 1);
  assert.equal(applyBinding(orientation({ g: -45 }), binding), -1);

  const justOutside = applyBinding(orientation({ g: 6 }), binding);
  assert.ok(justOutside > 0 && justOutside < 0.1, 'just past the deadzone starts near zero');
});

test('an alpha axis stays continuous across the ±180 wrap', () => {
  const binding = { source: 'alpha', rangeDeg: 180 };
  // 179 and -179 are 2° apart, so their axis values must be close — not opposite.
  const a = applyBinding(orientation({ a: 179 }), binding);
  const b = applyBinding(orientation({ a: -179 }), binding);
  assert.ok(Math.abs(a - 1) < 0.02);
  assert.ok(Math.abs(b + 1) < 0.02);
});

test('held state is reconciled from the authoritative btn list', () => {
  const adapter = new InputAdapter(tennis);
  const events = collect(adapter);

  // A reconnecting client never saw the `down` — the state frame is the truth.
  adapter.apply(state({ a: 0, b: 0, g: 0 }, ['a']));
  assert.ok(adapter.isActive('swing'), 'missed press is recovered from btn');
  assert.deepEqual(events.map((e) => e.phase), ['started']);

  // Likewise a lost `up`.
  adapter.apply(state({ a: 0, b: 0, g: 0 }, []));
  assert.equal(adapter.isActive('swing'), false, 'missed release is recovered too');
  assert.deepEqual(events.map((e) => e.phase), ['started', 'ended']);
});

test('reconciliation does not disturb gesture-triggered actions', () => {
  const adapter = new InputAdapter(tennis);
  adapter.apply({ type: 'gesture', name: 'shake', recvTs: 1 });
  // `taunt` comes from a gesture and can never appear in `btn`; a state frame
  // must not try to "correct" it.
  assert.doesNotThrow(() => adapter.apply(state({ a: 0, b: 0, g: 0 }, [])));
  assert.equal(adapter.isActive('taunt'), false);
});

test('swapping the mapping releases held actions rather than stranding them', () => {
  const adapter = new InputAdapter(tennis);
  const events = collect(adapter);

  adapter.apply({ type: 'button', name: 'a', down: true, recvTs: 1 });
  assert.ok(adapter.isActive('swing'));

  const bowling = { buttons: { a: 'release' }, gestures: { swing: 'roll' } };
  adapter.setMapping(bowling, 9);

  assert.equal(adapter.isActive('swing'), false, 'the old action must not stay stuck');
  assert.deepEqual(events.at(-1), { action: 'swing', phase: 'ended', t: 9 });

  // And the new mapping is live — the same wire button now means something else.
  adapter.apply({ type: 'button', name: 'a', down: true, recvTs: 10 });
  assert.ok(adapter.isActive('release'));
});

test('a new game needs only a new mapping literal', () => {
  // The whole point of the seam: same adapter, same wire messages, no netcode.
  const bowling = {
    gestures: { swing: 'roll' },
    axes: { 'lane.x': { source: 'gamma', rangeDeg: 30 } },
  };
  const adapter = new InputAdapter(bowling);
  const events = collect(adapter);

  adapter.apply({ type: 'gesture', name: 'swing', recvTs: 1 });
  adapter.apply(state({ a: 0, b: 0, g: 15 }));

  assert.deepEqual(events.map((e) => e.action), ['roll']);
  assert.equal(adapter.axis('lane.x'), 0.5);
});

test('reset clears held actions and axes', () => {
  const adapter = new InputAdapter(tennis);
  adapter.apply(state({ a: 0, b: 0, g: 45 }, ['a']));
  assert.ok(adapter.isActive('swing'));
  assert.equal(adapter.axis('aim.x'), 1);

  adapter.reset();
  assert.deepEqual(adapter.activeActions, []);
  assert.equal(adapter.axis('aim.x'), 0);
});

/* --------------------------- pointing axes (T1.7) -------------------------- */

/**
 * The pointing sources are what the games are built on, so these pin the
 * properties the Euler bindings could not offer — not just "a number comes out".
 */

const pointing = {
  axes: {
    'aim.x': { source: 'point.x', rangeDeg: 40 },
    'aim.y': { source: 'point.y', rangeDeg: 40 },
  },
};

/** A frame carrying `q` directly, bypassing the Euler helper. */
const qState = (q, recvTs = 100) => ({
  type: 'state',
  t: recvTs,
  q,
  o: { a: 0, b: 0, g: 0 },
  acc: { x: 0, y: 0, z: 0 },
  rot: { a: 0, b: 0, g: 0 },
  btn: [],
  recvTs,
  latencyMs: 10,
});

/** Quaternion for a rotation of `deg` about a unit axis. */
const aboutAxis = ([x, y, z], deg) => {
  const h = ((deg * Math.PI) / 180) / 2;
  const s = Math.sin(h);
  return [x * s, y * s, z * s, Math.cos(h)];
};

test('at the calibrated pose both pointing axes read dead centre', () => {
  // Not a rounding accident: calibration makes the relative rotation the
  // identity, so the forward vector is exactly `forward` and both angles are
  // exactly zero. A cursor that starts off-centre after calibrating means the
  // calibration did not compose.
  const adapter = new InputAdapter(pointing);
  adapter.apply(qState([0, 0, 0, 1]));
  assert.equal(adapter.axis('aim.x'), 0);
  assert.equal(adapter.axis('aim.y'), 0);
});

test('aiming right is positive x, aiming up is positive y', () => {
  const adapter = new InputAdapter(pointing);

  // Turning the phone to aim right is a negative rotation about device +y
  // (right-hand rule about the screen-up axis turns you left).
  adapter.apply(qState(aboutAxis([0, 1, 0], -20)));
  assert.ok(adapter.axis('aim.x') > 0, 'aiming right must move the cursor right');
  assert.equal(adapter.axis('aim.y'), 0, 'a pure yaw must not move the vertical axis');

  // Tipping to aim up is a positive rotation about device +x.
  adapter.apply(qState(aboutAxis([1, 0, 0], 20)));
  assert.ok(adapter.axis('aim.y') > 0, 'aiming up must move the cursor up');
  assert.equal(adapter.axis('aim.x'), 0, 'a pure pitch must not move the horizontal axis');
});

test('the axis reaches exactly ±1 at the binding range', () => {
  const adapter = new InputAdapter(pointing);
  adapter.apply(qState(aboutAxis([0, 1, 0], -40)));
  assert.ok(Math.abs(adapter.axis('aim.x') - 1) < 1e-9);

  adapter.apply(qState(aboutAxis([0, 1, 0], 60)));
  assert.equal(adapter.axis('aim.x'), -1, 'past range clamps rather than wrapping');
});

test('rolling the wrist does not drag the cursor', () => {
  // The headline property. On Euler bindings a roll near beta ±90 moved the
  // horizontal axis; here rotation about the pointing axis is a no-op by
  // construction, which is what lets a slice stay where it was aimed.
  const adapter = new InputAdapter(pointing);

  for (const deg of [15, 45, 90, 179]) {
    adapter.apply(qState(aboutAxis([0, 0, 1], deg)));
    assert.equal(adapter.axis('aim.x'), 0, `roll ${deg}° moved aim.x`);
    assert.equal(adapter.axis('aim.y'), 0, `roll ${deg}° moved aim.y`);
  }
});

test('the same wrist motion reads the same after an arbitrary roll', () => {
  // "The same wrist motion should move it the same distance whether the phone is
  // held flat or upright" — the plan's own acceptance criterion for T1.7.
  const adapter = new InputAdapter(pointing);

  adapter.apply(qState(aboutAxis([1, 0, 0], 20)));
  const upright = adapter.axis('aim.y');

  // Roll first, then pitch by the same amount *in the rolled frame*.
  const rolled = aboutAxis([0, 0, 1], 70);
  const pitchInRolledFrame = quatMulLocal(rolled, aboutAxis([1, 0, 0], 20));
  adapter.apply(qState(pitchInRolledFrame));

  // The vector has moved the same angular distance off centre; it now lies on a
  // different screen axis, so compare the total deflection.
  const x = adapter.axis('aim.x');
  const y = adapter.axis('aim.y');

  // Within 1%, not exactly. Azimuth and elevation decompose the direction the
  // way longitude and latitude do, so a fixed angular step covers slightly more
  // azimuth away from centre — here 20.05° of apparent deflection for a true
  // 20°. That is spherical geometry, not drift: it is bounded, it is under a
  // quarter of a percent inside this binding's ±40°, and it is far below what a
  // hand can hold steady.
  const deflection = Math.hypot(x, y);
  assert.ok(
    Math.abs(deflection - Math.abs(upright)) < 0.01,
    `deflection changed with roll: ${deflection} vs ${Math.abs(upright)}`,
  );
});

test('a flat, Wii-remote grip is a mapping literal, not a code change', () => {
  // The seam's claim, applied to grip: a phone aimed along its own +y needs a
  // different `forward`, and nothing else.
  const flat = {
    axes: { 'aim.y': { source: 'point.y', rangeDeg: 40, forward: [0, 1, 0] } },
  };
  const adapter = new InputAdapter(flat);

  adapter.apply(qState([0, 0, 0, 1]));
  assert.equal(adapter.axis('aim.y'), 0, 'centred at the calibrated pose');

  // Rotating about +y is now the pointing axis, so it must not deflect.
  adapter.apply(qState(aboutAxis([0, 1, 0], 30)));
  assert.ok(Math.abs(adapter.axis('aim.y')) < 1e-12, 'roll about the flat grip forward must be a no-op');

  // And pitching away from that grip's forward does deflect, so the axis is
  // live rather than merely stuck at zero.
  // For a phone lying flat and aimed along +y, "up" is out of the screen (+z),
  // so a positive rotation about device +x lifts the nose. That this differs
  // from the screen-facing grip's sign is the point: each grip's forward brings
  // its own screen frame with it, and neither needs an inversion.
  adapter.apply(qState(aboutAxis([1, 0, 0], 20)));
  assert.ok(adapter.axis('aim.y') > 0.4, 'the flat grip must still track pitch');
});

test('a non-unit forward vector cannot produce NaN', () => {
  // `asin` out of domain would send a silent NaN all the way into the render.
  const adapter = new InputAdapter({
    axes: { 'aim.y': { source: 'point.y', rangeDeg: 40, forward: [0, 0, -3] } },
  });
  adapter.apply(qState(aboutAxis([1, 0, 0], 20)));
  assert.ok(Number.isFinite(adapter.axis('aim.y')));
  assert.ok(adapter.axis('aim.y') > 0);
});

test('swapping between an angle mapping and a pointing mapping recomputes axes', () => {
  const adapter = new InputAdapter(tennis);
  adapter.apply(state({ a: 0, b: 0, g: 20 }));
  assert.ok(adapter.axis('aim.x') > 0);

  adapter.setMapping(pointing);
  // The frame is still the last one seen; the pointing axes must be derived from
  // its `q` rather than left at whatever the angle mapping produced.
  assert.equal(adapter.axis('aim.y'), 0);
  assert.ok(Number.isFinite(adapter.axis('aim.x')));
});

/** Hamilton product, local-frame composition — `a` then `b` in a's frame. */
function quatMulLocal(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
