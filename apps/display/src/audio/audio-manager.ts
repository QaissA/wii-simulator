/**
 * AudioManager — the display's speaker, and the one gotcha that owns this file.
 *
 * It is a thin thing: hold an `AudioContext`, hand cue requests to `AudioDirector`
 * for a yes/no, and render the ones that survive through `playVoice`. The policy
 * is in `packages/engine` where it is tested without a browser and the sound design
 * is in `cues.ts`, which leaves this file the part that genuinely needs a browser.
 *
 * ## Autoplay, and why this app has it worse than most
 *
 * Browsers start an `AudioContext` **suspended** until the page sees a user
 * gesture. Ordinarily that resolves itself — the player clicks something, audio
 * unlocks, nobody notices there was ever a rule.
 *
 * Not here. **This screen is not the thing the player touches.** They scan a QR
 * with a phone and every input after that arrives as a WebSocket frame, and a
 * WebSocket frame grants no user activation no matter how deliberate the gesture
 * behind it was. Tilt the phone, press A, play a whole round — the display sees a
 * network message each time and the context stays suspended. Left alone, the
 * failure mode is not an error anywhere; it is a laptop that is simply silent
 * forever, which reads as "the audio work does not function".
 *
 * So three things, none optional:
 *
 * 1. **Try to resume on any local gesture** — a click or a keypress on the display
 *    machine, which someone starting a session is very likely to do anyway.
 * 2. **Publish that we are blocked** (`blocked`), so the pairing scene can ask for
 *    the one click while the player is looking at the screen and waiting to scan
 *    rather than mid-round.
 * 3. **Never let it be an error.** A blocked context drops cues silently and the
 *    games carry on exactly as they did before there was any audio at all.
 *
 * The mute preference persists the way the grip does — this is a TV in a room, and
 * a display that comes back loud after being muted last night is a bad neighbour.
 */

import { AudioDirector } from '@wii/engine';

import { CUES, CUE_POLICIES } from './cues.js';
import type { CueName } from './cues.js';
import { playVoice } from './synth.js';

const STORAGE_KEY = 'wii.display.audio';

/** What a scene needs from the speaker. Games see exactly this too. */
export interface Audio {
  /**
   * Make a sound. `gainScale` varies this one instance — a combo growing louder,
   * a distant explosion — without inventing a second cue for it.
   *
   * Never throws and never awaits. A cue at a bad moment is a dropped cue.
   */
  play(cue: CueName, gainScale?: number): void;
  readonly muted: boolean;
  /** True when the browser has not yet let us make a sound. See the header. */
  readonly blocked: boolean;
  setMuted(muted: boolean): void;
  toggleMuted(): void;
  /** Drop held voices and throttle windows — called when a scene tears down. */
  reset(): void;
  /** Fires when `muted` or `blocked` changes, so a scene can repaint its hint. */
  onChange(fn: () => void): () => void;
}

export class AudioManager implements Audio {
  readonly #director: AudioDirector;
  readonly #listeners = new Set<() => void>();

  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #muted: boolean;
  #wasBlocked = true;

  constructor() {
    this.#muted = loadMuted();
    this.#director = new AudioDirector({
      policies: CUE_POLICIES,
      muted: this.#muted,
      // Eight overlapping voices is already a wall of sound through a laptop
      // speaker, which is what most of these will be played through.
      maxVoices: 8,
    });

    this.#open();
    this.#watchForGesture();
  }

  get muted(): boolean {
    return this.#muted;
  }

  get blocked(): boolean {
    return this.#ctx === null || this.#ctx.state !== 'running';
  }

  play(cue: CueName, gainScale = 1): void {
    const ctx = this.#ctx;
    const master = this.#master;
    // Checked before asking the director: a request that cannot be rendered must
    // not consume a polyphony slot or set a throttle window, or the first seconds
    // after unlocking would drop cues on behalf of sounds nobody heard.
    if (!ctx || !master || ctx.state !== 'running') return;

    const voice = this.#director.request(cue, performance.now(), gainScale);
    if (!voice) return;

    const spec = CUES[cue]?.voice;
    if (!spec) return;

    try {
      playVoice(ctx, master, spec, voice.gain);
    } catch {
      // A context can be closed or interrupted between the check above and here —
      // iOS does exactly this on an incoming call. Losing a sound effect is not
      // worth taking the game loop down for.
    }
  }

  setMuted(muted: boolean): void {
    if (muted === this.#muted) return;
    this.#muted = muted;
    this.#director.setMuted(muted);
    saveMuted(muted);

    // Unmuting is also a plausible moment to have earned a gesture, since the key
    // that did it *is* one.
    if (!muted) void this.#resume();
    this.#emit(true);
  }

  toggleMuted(): void {
    this.setMuted(!this.#muted);
  }

  reset(): void {
    this.#director.reset();
  }

  onChange(fn: () => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Mixing counters, for the browser check and for a debug readout. */
  get stats(): Readonly<Record<string, number>> {
    return { ...this.#director.stats };
  }

  /* ------------------------------------------------------------- internals */

  #open(): void {
    try {
      this.#ctx = new AudioContext();
    } catch {
      // No WebAudio at all. Every `play` becomes a no-op and nothing above this
      // file needs to know.
      return;
    }

    this.#master = this.#ctx.createGain();
    this.#master.gain.value = 1;

    // A limiter on the way out. `AudioDirector`'s cap keeps the *count* of voices
    // sane, but eight legitimate voices with loud envelopes can still sum past
    // full scale, and digital clipping is a click rather than a loud sound. The
    // high ratio and fast attack make this a safety net, not an effect: at
    // ordinary levels it never engages.
    const limiter = this.#ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;

    this.#master.connect(limiter).connect(this.#ctx.destination);

    // Some browsers will honour this immediately (a reload can carry activation
    // forward); most will not, and that is what the gesture listeners are for.
    void this.#resume();
  }

  #watchForGesture(): void {
    const attempt = (): void => {
      void this.#resume();
    };
    // `pointerdown` rather than `click`: a click that starts and ends on the
    // canvas still counts, but pointerdown fires earlier and covers touch on a
    // display that happens to be a touchscreen.
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(type, attempt, { passive: true });
    }
    // A tab restored from the background can come back with a suspended context
    // even though it was running before, and there is no gesture on the way in.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') attempt();
    });
  }

  async #resume(): Promise<void> {
    const ctx = this.#ctx;
    if (!ctx || ctx.state === 'running') return;
    try {
      await ctx.resume();
    } catch {
      // Still no activation. Try again on the next gesture.
    }
    this.#emit();
  }

  /**
   * Tell the scenes something changed.
   *
   * `#resume` runs on every local gesture and almost none of them change
   * anything, so an unconditional emit would repaint DOM on every keystroke.
   * `force` is for mute, whose change the `blocked` comparison cannot see.
   */
  #emit(force = false): void {
    const blocked = this.blocked;
    if (!force && blocked === this.#wasBlocked) return;
    this.#wasBlocked = blocked;
    for (const fn of [...this.#listeners]) fn();
  }
}

/**
 * Bind the display's audio keys.
 *
 * `M` only, and deliberately so — `docs/running.md` already documents X/Y/R for
 * grip, and every extra key is one more thing to remember at a party. Volume is
 * the operating system's job, which it does better and which players already know.
 */
export function bindAudioKeys(audio: Audio): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    audio.toggleMuted();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

function loadMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'muted';
  } catch {
    return false;
  }
}

function saveMuted(muted: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, muted ? 'muted' : 'on');
  } catch {
    /* private mode — the preference just will not survive a reload */
  }
}
