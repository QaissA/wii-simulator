/**
 * NetClient — the controller's link to the relay.
 *
 * `docs/layer-1-controller.md` §Modules: "WebRTC DataChannel or WebSocket; no-op
 * in local demo mode."
 *
 * As of T2.2 this is a thin adapter over `@wii/transport`'s `ChannelRouter`
 * rather than an implementation in its own right. The reconnect, heartbeat and
 * channel-policy logic that used to live here now sits in shared code, for the
 * same reason the message codec does: the phone and the screen must not drift
 * apart. When the WebRTC path lands (T2.5) it replaces the router underneath —
 * this file, and `main.ts` above it, do not change.
 *
 * Local demo mode is simply "never call `connect`": every `send` is then a
 * no-op, so the controller works standalone with no branching at the call site.
 */

import { WebSocketChannelRouter } from '@wii/transport';
import type { LinkState } from '@wii/transport';
import type { Message, RoomCode } from '@wii/protocol';

export type ConnectionState = LinkState;

export interface NetClientEvents {
  onState?: (state: ConnectionState, detail?: string) => void;
  onMessage?: (msg: Message) => void;
}

export class NetClient {
  #router: WebSocketChannelRouter | null = null;
  #state: ConnectionState = 'offline';
  readonly #events: NetClientEvents;

  constructor(events: NetClientEvents = {}) {
    this.#events = events;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  get room(): RoomCode | null {
    return this.#router?.room ?? null;
  }

  /** Estimated one-way latency, ms. `null` until the first pong. */
  get latencyMs(): number | null {
    return this.#router?.latencyMs ?? null;
  }

  connect(url: string, room: RoomCode): void {
    this.disconnect();
    const router = new WebSocketChannelRouter({ url });
    router.onState((state, detail) => {
      this.#state = state;
      this.#events.onState?.(state, detail);
    });
    router.onMessage((msg) => this.#events.onMessage?.(msg));
    this.#router = router;
    router.connect(room);
  }

  /**
   * Place a local epoch timestamp on the relay's clock.
   *
   * Passes the value straight through while unpaired or unsynced, which is the
   * right degradation: the display's own `toLocal` is also a pass-through until
   * it has a sample, so the two cancel out and frame age is merely approximate
   * rather than nonsense.
   */
  toRelayTime(localMs: number): number {
    return this.#router?.toRemoteTime(localMs) ?? localMs;
  }

  disconnect(): void {
    this.#router?.disconnect();
    this.#router = null;
    this.#state = 'offline';
    this.#events.onState?.('offline');
  }

  /**
   * Send a message. A no-op while unpaired, and the router drops or queues by
   * message type from there — callers never pick a channel.
   */
  send(msg: Message): void {
    this.#router?.send(msg);
  }
}
