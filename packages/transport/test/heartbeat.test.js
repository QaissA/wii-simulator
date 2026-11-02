import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Heartbeat } from '../dist/index.js';

/** Manual clock + timer, so liveness logic is tested without real waiting. */
function harness({ intervalMs = 1000, timeoutMs = 3000 } = {}) {
  let now = 0;
  let tick = null;
  const sent = [];
  let timedOut = 0;

  const hb = new Heartbeat({
    send: () => sent.push(now),
    onTimeout: () => timedOut++,
    intervalMs,
    timeoutMs,
    now: () => now,
    setIntervalFn: (fn) => {
      tick = fn;
      return 'handle';
    },
    clearIntervalFn: () => {
      tick = null;
    },
  });

  return {
    hb,
    get sent() {
      return sent;
    },
    get timedOut() {
      return timedOut;
    },
    get running() {
      return tick !== null;
    },
    advance(ms) {
      now += ms;
      tick?.();
    },
    setNow(v) {
      now = v;
    },
  };
}

test('pings immediately on start so the first RTT sample lands early', () => {
  const h = harness();
  h.hb.start();
  assert.equal(h.sent.length, 1, 'should not wait a full interval for the first ping');
});

test('keeps pinging while traffic keeps arriving', () => {
  const h = harness({ intervalMs: 1000, timeoutMs: 3000 });
  h.hb.start();

  for (let i = 0; i < 5; i++) {
    h.advance(1000);
    h.hb.noteTraffic();
  }

  assert.equal(h.sent.length, 6, '1 on start + 5 interval pings');
  assert.equal(h.timedOut, 0);
  assert.ok(h.running);
});

test('times out after the silence window and stops', () => {
  const h = harness({ intervalMs: 1000, timeoutMs: 3000 });
  h.hb.start();

  h.advance(1000); // 1s silent — still fine
  h.advance(1000); // 2s
  assert.equal(h.timedOut, 0);

  h.advance(1000); // 3s silent — at the limit
  assert.equal(h.timedOut, 1, 'should fire once the window is reached');
  assert.equal(h.running, false, 'must stop itself so it cannot fire again');
});

test('fires onTimeout exactly once, never stacking reconnects', () => {
  const h = harness({ intervalMs: 1000, timeoutMs: 2000 });
  h.hb.start();
  h.advance(1000);
  h.advance(1000);
  assert.equal(h.timedOut, 1);

  // Even if a stray tick arrives after the stop, it must not re-fire.
  h.advance(1000);
  h.advance(1000);
  assert.equal(h.timedOut, 1);
});

test('any inbound traffic resets the window, not just pongs', () => {
  const h = harness({ intervalMs: 1000, timeoutMs: 2500 });
  h.hb.start();

  h.advance(1000);
  h.hb.noteTraffic(); // a state frame counts as proof of life
  h.advance(1000);
  h.advance(1000);

  assert.equal(h.timedOut, 0, 'traffic at t=1000 should have pushed the deadline out');
});

test('restarting clears a previous timeout', () => {
  const h = harness({ intervalMs: 1000, timeoutMs: 2000 });
  h.hb.start();
  h.advance(1000);
  h.advance(1000);
  assert.equal(h.timedOut, 1);

  h.hb.start();
  assert.ok(h.running, 'a restart must arm the timer again');
  h.advance(1000);
  assert.equal(h.timedOut, 1, 'the fresh window has not elapsed yet');
});
