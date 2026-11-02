/**
 * Room — membership and fan-out for one pairing.
 *
 * `docs/layer-2-transport.md` §Architecture, relay path: the backend passes
 * frames between the phone and the screen that share a room code.
 *
 * This is the *relay* room, not the authoritative game room. It holds no game
 * state and applies no rules — that arrives in Layer 4 (`GameRoom`, T4.1), which
 * replaces this rather than extending it. Keeping it dumb now is deliberate: any
 * gameplay logic added here would have to be torn back out.
 */

import type { Message } from '@wii/protocol';
import { channelFor } from '@wii/protocol';

/**
 * A connected peer. Structural rather than tied to `ws` so tests can supply a
 * fake and so the WebRTC path (T2.5) can reuse this unchanged.
 */
export interface Peer {
  readonly id: string;
  /** Optional, for logs only — the relay treats all peers identically. */
  readonly role: string;
  send(data: string): void;
  close(): void;
  /** Bytes still waiting to go out. Drives the stale-frame drop below. */
  readonly bufferedAmount: number;
}

/**
 * Drop unreliable traffic to a peer once this much is queued for it.
 *
 * The mirror of the client-side limit in `@wii/transport`: a slow *receiver*
 * backs up the server's send buffer exactly the way a slow uplink backs up the
 * client's. Without this, one phone on bad Wi-Fi would make the relay hold a
 * growing backlog of poses that peer has already fallen behind.
 */
const PEER_BUFFER_LIMIT_BYTES = 4096;

/** Guard against a code collision filling a room with strangers. */
export const MAX_PEERS_PER_ROOM = 8;

export class Room {
  readonly code: string;
  readonly #peers = new Map<string, Peer>();
  readonly stats = { forwarded: 0, droppedStale: 0 };

  constructor(code: string) {
    this.code = code;
  }

  get size(): number {
    return this.#peers.size;
  }

  get peers(): readonly Peer[] {
    return [...this.#peers.values()];
  }

  get empty(): boolean {
    return this.#peers.size === 0;
  }

  has(id: string): boolean {
    return this.#peers.has(id);
  }

  add(peer: Peer): boolean {
    if (this.#peers.size >= MAX_PEERS_PER_ROOM) return false;
    this.#peers.set(peer.id, peer);
    return true;
  }

  remove(id: string): void {
    this.#peers.delete(id);
  }

  /**
   * Forward a message to everyone in the room except its sender.
   *
   * Unreliable frames are dropped for any peer whose buffer is backing up;
   * reliable ones always go, because a lost button-up leaves a player holding a
   * button they released.
   */
  broadcast(msg: Message, fromId: string, encoded: string): void {
    const unreliable = channelFor(msg) === 'unreliable';
    for (const [id, peer] of this.#peers) {
      if (id === fromId) continue;
      if (unreliable && peer.bufferedAmount > PEER_BUFFER_LIMIT_BYTES) {
        this.stats.droppedStale++;
        continue;
      }
      try {
        peer.send(encoded);
        this.stats.forwarded++;
      } catch {
        // A peer that throws on send is already gone; its close handler will
        // remove it. Never let one bad peer break the fan-out to the others.
      }
    }
  }
}
