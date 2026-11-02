/**
 * AudioDirector — who gets to make a sound, and how loud.
 *
 * The mixing *policy*, separated from the noise-making. `docs/implementation-plan.md`
 * §Why `packages/engine` and not `apps/display`: "the expensive-to-get-wrong parts
 * [stay] testable without a browser." Nothing here touches WebAudio, so every rule
 * below is exercised by `node --test` rather than by a human listening for a glitch.
 *
 * There are three rules, and each exists because a specific moment in a specific
 * game sounds wrong without it:
 *
 * 1. **Throttle.** Star fighter fires on a 0.24 s cooldown and fruit slash can cut
 *    four fruit inside one stroke sample. Identical short samples stacked within a
 *    few milliseconds do not read as "four slices" — they read as one louder,
 *    phasier slice, because that is literally what summing near-identical waveforms
 *    produces. Dropping the repeats is not a compromise, it is the correct mix.
 * 2. **Polyphony cap.** A star fighter bomb clears a whole formation in one step.
 *    Thirty simultaneous explosions is roughly thirty times the amplitude of one,
 *    which clips hard enough to be heard as a click rather than as a bomb.
 * 3. **Priority.** Once capped, *something* must be dropped, and it must not be the
 *    sound the player is waiting for. A game-over must survive a screen full of
 *    incidental hits; that is the entire reason a cue carries a rank.
 *
 * The director never plays anything. `request()` returns the voice a sink should
 * render, or `null` if policy dropped it. That is what makes it testable, and it is
 * also what keeps the sound design (`apps/display/src/audio/cues.ts`) separable from
 * the rules about when sound is allowed.
 */

/** How one named cue behaves in the mix. All fields optional; the defaults are sane. */
export interface CuePolicy {
  /**
   * Relative loudness, 0..1. Not a volume knob for the player — a balance
   * decision, made once, so a slice and an explosion sit at sensible levels
   * relative to each other.
   */
  gain?: number;
  /**
   * Minimum ms between two plays of this cue. A request inside the window is
   * dropped rather than queued: a late duplicate of a percussive sound is worse
   * than no duplicate, because it arrives detached from the event that caused it.
   */
  minIntervalMs?: number;
  /**
   * Roughly how long the voice sounds for, ms. Used *only* to decide when its
   * polyphony slot frees up — the sink owns the real envelope. Overestimating
   * here costs a little headroom; underestimating lets the cap be exceeded.
   */
  holdMs?: number;
  /** Higher survives eviction. Ties favour the voice already sounding. */
  priority?: number;
}

export interface VoiceRequest {
  readonly cue: string;
  /** Final linear gain, 0..1: master × policy × the caller's scale. */
  readonly gain: number;
  /** The `nowMs` the request was made with, so a sink can schedule against it. */
  readonly at: number;
}

export interface AudioDirectorOptions {
  /** Cue name → policy. A cue with no entry here still plays, on the defaults. */
  policies?: Readonly<Record<string, CuePolicy>>;
  /**
   * Most voices sounding at once.
   *
   * Eight is not a hardware limit — WebAudio will happily start hundreds. It is a
   * *headroom* limit: past roughly this many overlapping voices the sum clips, and
   * a compressor downstream turns clipping into pumping rather than into music.
   */
  maxVoices?: number;
  /** Starting master volume, 0..1. */
  volume?: number;
  muted?: boolean;
}

const DEFAULT_POLICY: Required<CuePolicy> = {
  gain: 1,
  // Zero, not a small number: most cues are one-per-event and must never be
  // silently swallowed. Throttling is opt-in per cue, by the sound designer who
  // knows which ones repeat.
  minIntervalMs: 0,
  holdMs: 250,
  priority: 0,
};

export interface AudioStats {
  requested: number;
  played: number;
  /** Dropped by `minIntervalMs`. */
  throttled: number;
  /** Dropped or evicted by the polyphony cap. */
  dropped: number;
  /** Dropped because sound is off. Counted separately: this is not a mix problem. */
  silenced: number;
}

interface ActiveVoice {
  priority: number;
  until: number;
}

