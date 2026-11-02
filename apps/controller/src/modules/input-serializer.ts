/**
 * InputSerializer — builds wire messages and enforces the send rate.
 *
 * `docs/layer-1-controller.md` §Architecture: "Discrete events (button down/up,
 * gesture) go out immediately on the reliable channel; continuous state goes on
 * the throttled loop."
 *
 * That split is the whole job. Continuous state is throttled and droppable;
 * discrete events are neither, because a dropped button-up leaves a player
 * holding a button they released.
 */

import { SEND_INTERVAL_MS, quatToEuler } from '@wii/protocol';
import type {
  ButtonEvent,
  Euler,
  GestureEvent,
  Quat,
  RoomCode,
  StateFrame,
  Vec3,
} from '@wii/protocol';

export interface FrameInput {
  /** Calibrated orientation. The authoritative one — `o` is derived from it. */
  q: Quat;
  acc: Vec3;
  rot: Euler;
  buttons: readonly string[];
}

export class InputSerializer {
  #lastSend = 0;
  /** Wall-clock deadline for the next state frame. Accumulates; never resets to `now`. */
  #nextSend = 0;
  #sent = 0;
  #windowStart = 0;
  #hz = 0;

  /**
   * Build a state frame if the send interval has elapsed, else `null`.
   *
   * Returning `null` rather than queueing is deliberate: at 50 Hz the next frame
   * is 20 ms away and strictly better than the one being skipped.
   *
   * `now` and `captureAtMs` are deliberately separate clocks. Throttling wants a
   * monotonic local clock (the rAF timestamp), which never jumps. The wire
   * timestamp wants the *relay's* clock, because it is read by a different
   * device: the display subtracts it from its own clock to get frame age, and
   * two machines' local clocks have no defined relationship. Stamping the rAF
   * timestamp here — as this did until Layer 3 first tried to read it — yields a
   * page-uptime value that the display cannot reconcile with anything.
   */
  maybeState(
    input: FrameInput,
    now: number,
    room: RoomCode | null,
    captureAtMs = now,
  ): StateFrame | null {
    if (now < this.#nextSend) return null;
    // Advance the deadline by a whole interval rather than restarting it from
    // `now`. Restarting is the obvious version and it silently halves the rate:
    // capture runs off requestAnimationFrame at ~16.7 ms, so "has 20 ms elapsed
    // since the last send?" is false on every other frame and true on the rest —
    // 30 Hz, not 50, on any 60 Hz display, with 50 unreachable at all. Letting
    // the deadline accumulate lets a 16.7 ms cadence average out to the target.
    //
    // `Math.max` is the catch-up guard: after a stall the deadline could sit far
    // in the past, and without the clamp the loop would fire every frame until it
    // caught up on time nobody wants replayed.
    this.#nextSend = Math.max(now, this.#nextSend + SEND_INTERVAL_MS);
    this.#lastSend = now;
    this.#tickRate(now);

    return {
      type: 'state',
      t: Math.round(captureAtMs),
      q: input.q,
      // Derived here rather than passed in, so the two orientation fields on the
      // wire cannot disagree. A caller that could supply both would eventually
      // supply a mismatched pair, and the resulting bug — a HUD that contradicts
      // the cursor — would look like a rendering fault rather than a plumbing one.
      o: quatToEuler(input.q),
      acc: input.acc,
      rot: input.rot,
      btn: [...input.buttons],
      // Spread so `exactOptionalPropertyTypes` never sees `room: undefined`;
      // unpaired frames must omit the field, not carry an empty one.
      ...(room ? { room } : {}),
    };
  }

  button(name: string, down: boolean, room: RoomCode | null): ButtonEvent {
    return { type: 'button', name, down, ...(room ? { room } : {}) };
  }

  gesture(name: string, room: RoomCode | null): GestureEvent {
    return { type: 'gesture', name, ...(room ? { room } : {}) };
  }

  /**
   * Measured send rate, Hz. Should sit at `SEND_HZ`; a dip means a stalled loop.
   *
   * Confirmed reading ~50 in headless Chrome with the capture loop actually
   * running (`tools/display-check/e2e.mjs`). It read 30 there first, which is
   * what exposed the deadline bug fixed above.
   *
   * TODO(on-device): still unconfirmed on a real phone. A device whose refresh
   * rate is below SEND_HZ — a 30 Hz power-saving mode, say — cannot reach the
   * target no matter how the deadline is computed, because capture is bounded by
   * requestAnimationFrame. If this reads ~30 on hardware, check the refresh rate
   * before suspecting the send loop. Plan ref: T1.5.
   */
  get hz(): number {
    return this.#hz;
  }

  #tickRate(now: number): void {
    this.#sent++;
    if (this.#windowStart === 0) this.#windowStart = now;
    const elapsed = now - this.#windowStart;
    if (elapsed >= 1000) {
      this.#hz = Math.round((this.#sent * 1000) / elapsed);
      this.#sent = 0;
      this.#windowStart = now;
    }
  }
}
