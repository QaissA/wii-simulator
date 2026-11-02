/**
 * DisplayClient — the screen's link to the relay.
 *
 * The mirror image of the controller's `NetClient`, and a thin adapter over the
 * same `@wii/transport` router for the same reason: the phone and the screen
 * must not drift apart in how they talk to Layer 2.
 *
 * It adds the two things only a receiver needs:
 *
 *   - **presence** — is a controller actually sending? The link being `online`
 *     says the *relay* is reachable, which is a different question. A phone that
 *     locks its screen leaves a perfectly healthy socket behind.
 *   - **frame age** — capture-to-now, which is the number `00-overview.md`
 *     §Latency budget calls non-negotiable. This is what T2.3's `recvTs` and
 *     clock offset were built for; without translating the controller's capture
 *     timestamp onto the local clock, `t` is a reading from a stranger's clock
 *     and subtracting it measures clock skew, not latency.
 */

import { CONTROLLER_PRESENCE_TIMEOUT_MS, isStateFrame } from '@wii/protocol';
import type { Delivered, Message, RoomCode, StateFrame } from '@wii/protocol';
import { Emitter, WebSocketChannelRouter } from '@wii/transport';
import type { LinkState, Unsubscribe } from '@wii/transport';

export interface DisplayClientOptions {
  /** Relay URL, e.g. `wss://host:8081`. */
  url: string;
  /**
   * Clock source. Must be epoch-based (`Date.now`), not `performance.now`: the
   * router's ClockSync syncs against the relay's `Date.now`, so a monotonic
   * page-relative clock here would make every derived offset meaningless.
   */
  now?: () => number;
}

export class DisplayClient {
  readonly #url: string;
  readonly #now: () => number;

  readonly #frames = new Emitter<[Delivered<StateFrame>, number]>();
  readonly #messages = new Emitter<[Delivered]>();
  readonly #states = new Emitter<[LinkState, string | undefined]>();
  readonly #presence = new Emitter<[boolean]>();

  #router: WebSocketChannelRouter | null = null;
  #linkState: LinkState = 'offline';
  #room: RoomCode | null = null;

  #present = false;
  #lastFrameAt: number | null = null;
  /** Capture timestamp of the newest frame, already on the local clock. */
  #lastCaptureLocal: number | null = null;

  /** Rolling receive rate, Hz — the display-side counterpart of the phone's send HZ. */
  #rateWindowStart = 0;
  #rateCount = 0;
  #receiveHz = 0;

  constructor(options: DisplayClientOptions) {
    this.#url = options.url;
    this.#now = options.now ?? (() => Date.now());
  }

  get linkState(): LinkState {
    return this.#linkState;
  }

  get room(): RoomCode | null {
    return this.#room;
  }

  /** Estimated one-way latency, ms. `null` until the first pong. */
  get latencyMs(): number | null {
    return this.#router?.latencyMs ?? null;
  }

  /** True while a controller is actually sending frames. */
  get controllerPresent(): boolean {
    return this.#present;
  }

  get receiveHz(): number {
    return this.#receiveHz;
  }

  /**
   * Newest state frame, with its capture time already translated onto the local
   * clock — the value `PredictiveAxis` wants. Handing over the raw `frame.t`
   * instead is the trap: it is a reading from the phone's clock, and prediction
   * fed a foreign timebase extrapolates by the clock offset rather than by the
   * age of the sample.
   */
  onFrame(fn: (frame: Delivered<StateFrame>, captureLocalMs: number) => void): Unsubscribe {
    return this.#frames.add(fn);
  }

  /** Every delivered message, state frames included. Feed this to `InputAdapter`. */
  onMessage(fn: (msg: Delivered) => void): Unsubscribe {
    return this.#messages.add(fn);
  }

  onLinkState(fn: (state: LinkState, detail?: string) => void): Unsubscribe {
    return this.#states.add(fn);
  }

