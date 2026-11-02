import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Room, MAX_PEERS_PER_ROOM } from '../dist/room.js';

/** A fake peer whose send buffer we control — the point of the drop policy. */
function fakePeer(id, { bufferedAmount = 0, throwOnSend = false } = {}) {
  const sent = [];
  return {
    id,
    role: 'peer',
    sent,
    bufferedAmount,
    send(data) {
      if (throwOnSend) throw new Error('socket gone');
      sent.push(data);
    },
    close() {},
  };
}

const stateMsg = { type: 'state', t: 1, q: [0, 0, 0, 1], o: { a: 0, b: 0, g: 0 }, acc: { x: 0, y: 0, z: 0 }, rot: { a: 0, b: 0, g: 0 }, btn: [] };
const buttonMsg = { type: 'button', name: 'a', down: true };

test('a frame reaches every peer except its sender', () => {
  const room = new Room('7QK2');
  const a = fakePeer('a');
  const b = fakePeer('b');
  const c = fakePeer('c');
  room.add(a);
  room.add(b);
  room.add(c);

  room.broadcast(stateMsg, 'a', 'ENCODED');

  assert.deepEqual(a.sent, [], 'sender must not receive its own frame');
  assert.deepEqual(b.sent, ['ENCODED']);
  assert.deepEqual(c.sent, ['ENCODED']);
  assert.equal(room.stats.forwarded, 2);
});

test('state is dropped for a peer whose buffer is backing up', () => {
  const room = new Room('7QK2');
  const fast = fakePeer('fast', { bufferedAmount: 0 });
  const slow = fakePeer('slow', { bufferedAmount: 64_000 });
  room.add(fakePeer('sender'));
  room.add(fast);
  room.add(slow);

  room.broadcast(stateMsg, 'sender', 'ENCODED');

  assert.deepEqual(fast.sent, ['ENCODED'], 'a healthy peer still gets the frame');
  assert.deepEqual(slow.sent, [], 'a backed-up peer is skipped rather than queued');
  assert.equal(room.stats.droppedStale, 1);
});

test('reliable traffic is delivered even to a backed-up peer', () => {
  const room = new Room('7QK2');
  const slow = fakePeer('slow', { bufferedAmount: 64_000 });
  room.add(fakePeer('sender'));
  room.add(slow);

  room.broadcast(buttonMsg, 'sender', 'ENCODED');

  // A dropped button-up leaves a player holding a button they released, so this
  // must never take the drop path no matter how congested the peer is.
  assert.deepEqual(slow.sent, ['ENCODED']);
  assert.equal(room.stats.droppedStale, 0);
});

test('one broken peer does not break fan-out to the others', () => {
  const room = new Room('7QK2');
  const broken = fakePeer('broken', { throwOnSend: true });
  const healthy = fakePeer('healthy');
  room.add(fakePeer('sender'));
  room.add(broken);
  room.add(healthy);

  assert.doesNotThrow(() => room.broadcast(stateMsg, 'sender', 'ENCODED'));
  assert.deepEqual(healthy.sent, ['ENCODED']);
});

test('rooms are capped and report emptiness', () => {
  const room = new Room('7QK2');
  for (let i = 0; i < MAX_PEERS_PER_ROOM; i++) {
    assert.ok(room.add(fakePeer(`p${i}`)), `peer ${i} should fit`);
  }
  assert.equal(room.add(fakePeer('overflow')), false, 'cap must be enforced');
  assert.equal(room.size, MAX_PEERS_PER_ROOM);

  for (let i = 0; i < MAX_PEERS_PER_ROOM; i++) room.remove(`p${i}`);
  assert.ok(room.empty);
});
