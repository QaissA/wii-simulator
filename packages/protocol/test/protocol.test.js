import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encode,
  decode,
  tryDecode,
  validate,
  stamp,
  channelFor,
  isValidRoomCode,
  generateRoomCode,
  ROOM_CODE_LENGTH,
  ClockSync,
  SEND_HZ,
  SEND_INTERVAL_MS,
  PROTOCOL_VERSION,
} from '../dist/index.js';

/** One of each message type, matching docs/00-overview.md verbatim where possible. */
const samples = {
  state: {
    type: 'state',
    t: 12345,
    // Already unit-length, so the codec's normalize-on-arrival is a no-op here
    // and the round-trip stays an exact deepEqual.
    q: [0, 0, 0, 1],
    o: { a: 0, b: -12.5, g: 3.25 },
    acc: { x: 0, y: 9.81, z: -0.5 },
    rot: { a: 0, b: 0, g: 0 },
    btn: ['a'],
    room: '7QK2',
  },
  button: { type: 'button', name: 'a', down: true, room: '7QK2' },
  gesture: { type: 'gesture', name: 'swing', room: '7QK2' },
  join: { type: 'join', room: '7QK2' },
  ping: { type: 'ping', t: 999 },
  pong: { type: 'pong', t: 999, serverT: 1042 },
};

test('every message type survives a codec round trip', () => {
  for (const [name, msg] of Object.entries(samples)) {
    assert.deepEqual(decode(encode(msg)), msg, `${name} did not round-trip`);
  }
});

test('an unpaired state frame round-trips without gaining a room field', () => {
  const local = { ...samples.state };
  delete local.room;
  const out = decode(encode(local));
  assert.deepEqual(out, local);
  assert.ok(!('room' in out), 'room must stay absent, not become undefined');
});

test('only continuous state goes on the unreliable channel', () => {
  assert.equal(channelFor(samples.state), 'unreliable');
  for (const name of ['button', 'gesture', 'join', 'ping', 'pong']) {
    assert.equal(channelFor(samples[name]), 'reliable', `${name} must be reliable`);
  }
});

test('malformed input decodes to null rather than throwing', () => {
  const bad = [
    'not json at all',
    '{"type":"nope"}',
    '{"type":"state"}',
    JSON.stringify({ ...samples.state, t: 'soon' }),
    JSON.stringify({ ...samples.state, o: { a: 0, b: 0 } }),
    JSON.stringify({ ...samples.state, btn: [1, 2] }),
    JSON.stringify({ ...samples.button, down: 'yes' }),
    JSON.stringify({ ...samples.gesture, room: 'lowercase' }),
    JSON.stringify({ type: 'join' }),
  ];
  for (const raw of bad) {
    assert.equal(tryDecode(raw), null, `should have rejected: ${raw}`);
  }
});

test('non-finite numbers are rejected', () => {
  // JSON turns NaN/Infinity into null, so this is what actually arrives.
  assert.equal(validate({ ...samples.ping, t: null }), null);
  assert.equal(validate({ ...samples.ping, t: NaN }), null);
  assert.equal(validate({ ...samples.ping, t: Infinity }), null);
});

test('room codes exclude ambiguous glyphs', () => {
  assert.ok(isValidRoomCode('7QK2'));
  assert.ok(!isValidRoomCode('7qk2'), 'must be case sensitive');
  assert.ok(!isValidRoomCode('7QK'), 'wrong length');
  assert.ok(!isValidRoomCode('IO01'), 'I, O, 0, 1 are excluded by design');
  assert.ok(!isValidRoomCode(null));
});

test('stamp attaches delivery metadata without disturbing the payload', () => {
  const delivered = stamp(samples.state, 5000, 12);
  assert.equal(delivered.recvTs, 5000);
  assert.equal(delivered.latencyMs, 12);
  assert.equal(delivered.t, samples.state.t);
  assert.deepEqual(delivered.o, samples.state.o);
});