  onPresence(fn: (present: boolean) => void): Unsubscribe {
    return this.#presence.add(fn);
  }

  connect(room: RoomCode): void {
    this.disconnect();
    this.#room = room;

    const router = new WebSocketChannelRouter({ url: this.#url, now: this.#now });
    router.onState((state, detail) => {
      this.#linkState = state;
      // A link that is no longer online cannot be carrying frames, so presence
      // drops immediately rather than waiting out the silence timeout.
      if (state !== 'online') this.#setPresent(false);
      this.#states.emit(state, detail);
    });
    router.onMessage((msg) => this.#receive(msg));

    this.#router = router;
    router.connect(room);
  }

  disconnect(): void {
    this.#router?.disconnect();
    this.#router = null;
    this.#linkState = 'offline';
    this.#room = null;
    this.#setPresent(false);
    this.#lastCaptureLocal = null;
    this.#lastFrameAt = null;
  }

  /**
   * Send — used only for the handful of things a display originates (a lobby
   * ready-signal, later a haptic cue). The router picks the channel.
   */
  send(msg: Message): void {
    this.#router?.send(msg);
  }

  /**
   * Age of the newest frame: phone capture → now, ms.
   *
   * `null` before the first frame, or before `ClockSync` has an offset to place
   * the controller's clock on ours — reporting a number derived from unsynced
   * clocks would be worse than reporting nothing, because it looks plausible.
   */
  frameAgeMs(now = this.#now()): number | null {
    if (this.#lastCaptureLocal === null) return null;
    return Math.max(0, now - this.#lastCaptureLocal);
  }

  /**
   * Expire presence. Call once per animation frame.
   *
   * Presence has to time out on a clock the display owns, because "no frames
   * arrived" is by definition not an event the network will deliver.
   */
  poll(now = this.#now()): void {
    if (!this.#present || this.#lastFrameAt === null) return;
    if (now - this.#lastFrameAt > CONTROLLER_PRESENCE_TIMEOUT_MS) {
      this.#setPresent(false);
      this.#receiveHz = 0;
    }
  }

  #receive(msg: Delivered): void {
    // A `join` forwarded by the relay is how a display learns a controller
    // arrived. It is not sufficient on its own — a display that joins a room the
    // phone is already in never sees one — so state frames below also assert
    // presence. Both paths are needed; neither alone is.
    if (msg.type === 'join') this.#setPresent(true);

    // Order matters. `onMessage` is the ingest channel — it is where the
    // `InputAdapter` is fed — and `onFrame` is where scenes *read* what that
    // ingest produced. Emitting frames first would have every scene reading the
    // previous frame's axes, one frame stale, forever.
    this.#messages.emit(msg);

    if (isStateFrame(msg)) {
      this.#noteFrame(msg);
      this.#frames.emit(msg, this.#lastCaptureLocal ?? msg.recvTs);
    }
  }

  #noteFrame(frame: Delivered<StateFrame>): void {
    this.#setPresent(true);
    this.#lastFrameAt = frame.recvTs;

    // `frame.t` is the phone's clock. Translate it onto ours before it is used
    // for anything — this is the whole point of T2.3.
    const local = this.#router?.toLocalTime(frame.t);
    this.#lastCaptureLocal = typeof local === 'number' && Number.isFinite(local) ? local : null;

    this.#rateCount++;
    const elapsed = frame.recvTs - this.#rateWindowStart;
    if (elapsed >= 500) {
      this.#receiveHz = (this.#rateCount * 1000) / elapsed;
      this.#rateWindowStart = frame.recvTs;
      this.#rateCount = 0;
    }
  }

  #setPresent(present: boolean): void {
    if (this.#present === present) return;
    this.#present = present;
    if (!present) {
      this.#lastCaptureLocal = null;
      this.#lastFrameAt = null;
    } else {
      this.#rateWindowStart = this.#now();
      this.#rateCount = 0;
    }
    this.#presence.emit(present);
  }
}
