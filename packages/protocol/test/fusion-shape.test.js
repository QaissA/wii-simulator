/**
 * The shape of the smoothing curve, not its tuning.
 *
 * `SensorFusion` lives in `apps/controller`, which has no test setup, so what is
 * pinned here is the thing that must hold for any tuning of it: **the half-life
 * has to fall as the phone turns faster.** A fixed half-life is why the first
 * device session could report "laggy" and "jittery" in the same breath — one
 * knob, two complaints, pulling opposite ways.
 *
 * The blend is reproduced from `sensor-fusion.ts` rather than imported. That is
 * a real duplication and worth the cost: the alternative is either a test setup
 * in an app that has none, or moving a filter into the protocol package purely
 * to test it, which would put controller policy in the shared contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FUSION_FAST_DEG_PER_S,
  FUSION_HALF_LIFE_FAST_MS,
  FUSION_HALF_LIFE_REST_MS,
} from '../dist/index.js';

/** The blend in `SensorFusion.update`. */
const halfLifeFor = (degPerSec) => {
  const fast = Math.min(1, degPerSec / FUSION_FAST_DEG_PER_S);
  return FUSION_HALF_LIFE_REST_MS + (FUSION_HALF_LIFE_FAST_MS - FUSION_HALF_LIFE_REST_MS) * fast;
};

/** Fraction of a new reading taken in one step — what the half-life buys. */
const responseAt = (degPerSec, dtMs = 16.7) => 1 - Math.pow(2, -dtMs / halfLifeFor(degPerSec));

test('smoothing relaxes as the phone turns faster', () => {
  const still = halfLifeFor(0);
  const aiming = halfLifeFor(FUSION_FAST_DEG_PER_S / 2);
  const slashing = halfLifeFor(FUSION_FAST_DEG_PER_S * 3);

  assert.ok(still > aiming, 'a still phone must be smoothed harder than a moving one');
  assert.ok(aiming > slashing, 'a fast motion must be smoothed least');
  assert.equal(slashing, FUSION_HALF_LIFE_FAST_MS, 'past the crossover it saturates');
});

test('a held-still cursor is smoothed hard enough to hide sensor noise', () => {
  // Under ~15% of a noisy reading per frame: jitter averages out across frames
  // instead of being tracked. This is the number that decides whether a cursor
  // sitting on a target shimmers.
  assert.ok(responseAt(0) < 0.15, `still response was ${responseAt(0)}`);
});

test('a fast motion is barely smoothed at all', () => {
  // Over half the new reading per frame, so the filter contributes well under a
  // frame of lag where the eye is actually tracking the hand.
  const fast = responseAt(FUSION_FAST_DEG_PER_S * 2);
  assert.ok(fast > 0.5, `fast response was ${fast}`);
});

test('the two ends differ enough to be worth the mechanism', () => {
  // If rest and fast were close the adaptive path would be complexity for
  // nothing — it would smooth the same either way and both complaints survive.
  assert.ok(
    responseAt(FUSION_FAST_DEG_PER_S * 2) / responseAt(0) > 4,
    'the fast end must respond several times harder than the still end',
  );
});

test('the blend is continuous, so speed changes cannot pop', () => {
  // A discontinuity here is visible: the cursor would jump as a motion crossed
  // the threshold, which reads as a tracking fault rather than a filter.
  let previous = halfLifeFor(0);
  for (let speed = 1; speed <= FUSION_FAST_DEG_PER_S * 1.5; speed += 1) {
    const current = halfLifeFor(speed);
    assert.ok(current <= previous + 1e-9, 'half-life must decrease monotonically');
    assert.ok(previous - current < 5, 'no step in the blend may be abrupt');
    previous = current;
  }
});