test('ClockSync recovers a known offset', () => {
  // Remote clock runs 1000 ms ahead; each leg takes 10 ms.
  let localNow = 0;
  const sync = new ClockSync({ now: () => localNow });

  const ping = sync.createPing();          // sent at local 0
  localNow = 20;                            // pong arrives at local 20 → rtt 20
  const rtt = sync.acceptPong({ type: 'pong', t: ping.t, serverT: 1010 }, localNow);

  assert.equal(rtt, 20);
  assert.equal(sync.rttMs, 20);
  assert.equal(sync.latencyMs, 10);
  assert.equal(sync.offsetMs, -1000);
  assert.ok(sync.synced);
  // The pong left the remote at its 1010, which was local time 10.
  assert.equal(sync.toLocal(1010), 10);
});

test('ClockSync prefers the least-congested sample', () => {
  let localNow = 0;
  const sync = new ClockSync({ now: () => localNow });

  // A badly delayed sample first...
  sync.acceptPong({ type: 'pong', t: 0, serverT: 500 }, (localNow = 400));
  assert.equal(sync.rttMs, 400);
  // ...then a clean one. Min-RTT wins; the spike must not linger in an average.
  sync.acceptPong({ type: 'pong', t: 400, serverT: 410 }, (localNow = 410));
  assert.equal(sync.rttMs, 10);
});

test('ClockSync ignores impossible pongs and resets cleanly', () => {
  const sync = new ClockSync({ now: () => 100 });
  assert.equal(sync.acceptPong({ type: 'pong', t: 500, serverT: 500 }, 100), null);
  assert.equal(sync.synced, false);
  assert.equal(sync.latencyMs, null);
  // Unsynced conversion is a pass-through, so callers work from frame one.
  assert.equal(sync.toLocal(42), 42);

  sync.acceptPong({ type: 'pong', t: 80, serverT: 90 }, 100);
  assert.ok(sync.synced);
  sync.reset();
  assert.equal(sync.synced, false);
});

test('send rate constants agree', () => {
  assert.equal(SEND_HZ, 50);
  assert.equal(SEND_INTERVAL_MS, 20);
  assert.equal(PROTOCOL_VERSION, 2);
});

test('generateRoomCode produces codes the validator accepts', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateRoomCode();
    assert.equal(code.length, ROOM_CODE_LENGTH);
    assert.ok(isValidRoomCode(code), `generated an invalid code: ${code}`);
  }
});

test('generateRoomCode never emits the look-alike characters', () => {
  // The alphabet excludes I/O/0/1 on purpose — codes are read aloud across a
  // room and typed on a phone keyboard. A generator that ignored the alphabet
  // would produce codes that display fine and can never be typed in.
  const seen = new Set();
  for (let i = 0; i < 500; i++) for (const ch of generateRoomCode()) seen.add(ch);
  for (const ch of 'IO01') assert.ok(!seen.has(ch), `emitted look-alike ${ch}`);
});

test('generateRoomCode is not constant', () => {
  const codes = new Set(Array.from({ length: 50 }, () => generateRoomCode()));
  assert.ok(codes.size > 40, `only ${codes.size} distinct codes in 50 draws`);
});

test('toRemote is the exact inverse of toLocal', () => {
  // Frame age across two devices only works if a sender can express a capture
  // time in the reference clock and the receiver can bring it back. If these two
  // are not inverses, the display reports a latency that is really clock skew.
  const clock = new ClockSync();
  const offset = 4000; // remote clock runs 4 s ahead of ours
  const sent = 1000;
  clock.acceptPong({ type: 'pong', t: sent, serverT: sent + offset + 10 }, sent + 20);

  const local = 12_345;
  assert.equal(clock.toLocal(clock.toRemote(local)), local);
  assert.ok(clock.toRemote(local) > local, 'remote clock is ahead, so remote ts must be larger');
});

test('toRemote passes through before sync, matching toLocal', () => {
  const clock = new ClockSync();
  assert.equal(clock.toRemote(999), 999);
  assert.equal(clock.toLocal(999), 999);
});
