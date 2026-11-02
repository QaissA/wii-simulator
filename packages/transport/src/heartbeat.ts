/**
 * Heartbeat — liveness detection.
 *
 * `docs/layer-2-transport.md` §Modules: "Heartbeat — liveness ping +
 * exponential-backoff reconnect." The backoff half lives in the router; this
 * class answers one question: is the link still actually alive?
 *
 * It has to be asked explicitly, because a TCP socket does not reliably learn
 * that its peer is gone. A phone that walks out of Wi-Fi range leaves a socket
 * that looks perfectly open and simply never delivers anything again. Without a
 * timeout the controller sits there streaming into a void.
 */

import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '@wii/protocol';

export interface HeartbeatOptions {
  /** Emit a ping. Called on an interval while running. */
  send: () => void;
  /** Called once when no traffic has arrived within the timeout. */
  onTimeout: () => void;
  intervalMs?: number;
  timeoutMs?: number;
  /** Clock source, ms. Injectable for tests. */
  now?: () => number;
  /** Timer factory, injectable for tests. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export class Heartbeat {
  readonly #opts: Required<
    Pick<HeartbeatOptions, 'send' | 'onTimeout' | 'intervalMs' | 'timeoutMs' | 'now'>
  >;
  readonly #setInterval: (fn: () => void, ms: number) => unknown;
  readonly #clearInterval: (handle: unknown) => void;

  #handle: unknown = null;
  #lastSeen = 0;
  #timedOut = false;

  constructor(options: HeartbeatOptions) {
    this.#opts = {
      send: options.send,
      onTimeout: options.onTimeout,
      intervalMs: options.intervalMs ?? HEARTBEAT_INTERVAL_MS,
      timeoutMs: options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS,
      now: options.now ?? (() => Date.now()),
    };
    this.#setInterval =
      options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms) as unknown);
    this.#clearInterval =
      options.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  start(): void {
    this.stop();
    this.#lastSeen = this.#opts.now();
    this.#timedOut = false;
    // Ping immediately so the first RTT sample lands without waiting a full
    // interval — the display wants a latency estimate from the opening seconds.
    this.#opts.send();
    this.#handle = this.#setInterval(() => this.#tick(), this.#opts.intervalMs);
  }

  stop(): void {
    if (this.#handle !== null) {
      this.#clearInterval(this.#handle);
      this.#handle = null;
    }
  }

  /** Record that something arrived. Any inbound traffic counts, not just pongs. */
  noteTraffic(at: number = this.#opts.now()): void {
    this.#lastSeen = at;
  }

  get running(): boolean {
    return this.#handle !== null;
  }

  get lastSeen(): number {
    return this.#lastSeen;
  }

  #tick(): void {
    const silent = this.#opts.now() - this.#lastSeen;
    if (silent >= this.#opts.timeoutMs) {
      // Fire once. The owner tears the link down and restarts us on reconnect;
      // repeating the callback would stack reconnect attempts.
      if (this.#timedOut) return;
      this.#timedOut = true;
      this.stop();
      this.#opts.onTimeout();
      return;
    }
    this.#opts.send();
  }
}
