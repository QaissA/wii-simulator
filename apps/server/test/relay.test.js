/**
 * End-to-end relay tests.
 *
 * These drive the real relay over real WebSockets using the real client router,
 * so they exercise the whole of Layer 2 minus the phone. Phase 1's core needed a
 * human holding hardware; this does not, which is why Phase 2 gets proper
 * automated coverage.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RelayServer } from '../dist/relay.js';
import { WebSocketChannelRouter } from '@wii/transport';

const ROOM = '7QK2';
const OTHER_ROOM = '9MTX';

const stateFrame = (t) => ({
  type: 'state',
  t,
  q: [0, 0, 0, 1],
  o: { a: 1, b: 2, g: 3 },
  acc: { x: 0, y: 0, z: 0 },
  rot: { a: 0, b: 0, g: 0 },
  btn: [],
});

/** Poll until `predicate` holds, or fail with a useful message. */
async function waitFor(predicate, what, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Start a relay on an OS-assigned port so tests never collide. */
async function startRelay(options = {}) {
  const relay = new RelayServer({ port: 0, host: '127.0.0.1', ...options });
  await relay.listening();
  return relay;
}

function connectClient(relay, room) {
  const router = new WebSocketChannelRouter({ url: `ws://127.0.0.1:${relay.port}` });
  const received = [];
  router.onMessage((msg) => received.push(msg));
  router.connect(room);
  return { router, received };
}

test('a frame from one client reaches the other in the same room', async (t) => {
  const relay = await startRelay();
  const a = connectClient(relay, ROOM);
  const b = connectClient(relay, ROOM);
  t.after(async () => {
    a.router.disconnect();
    b.router.disconnect();
    await relay.close();
  });

  await waitFor(() => relay.roomFor(ROOM)?.size === 2, 'both clients joined');

  a.router.send(stateFrame(42));

  await waitFor(() => b.received.some((m) => m.type === 'state'), 'b received the state frame');
  const frame = b.received.find((m) => m.type === 'state');
  assert.equal(frame.t, 42);
  assert.equal(frame.o.a, 1);
  // Layer 2's contract with Layer 3: messages arrive stamped.
  assert.equal(typeof frame.recvTs, 'number');
  assert.ok('latencyMs' in frame);

  assert.ok(
    !a.received.some((m) => m.type === 'state'),
    'a sender must never receive its own frame back',
  );
});

test('rooms are isolated from each other', async (t) => {
  const relay = await startRelay();
  const a = connectClient(relay, ROOM);
  const outsider = connectClient(relay, OTHER_ROOM);
  t.after(async () => {
    a.router.disconnect();
    outsider.router.disconnect();
    await relay.close();
  });

  await waitFor(
    () => relay.roomFor(ROOM)?.size === 1 && relay.roomFor(OTHER_ROOM)?.size === 1,
    'both rooms populated',
  );

  a.router.send(stateFrame(7));
  // Give any incorrect delivery a chance to happen before asserting it did not.
  await new Promise((r) => setTimeout(r, 150));

  assert.deepEqual(
    outsider.received.filter((m) => m.type === 'state'),
    [],
    'a frame must not cross room boundaries',
  );
});

test('the relay answers pings, producing a latency estimate', async (t) => {
  const relay = await startRelay();
  const a = connectClient(relay, ROOM);
  t.after(async () => {
    a.router.disconnect();
    await relay.close();
  });

  // The heartbeat pings immediately on open, so no nudge is needed.
  await waitFor(() => a.router.latencyMs !== null, 'a latency estimate arrived');
  assert.ok(a.router.latencyMs >= 0, 'latency must be non-negative');
  assert.ok(a.router.latencyMs < 1000, 'loopback latency should be small');

  assert.ok(
    !a.received.some((m) => m.type === 'pong'),
    'pongs are consumed by ClockSync, not surfaced to callers',
  );
});

test('an existing peer is told when someone joins', async (t) => {
  const relay = await startRelay();
  const first = connectClient(relay, ROOM);
  t.after(async () => {
    first.router.disconnect();
    await relay.close();
  });
  await waitFor(() => relay.roomFor(ROOM)?.size === 1, 'first client joined');

  const second = connectClient(relay, ROOM);
  t.after(() => second.router.disconnect());

  await waitFor(
    () => first.received.some((m) => m.type === 'join' && m.room === ROOM),
    'the display learns a controller arrived',
  );
});

test('malformed input is ignored, never fatal and never forwarded', async (t) => {
  const relay = await startRelay();
  const victim = connectClient(relay, ROOM);
  t.after(async () => {
    victim.router.disconnect();
    await relay.close();
  });
  await waitFor(() => relay.roomFor(ROOM)?.size === 1, 'victim joined');

  // A raw socket, so we can send things the typed client never would.
  const hostile = new WebSocket(`ws://127.0.0.1:${relay.port}`);
  await new Promise((r) => hostile.addEventListener('open', r, { once: true }));
  hostile.send(JSON.stringify({ type: 'join', room: ROOM }));
  await waitFor(() => relay.roomFor(ROOM)?.size === 2, 'hostile client joined');

  for (const junk of [
    'not json',
    '{"type":"nope"}',
    '{"type":"state"}',
    JSON.stringify({ type: 'state', t: 'soon' }),
    '',
  ]) {
    hostile.send(junk);
  }
  await new Promise((r) => setTimeout(r, 150));

  assert.deepEqual(victim.received.filter((m) => m.type === 'state'), [], 'junk is not forwarded');
  // The relay is still alive and still routing.
  hostile.send(JSON.stringify(stateFrame(99)));
  await waitFor(
    () => victim.received.some((m) => m.type === 'state' && m.t === 99),
    'relay still routes valid traffic after being fed junk',
  );

  hostile.close();
});

test('a dropped connection reconnects and rejoins its room', async (t) => {
  const relay = await startRelay();
  const a = connectClient(relay, ROOM);
  const b = connectClient(relay, ROOM);
  t.after(async () => {
    a.router.disconnect();
    b.router.disconnect();
    await relay.close();
  });

  await waitFor(() => relay.roomFor(ROOM)?.size === 2, 'both joined');

  // Kill one peer's socket from the server side — what a phone leaving Wi-Fi
  // looks like to the relay.
  const room = relay.roomFor(ROOM);
  room.peers[0].close();

  await waitFor(() => relay.roomFor(ROOM)?.size === 1, 'the dropped peer left the room');
  // Backoff starts at 250 ms, so the rejoin is not instant.
  await waitFor(() => relay.roomFor(ROOM)?.size === 2, 'the peer reconnected and rejoined', 5000);

  // And traffic flows again afterwards.
  a.received.length = 0;
  b.received.length = 0;
  await waitFor(() => a.router.state === 'online' && b.router.state === 'online', 'both online');
  a.router.send(stateFrame(123));
  await waitFor(
    () => b.received.some((m) => m.type === 'state' && m.t === 123),
    'routing works after the reconnect',
  );
});

test('empty rooms are deleted rather than leaked', async (t) => {
  const relay = await startRelay();
  t.after(async () => await relay.close());

  const solo = connectClient(relay, ROOM);
  await waitFor(() => relay.roomCount === 1, 'room created');

  solo.router.disconnect();
  await waitFor(() => relay.roomCount === 0, 'room cleaned up when the last peer left');
});
