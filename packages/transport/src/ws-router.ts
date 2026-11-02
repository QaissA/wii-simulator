/**
 * WebSocketChannelRouter — the default transport.
 *
 * `docs/layer-2-transport.md` §Rule of thumb: "start with WebSockets + an
 * authoritative server; reach for WebRTC only when you truly need peer-to-peer
 * or the tightest latency."
 *
 * One socket carries both logical channels, so the guarantees are enforced by
 * *policy* here rather than by the transport:
 *
 *   reliable   — queued while connecting, flushed on open, never dropped.
 *   unreliable — dropped when the link is down, and dropped again when the send
 *                buffer is backing up.
 *
 * That second rule is the one that matters. §Gotchas: "Don't send continuous
 * state on a reliable/ordered channel — head-of-line blocking will stack stale
 * frames." A WebSocket *is* ordered and reliable, so simply calling `send()` at
 * 50 Hz over a congested link builds exactly the queue the doc warns about. The
 * `bufferedAmount` check below is what actually prevents it: when the socket is
 * behind, new state frames are discarded rather than queued, because by the time
 * a backlogged frame arrives it describes a pose the hand has long since left.
 */

import {
  ClockSync,
  RECONNECT_BACKOFF_MS,
  channelFor,
  encode,
  isPongMessage,
  stamp,
  tryDecode,
} from '@wii/protocol';
import type { Delivered, Message, RoomCode } from '@wii/protocol';

import { Emitter } from './channel-router.js';
import type { ChannelRouter, LinkState, Unsubscribe } from './channel-router.js';
import { Heartbeat } from './heartbeat.js';

/**
 * Drop unreliable traffic once this many bytes are waiting to go out.
 *
 * ~4 KB is roughly twenty 50 Hz state frames — about 0.4 s of backlog. Large
 * enough to ride out a momentary stall, small enough that the stream never
 * drifts far enough behind to feel like input lag.
 */
const UNRELIABLE_BUFFER_LIMIT_BYTES = 4096;

/**
 * Cap on reliable messages held while connecting. Reliable traffic is discrete
 * (joins, buttons, gestures), so a healthy client never approaches this; the cap
 * exists so a long outage cannot grow the queue without bound.
 */
const RELIABLE_QUEUE_LIMIT = 32;

export interface WsRouterOptions {
  /** Relay URL, e.g. `wss://host:8081`. */
  url: string;
  /** Socket factory, injectable for tests. Defaults to the global `WebSocket`. */
  createSocket?: (url: string) => WebSocket;
  now?: () => number;
  /** Disable the heartbeat (tests that drive time manually). */
  heartbeat?: boolean;
}

export class WebSocketChannelRouter implements ChannelRouter {
  readonly #url: string;
  readonly #createSocket: (url: string) => WebSocket;
  readonly #now: () => number;
  readonly #useHeartbeat: boolean;

  readonly #messages = new Emitter<[Delivered]>();
  readonly #states = new Emitter<[LinkState, string | undefined]>();
  readonly #clock = new ClockSync();
  readonly #reliableQueue: Message[] = [];

  #socket: WebSocket | null = null;
  #room: RoomCode | null = null;
  #state: LinkState = 'offline';
  #backoff: number = RECONNECT_BACKOFF_MS.min;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #closedByUs = false;
  #heartbeat: Heartbeat | null = null;

  /** Counters — the cheapest way to prove the drop policy is working. */
  readonly stats = { sent: 0, droppedUnreliable: 0, queuedReliable: 0, received: 0 };

  constructor(options: WsRouterOptions) {
    this.#url = options.url;
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#now = options.now ?? (() => Date.now());
    this.#useHeartbeat = options.heartbeat ?? true;
  }

  get state(): LinkState {
    return this.#state;
  }

  get room(): RoomCode | null {
    return this.#room;
  }

  get latencyMs(): number | null {
    return this.#clock.latencyMs;
  }

  /** Offset to place a remote timestamp on the local clock. Used for frame age. */
  toLocalTime(remoteTs: number): number {
    return this.#clock.toLocal(remoteTs);
  }

  /**
   * Place a local timestamp on the relay's clock, for stamping outgoing
   * messages. The counterpart of `toLocalTime` on the receiving end — together
   * they are what make a capture timestamp comparable across two devices.
   */
  toRemoteTime(localTs: number): number {
    return this.#clock.toRemote(localTs);
  }

  /** True once ClockSync has a usable sample. Timestamps pass through until then. */
  get clockSynced(): boolean {
    return this.#clock.synced;
  }

  onMessage(fn: (msg: Delivered) => void): Unsubscribe {
    return this.#messages.add(fn);
  }

