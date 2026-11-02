import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AudioDirector } from '../dist/index.js';

const POLICIES = {
  shoot: { gain: 0.4, minIntervalMs: 60, holdMs: 120, priority: 0 },
  explode: { gain: 0.9, holdMs: 400, priority: 1 },
  gameover: { gain: 1, holdMs: 900, priority: 9 },
};

const director = (over = {}) => new AudioDirector({ policies: POLICIES, ...over });

test('a cue with no policy still plays, on the defaults', () => {
  // The sound designer adding a game must not have to also register it in a
  // second table before anything comes out. Silence is the failure that looks
  // like nothing happened.
  const d = director();
  const voice = d.request('some.new.cue', 0);
  assert.ok(voice);
  assert.equal(voice.cue, 'some.new.cue');
  assert.equal(voice.gain, 1);
});

test('policy gain and caller scale both fold into the final gain', () => {
  const d = director({ volume: 0.5 });
  // 0.5 master x 0.4 policy x 0.5 caller.
  assert.equal(director({ volume: 0.5 }).request('shoot', 0).gain, 0.2);
  assert.equal(d.request('shoot', 0, 0.5).gain, 0.1);
});

test('gain is clamped into 0..1 rather than allowed to distort', () => {
  const d = director();
  // A caller scaling a full-gain cue up would otherwise hand the sink a value
  // above 1, which is not "louder" — it is clipped.
  assert.equal(d.request('gameover', 0, 4).gain, 1);
});

test('a repeat inside the throttle window is dropped, not queued', () => {
  // Star fighter's fire rate. A late duplicate of a percussive sound arrives
  // detached from the event that caused it, which is worse than no duplicate.
  const d = director();
  assert.ok(d.request('shoot', 0));
  assert.equal(d.request('shoot', 30), null);
  assert.equal(d.request('shoot', 59), null);
  assert.ok(d.request('shoot', 60));
  assert.equal(d.stats.throttled, 2);
});

test('the throttle is per cue, so one cue cannot mute another', () => {
  const d = director();
  assert.ok(d.request('shoot', 0));
  assert.ok(d.request('explode', 1));
  assert.ok(d.request('gameover', 2));
});

test('a dropped repeat does not extend its own window', () => {
  // If a rejected request refreshed `lastPlayed`, a caller firing faster than the
  // window would be throttled forever rather than down to the intended rate —
  // exactly the case a held trigger produces.
  const d = director();
  d.request('shoot', 0);
  for (let t = 1; t < 60; t += 5) d.request('shoot', t);
  assert.ok(d.request('shoot', 60), 'the window should have elapsed from the last *played* one');
});

test('voices free their slot once they have finished sounding', () => {
  const d = director({ maxVoices: 2 });
  assert.ok(d.request('explode', 0)); // holds 400 ms
  assert.ok(d.request('explode', 10));
  assert.equal(d.activeVoices(100), 2);
  assert.equal(d.activeVoices(500), 0);
});

test('the polyphony cap holds under a burst of equal-priority voices', () => {
  // A star fighter bomb clears a whole formation in one step. Thirty summed
  // explosions clip; the cap is what keeps a bomb sounding like a bomb.
  const d = director({ maxVoices: 4 });
  const played = [];
  for (let i = 0; i < 30; i++) if (d.request('explode', i)) played.push(i);
  assert.equal(played.length, 4);
  assert.equal(d.stats.dropped, 26);
});

test('a burst keeps the first voices rather than restarting on each new one', () => {
  // Equal priority must not evict equal priority, or thirty explosions become one
  // stutter instead of four overlapping booms.
  const d = director({ maxVoices: 3 });
  const played = [];
  for (let i = 0; i < 10; i++) if (d.request('explode', i)) played.push(i);
  assert.deepEqual(played, [0, 1, 2]);
});

test('a high-priority cue evicts a low one rather than being lost in a burst', () => {
  // The rule with teeth: the player must hear the round end even if the screen is
  // full of incidental noise at that moment.
  const d = director({ maxVoices: 3 });
  for (let i = 0; i < 3; i++) d.request('explode', i);
  assert.equal(d.activeVoices(3), 3);
  const over = d.request('gameover', 3);
  assert.ok(over, 'game over must survive a full mix');
  assert.equal(d.activeVoices(3), 3, 'and it should have taken a slot, not added one');
});

test('a low-priority cue cannot evict a high one', () => {
  const d = director({ maxVoices: 1 });
  assert.ok(d.request('gameover', 0));
  assert.equal(d.request('shoot', 1), null);
});

test('muting drops everything and is counted apart from mix drops', () => {
  const d = director();
  d.setMuted(true);
  assert.equal(d.request('explode', 0), null);
  assert.equal(d.stats.silenced, 1);
  assert.equal(d.stats.dropped, 0, 'silence is not a headroom problem');
  d.setMuted(false);
  assert.ok(d.request('explode', 1));
});

test('muting releases held slots instead of shrinking the budget on return', () => {
  // Nothing is still sounding once sound is off, so keeping the slots reserved
  // would drop voices for no reason in the first moments after unmuting.
  const d = director({ maxVoices: 2 });
  d.request('explode', 0);
  d.request('explode', 1);
  d.setMuted(true);
  d.setMuted(false);
  assert.equal(d.activeVoices(2), 0);
  assert.ok(d.request('explode', 2));
});

test('zero volume behaves as mute rather than as an inaudible voice', () => {
  const d = director({ volume: 0 });
  assert.equal(d.request('explode', 0), null);
  assert.equal(d.stats.silenced, 1);
});

test('volume and a non-finite value are both clamped into range', () => {
  const d = director();
  d.setVolume(4);
  assert.equal(d.volume, 1);
  d.setVolume(-2);
  assert.equal(d.volume, 0);
  d.setVolume(Number.NaN);
  assert.equal(d.volume, 0);
});

test('reset clears both the voices and the throttle windows', () => {
  // A scene teardown. A cue throttled just before a round ended must not still be
  // throttled when the next round begins.
  const d = director({ maxVoices: 1 });
  assert.ok(d.request('shoot', 0));
  d.reset();
  assert.equal(d.activeVoices(0), 0);
  assert.ok(d.request('shoot', 1), 'the window should not have survived the reset');
});

test('stats add up to every request made', () => {
  const d = director({ maxVoices: 1 });
  for (let i = 0; i < 5; i++) d.request('shoot', i);
  d.setMuted(true);
  d.request('shoot', 100);
  const { requested, played, throttled, dropped, silenced } = d.stats;
  assert.equal(requested, 6);
  assert.equal(played + throttled + dropped + silenced, requested);
});
