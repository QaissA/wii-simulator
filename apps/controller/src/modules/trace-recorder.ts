/**
 * TraceRecorder — a rolling buffer of raw sensor samples, exportable as JSON.
 *
 * `docs/implementation-plan.md` §Overall verification calls this out as the
 * single highest-value thing to build during the gesture-tuning session:
 *
 *   "Record once on a real phone, replay forever: this is what turns T1.3 from
 *    repeatedly expensive into cheap."
 *
 * Threshold tuning otherwise means a human re-swinging a phone for every
 * candidate value. With a handful of recorded traces — three clean swings, three
 * gentle waves that must NOT fire, one shake — the recognizer can be tuned and
 * regression-tested offline, and the phone is needed only to confirm the result.
 *
 * TODO(on-device): NO TRACES RECORDED YET, and no replay harness consumes them.
 * Record them first (Export trace in the debug panel), commit them under
 * `apps/controller/test/traces/`, then add the replay test. Doing it in that
 * order matters: every tuning round before the fixtures exist has to be paid for
 * again with the phone in hand. Plan ref: T1.3.
 */

import type { Euler, Vec3 } from '@wii/protocol';

export interface TraceSample {
  /** ms since recording started. */
  t: number;
  o: Euler;
  acc: Vec3;
  rot: Euler;
}

export interface Trace {
  /** Free-text label, e.g. "clean swing" or "gentle wave, must not fire". */
  label: string;
  recordedAt: string;
  userAgent: string;
  samples: TraceSample[];
}

export class TraceRecorder {
  readonly #samples: TraceSample[] = [];
  readonly #capacity: number;
  #t0 = 0;

  /** @param capacity samples retained (~10 s at 60 Hz by default). */
  constructor(capacity = 600) {
    this.#capacity = capacity;
  }

  push(sample: Omit<TraceSample, 't'>, now: number): void {
    if (this.#t0 === 0) this.#t0 = now;
    this.#samples.push({ t: Math.round(now - this.#t0), ...sample });
    if (this.#samples.length > this.#capacity) this.#samples.shift();
  }

  get size(): number {
    return this.#samples.length;
  }

  clear(): void {
    this.#samples.length = 0;
    this.#t0 = 0;
  }

  toTrace(label: string): Trace {
    return {
      label,
      recordedAt: new Date().toISOString(),
      // Recorded because a trace is only meaningful next to the device that
      // produced it — coordinate frames differ across browsers (§Gotchas).
      userAgent: navigator.userAgent,
      samples: [...this.#samples],
    };
  }

  /** Trigger a download of the current buffer. */
  download(label = 'trace'): void {
    const blob = new Blob([JSON.stringify(this.toTrace(label), null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${label.replace(/\W+/g, '-')}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }
}