export class AudioDirector {
  readonly #policies: Readonly<Record<string, CuePolicy>>;
  readonly #maxVoices: number;

  /** Last `nowMs` each cue was allowed through, for the throttle. */
  readonly #lastPlayed = new Map<string, number>();
  #active: ActiveVoice[] = [];

  #volume: number;
  #muted: boolean;

  readonly stats: AudioStats = {
    requested: 0,
    played: 0,
    throttled: 0,
    dropped: 0,
    silenced: 0,
  };

  constructor(options: AudioDirectorOptions = {}) {
    this.#policies = options.policies ?? {};
    this.#maxVoices = Math.max(1, options.maxVoices ?? 8);
    this.#volume = clamp01(options.volume ?? 1);
    this.#muted = options.muted ?? false;
  }

  get muted(): boolean {
    return this.#muted;
  }

  get volume(): number {
    return this.#volume;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    // Muting is not pausing. Everything sounding is gone by the time sound comes
    // back, so holding their slots would silently shrink the budget — the first
    // seconds after unmuting would drop voices for no visible reason.
    if (muted) this.#active = [];
  }

  setVolume(volume: number): void {
    this.#volume = clamp01(volume);
  }

  /**
   * Ask to play `cue` at `nowMs`.
   *
   * Returns the voice to render, or `null` when policy declined. `gainScale` lets
   * a caller vary one instance — a distant explosion, a combo that grows louder —
   * without inventing a second cue for it.
   */
  request(cue: string, nowMs: number, gainScale = 1): VoiceRequest | null {
    this.stats.requested++;

    if (this.#muted || this.#volume <= 0) {
      this.stats.silenced++;
      return null;
    }

    const policy = this.#policies[cue] ?? DEFAULT_POLICY;
    const minInterval = policy.minIntervalMs ?? DEFAULT_POLICY.minIntervalMs;
    const last = this.#lastPlayed.get(cue);
    if (last !== undefined && nowMs - last < minInterval) {
      this.stats.throttled++;
      return null;
    }

    this.#expire(nowMs);

    const priority = policy.priority ?? DEFAULT_POLICY.priority;
    if (this.#active.length >= this.#maxVoices && !this.#makeRoom(priority)) {
      this.stats.dropped++;
      return null;
    }

    const gain = clamp01(this.#volume * (policy.gain ?? DEFAULT_POLICY.gain) * gainScale);
    // A request that survives every rule and then rounds to silence still counts
    // as played: the caller scaled it to nothing deliberately, and reporting it as
    // a drop would make the stats read like a mix fault.
    this.#lastPlayed.set(cue, nowMs);
    this.#active.push({ priority, until: nowMs + (policy.holdMs ?? DEFAULT_POLICY.holdMs) });
    this.stats.played++;

    return { cue, gain, at: nowMs };
  }

  /** Voices believed to be sounding. Diagnostics and tests; not a mixing input. */
  activeVoices(nowMs: number): number {
    this.#expire(nowMs);
    return this.#active.length;
  }

  /**
   * Forget every voice and every throttle window.
   *
   * Called when a scene tears down: the next scene starts with full headroom, and
   * a cue throttled just before a round ended is not still throttled when the next
   * one begins.
   */
  reset(): void {
    this.#active = [];
    this.#lastPlayed.clear();
  }

  #expire(nowMs: number): void {
    if (this.#active.length === 0) return;
    this.#active = this.#active.filter((v) => v.until > nowMs);
  }

  /**
   * Evict one lower-priority voice, or report that nothing can go.
   *
   * Strictly lower, so a burst of same-priority events cannot cannibalise itself:
   * thirty explosions at equal rank should be the *first* few, all sounding
   * through, rather than each one cutting off its predecessor into a stutter.
   */
  #makeRoom(priority: number): boolean {
    let weakest = -1;
    for (let i = 0; i < this.#active.length; i++) {
      const v = this.#active[i];
      if (!v) continue;
      const w = this.#active[weakest];
      if (weakest < 0 || (w && v.priority < w.priority)) weakest = i;
    }
    const victim = this.#active[weakest];
    if (!victim || victim.priority >= priority) return false;
    this.#active.splice(weakest, 1);
    return true;
  }
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