  onState(fn: (state: LinkState, detail?: string) => void): Unsubscribe {
    return this.#states.add(fn);
  }

  connect(room: RoomCode): void {
    this.disconnect();
    this.#closedByUs = false;
    this.#room = room;
    this.#open();
  }

  disconnect(): void {
    this.#closedByUs = true;
    this.#clearReconnect();
    this.#heartbeat?.stop();
    this.#heartbeat = null;
    this.#clock.reset();
    this.#reliableQueue.length = 0;
    if (this.#socket) {
      this.#socket.onclose = null;
      try {
        this.#socket.close();
      } catch {
        /* already closing */
      }
      this.#socket = null;
    }
    this.#setState('offline');
  }

  send(msg: Message): void {
    const channel = channelFor(msg);
    const sock = this.#socket;
    const open = sock !== null && sock.readyState === 1; /* OPEN */

    if (!open) {
      // Reliable traffic waits for the link; unreliable traffic is simply gone.
      if (channel === 'reliable' && this.#reliableQueue.length < RELIABLE_QUEUE_LIMIT) {
        this.#reliableQueue.push(msg);
        this.stats.queuedReliable++;
      } else if (channel === 'unreliable') {
        this.stats.droppedUnreliable++;
      }
      return;
    }

    if (channel === 'unreliable' && sock.bufferedAmount > UNRELIABLE_BUFFER_LIMIT_BYTES) {
      // The socket is behind. A frame queued now would arrive describing a pose
      // the hand has already left, so drop it and let the next one be current.
      this.stats.droppedUnreliable++;
      return;
    }

    sock.send(encode(msg) as string);
    this.stats.sent++;
  }

  #open(): void {
    if (!this.#room) return;
    this.#setState('connecting');

    let sock: WebSocket;
    try {
      sock = this.#createSocket(this.#url);
    } catch (err) {
      this.#scheduleReconnect(err instanceof Error ? err.message : 'bad relay URL');
      return;
    }
    this.#socket = sock;

    sock.onopen = () => {
      this.#backoff = RECONNECT_BACKOFF_MS.min;
      this.#setState('online');
      // Join first, ahead of anything queued: the relay cannot route a message
      // from a client it has not yet placed in a room.
      if (this.#room) this.send({ type: 'join', room: this.#room });
      const queued = this.#reliableQueue.splice(0);
      for (const msg of queued) this.send(msg);
      if (this.#useHeartbeat) this.#startHeartbeat();
    };

    sock.onmessage = (ev: MessageEvent) => {
      const raw: unknown = ev.data;
      const msg = tryDecode(typeof raw === 'string' ? raw : new Uint8Array(raw as ArrayBuffer));
      // Any inbound traffic proves the link is alive, not just pongs.
      this.#heartbeat?.noteTraffic(this.#now());
      if (!msg) return; // hostile or corrupt input is a normal branch, never fatal
      this.stats.received++;

      if (isPongMessage(msg)) {
        this.#clock.acceptPong(msg, this.#now());
        return;
      }
      this.#messages.emit(stamp(msg, this.#now(), this.#clock.latencyMs));
    };

    sock.onerror = () => {
      /* `onclose` always follows — reconnect logic lives there, in one place */
    };

    sock.onclose = (ev: CloseEvent) => {
      this.#socket = null;
      this.#heartbeat?.stop();
      this.#heartbeat = null;
      this.#clock.reset(); // a new route may have a different RTT
      if (this.#closedByUs) return;
      this.#scheduleReconnect(ev.reason || `closed (${ev.code})`);
    };
  }

  #startHeartbeat(): void {
    this.#heartbeat = new Heartbeat({
      send: () => this.send(this.#clock.createPing()),
      onTimeout: () => {
        // Silent link. Force it closed so `onclose` runs the normal reconnect
        // path rather than inventing a second one here.
        try {
          this.#socket?.close();
        } catch {
          /* already gone */
        }
        this.#socket = null;
        this.#scheduleReconnect('heartbeat timeout');
      },
      now: this.#now,
    });
    this.#heartbeat.start();
  }

  #scheduleReconnect(detail: string): void {
    if (this.#closedByUs) return;
    this.#setState('connecting', detail);
    const wait = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, RECONNECT_BACKOFF_MS.max);
    this.#clearReconnect();
    this.#reconnectTimer = setTimeout(() => this.#open(), wait);
  }

  #clearReconnect(): void {
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
  }

  #setState(state: LinkState, detail?: string): void {
    this.#state = state;
    this.#states.emit(state, detail);
  }
}
