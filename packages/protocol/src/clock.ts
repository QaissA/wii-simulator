/**
 * ClockSync — round-trip estimation so the display can compensate for latency.
 *
 * `docs/layer-2-transport.md` §Modules: "ClockSync — round-trip time estimation;
 * stamps frames so the display can compensate."
 *
 * Cristian's algorithm with min-RTT selection: the sample that made the fastest
 * round trip is the one least distorted by queueing, so it gives the best offset
 * estimate. Averaging samples instead would let one bufferbloat spike poison the
 * clock for seconds.
 */

import type { PingMessage, PongMessage } from './types.js';

interface Sample {
  rtt: number;
  offset: number;
}

export interface ClockSyncOptions {
  /** Samples retained. Older ones age out, so the estimate tracks route changes. */
  windowSize?: number;
  /** Clock source, ms. Injectable for tests. */
  now?: () => number;
}

export class ClockSync {
  readonly #samples: Sample[] = [];
  readonly #windowSize: number;
  readonly #now: () => number;

  constructor(options: ClockSyncOptions = {}) {
    this.#windowSize = options.windowSize ?? 8;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Build a ping. Send it on the reliable channel. */
  createPing(): PingMessage {
    return { type: 'ping', t: this.#now() };
  }

  /** Answer a ping. Called by whichever side is acting as the clock reference. */
  createPong(ping: PingMessage): PongMessage {
    return { type: 'pong', t: ping.t, serverT: this.#now() };
  }

  /**
   * Fold a pong into the estimate.
   *
   * Returns the RTT of this sample, or `null` if the pong was bogus (a `t` from
   * the future, or one we never sent).
   */
  acceptPong(pong: PongMessage, receivedAt: number = this.#now()): number | null {
    const rtt = receivedAt - pong.t;
    if (!Number.isFinite(rtt) || rtt < 0) return null;

    // Assume the two legs are symmetric — the standard, and good enough here.
    const oneWay = rtt / 2;
    // The remote clock read `serverT` at local time `receivedAt - oneWay`, so
    // this is what must be ADDED to a remote timestamp to land on the local
    // clock. Mind the direction: NTP's usual offset is local→remote, which is
    // the negation of this one.
    const offset = receivedAt - oneWay - pong.serverT;

    this.#samples.push({ rtt, offset });
    if (this.#samples.length > this.#windowSize) this.#samples.shift();
    return rtt;
  }

  /** The lowest-RTT sample in the window — our best estimate. `null` until one exists. */
  get #best(): Sample | null {
    let best: Sample | null = null;
    for (const s of this.#samples) {
      if (!best || s.rtt < best.rtt) best = s;
    }
    return best;
  }

  /** Round-trip time, ms. `null` before the first pong. */
  get rttMs(): number | null {
    return this.#best?.rtt ?? null;
  }

  /** Estimated one-way latency, ms — what gets stamped onto delivered frames. */
  get latencyMs(): number | null {
    const rtt = this.rttMs;
    return rtt === null ? null : rtt / 2;
  }

  /** Offset to add to a remote timestamp to place it on the local clock, ms. */
  get offsetMs(): number | null {
    return this.#best?.offset ?? null;
  }

  /** True once there is at least one usable sample. */
  get synced(): boolean {
    return this.#best !== null;
  }

  /**
   * Convert a remote timestamp (e.g. a `StateFrame.t` captured on the phone)
   * to this machine's clock. Passes the value through unchanged until synced,
   * so callers get a usable number from the first frame.
   */
  toLocal(remoteTs: number): number {
    const offset = this.offsetMs;
    return offset === null ? remoteTs : remoteTs + offset;
  }

  /**
   * Convert a local timestamp to the remote clock — the inverse of `toLocal`.
   *
   * This is what lets a *sender* stamp an outgoing message in the reference
   * clock's time. Both the phone and the screen sync against the relay, so a
   * capture timestamp expressed in relay time is a value the receiver can
   * actually place on its own clock. Stamping it in the sender's own local time
   * instead produces a number the receiver can only subtract meaninglessly —
   * two devices' clocks have no defined relationship.
   */
  toRemote(localTs: number): number {
    const offset = this.offsetMs;
    return offset === null ? localTs : localTs - offset;
  }

  /** Drop all samples — call after a reconnect, the route may have changed. */
  reset(): void {
    this.#samples.length = 0;
  }
}
