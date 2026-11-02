/**
 * ChannelRouter — one API over "reliable vs unreliable".
 *
 * `docs/layer-2-transport.md` §Modules: "ChannelRouter — abstracts 'reliable vs
 * unreliable'; same API whether backed by WS or WebRTC."
 *
 * The point of this seam is that **callers never choose a channel**. They hand
 * over a message; `channelFor()` in the protocol package decides. That is what
 * makes the WebRTC swap (T2.5) invisible to Layers 1 and 3 — and what stops the
 * specific mistake §Gotchas warns about, where continuous state ends up on a
 * reliable channel and stale frames stack behind head-of-line blocking.
 */

import type { Delivered, Message, RoomCode } from '@wii/protocol';

export type LinkState = 'offline' | 'connecting' | 'online';

/** Unsubscribe handle returned by the `on*` methods. */
export type Unsubscribe = () => void;

export interface ChannelRouter {
  readonly state: LinkState;
  readonly room: RoomCode | null;
  /** Estimated one-way latency, ms. `null` until the first pong. */
  readonly latencyMs: number | null;

  connect(room: RoomCode): void;
  disconnect(): void;

  /**
   * Send a message. The channel is chosen from the message type, never by the
   * caller. Sending while offline is not an error — see each implementation for
   * what happens to reliable versus unreliable traffic.
   */
  send(msg: Message): void;

  /** Subscribe to delivered messages (stamped with `recvTs` + `latencyMs`). */
  onMessage(fn: (msg: Delivered) => void): Unsubscribe;

  /** Subscribe to link state changes. */
  onState(fn: (state: LinkState, detail?: string) => void): Unsubscribe;
}

/** Minimal typed emitter — smaller than pulling in a dependency for this. */
export class Emitter<Args extends unknown[]> {
  readonly #handlers = new Set<(...args: Args) => void>();

  add(fn: (...args: Args) => void): Unsubscribe {
    this.#handlers.add(fn);
    return () => this.#handlers.delete(fn);
  }

  emit(...args: Args): void {
    // Copied before iterating: a handler that unsubscribes itself would
    // otherwise mutate the set mid-iteration.
    for (const fn of [...this.#handlers]) fn(...args);
  }

  clear(): void {
    this.#handlers.clear();
  }
}
