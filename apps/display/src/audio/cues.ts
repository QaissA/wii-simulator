/**
 * The cue table — every sound this project makes, in one file.
 *
 * The deliberate parallel is `input/mappings.ts`. A mapping says *"the action
 * called `flap` is what button A means"*; a cue says *"the sound called `flap` is
 * a 70 ms rising triangle"*. In both cases the game names something abstract and
 * this layer decides what it is, which is the T3.6 seam rule applied to output:
 * **a game asks for `'slice'`, never for a bandpass sweep.** A game reaching for
 * `playVoice` directly has breached the seam the same way one reading `btn`
 * directly would have.
 *
 * Keeping every cue here rather than beside its game buys the thing a scattered
 * sound design cannot have: **balance**. Whether an explosion should sit above a
 * slice is a judgement about the two of them together, and it can only be made
 * where both are visible. It is also the file to open when tuning: the sounds are
 * data, so changing how the game feels to listen to never means changing a game.
 *
 * `CueName` is derived from this table, so a game asking for a cue that does not
 * exist is a **compile error**, not a silence discovered on a TV. That is the
 * whole reason the table is `satisfies` rather than a typed constant — the exact
 * keys survive into the type.
 */

import type { CuePolicy } from '@wii/engine';

import type { VoiceSpec } from './synth.js';

export interface Cue {
  voice: VoiceSpec;
  policy?: CuePolicy;
}

/**
 * Priority bands, so the numbers below mean something.
 *
 * Under the polyphony cap a cue survives by outranking what is already sounding
 * (see `AudioDirector`). The ranks are grouped rather than assigned one by one
 * because the question is always "does this matter more than incidental noise",
 * never "is this a 4 or a 5".
 */
const AMBIENT = 0; // shots, footsteps — pleasant, individually worthless
const FEEDBACK = 2; // this hit, this scored — the loop's own rhythm
const IMPORTANT = 5; // a life gone, a wave cleared — state the player tracks
const CRITICAL = 8; // the round ended — never dropped, whatever else is playing

export const CUES = {
  /* ------------------------------------------------------------------- ui */

  /**
   * The menu highlight moving.
   *
   * Throttled hard, and this is the one place the reason is visible in the input
   * rather than the mix: the lobby's Schmitt trigger fires off a *continuous*
   * tilt axis, so a player resting near the threshold produces a stream of steps.
   * The trigger stops the highlight racing; this stops the sound machine-gunning.
   */
  'ui.move': {
    voice: { kind: 'blip', freq: 440, toFreq: 560, duration: 0.045, wave: 'square', gain: 0.22 },
    policy: { minIntervalMs: 70, holdMs: 60, priority: FEEDBACK },
  },
  'ui.confirm': {
    voice: { kind: 'chord', freq: 523.25, ratios: [1, 1.5], duration: 0.16, stagger: 0.045 },
    policy: { gain: 0.5, holdMs: 220, priority: IMPORTANT },
  },
  'ui.back': {
    voice: { kind: 'blip', freq: 420, toFreq: 260, duration: 0.13, wave: 'triangle' },
    policy: { gain: 0.45, holdMs: 150, priority: FEEDBACK },
  },
  /**
   * A controller paired. A rising major triad, because this is the moment the
   * whole pairing dance either worked or did not, and it is frequently heard from
   * across the room by someone looking at a phone rather than at the screen.
   */
  'ui.paired': {
    voice: {
      kind: 'chord',
      freq: 392,
      ratios: [1, 1.26, 1.5],
      duration: 0.34,
      stagger: 0.075,
      wave: 'triangle',
    },
    policy: { gain: 0.6, holdMs: 520, priority: CRITICAL },
  },
  /** The mirror of it: falling, so a drop is unmistakable without reading the HUD. */
  'ui.dropped': {
    voice: { kind: 'blip', freq: 330, toFreq: 150, duration: 0.38, wave: 'triangle' },
    policy: { gain: 0.55, holdMs: 420, priority: CRITICAL },
  },
  /** A new personal best. The only cue in the table allowed to sound triumphant. */
  'ui.record': {
    voice: {
      kind: 'chord',
      freq: 523.25,
      ratios: [1, 1.26, 1.5, 2],
      duration: 0.42,
      stagger: 0.085,
      wave: 'triangle',
    },
    policy: { gain: 0.7, holdMs: 750, priority: CRITICAL },
  },

  /* ----------------------------------------------------------------- round */

  'game.start': {
    voice: { kind: 'chord', freq: 330, ratios: [1, 2], duration: 0.2, stagger: 0.06 },
    policy: { gain: 0.5, holdMs: 280, priority: CRITICAL },
  },
  /**
   * A descending triad — ratios below 1, which is what makes it fall. Ranked
   * `CRITICAL` for the reason the director's eviction rule exists at all: this
   * fires at the exact moment the screen is busiest, and it is the one sound the
   * player is actually waiting for.
   */
  'game.over': {
    voice: {
      kind: 'chord',
      freq: 330,
      ratios: [1, 0.84, 0.63],
      duration: 0.5,
      stagger: 0.13,
      wave: 'triangle',
    },
    policy: { gain: 0.65, holdMs: 900, priority: CRITICAL },
  },

  /**
   * A gesture reached the display, in the debug cursor.
   *
   * Not decoration. Every on-device session starts in this game, and the whole
   * point of a tuning pass is that the tester is looking at the *phone* — at how
   * hard they swung — while the confirmation is on a screen across the room.
   * A ping is the only way to read both at once.
   */
  'debug.gesture': {
    voice: { kind: 'blip', freq: 760, toFreq: 1140, duration: 0.08, wave: 'square' },
    policy: { gain: 0.4, minIntervalMs: 60, holdMs: 100, priority: FEEDBACK },
  },

  /* --------------------------------------------------------------- flappy */

  /**
   * The flap.
   *
   * §Phase 3c calls flappy the project's latency instrument: "if the flap lands a
   * frame after the tap, the gap you aimed for is the gap you clip." A sound with
   * a slow attack would blunt exactly that, so this is short, tonal and sharp —
   * the ear locates a click far more precisely than it locates a whoosh, which
   * makes this cue a genuine part of the measurement rather than decoration.
   */
  flap: {
    voice: { kind: 'blip', freq: 640, toFreq: 980, duration: 0.07, wave: 'triangle' },
    policy: { gain: 0.5, minIntervalMs: 40, holdMs: 90, priority: FEEDBACK },
  },
  'flappy.pass': {
    voice: { kind: 'blip', freq: 880, toFreq: 1320, duration: 0.09 },
    policy: { gain: 0.35, holdMs: 110, priority: FEEDBACK },
  },
  'flappy.crash': {
    voice: { kind: 'noise', duration: 0.45, freq: 900, toFreq: 90, filter: 'lowpass', q: 1 },
    policy: { gain: 0.85, holdMs: 480, priority: IMPORTANT },
  },

  /* ---------------------------------------------------------- fruit slash */

  /**
   * The blade through a fruit. High, brief and airy — a *swish*, not a *thunk*.
   *
   * The throttle is the tightest in the table because one stroke sample can cut
   * several fruit in the same simulation step, and four identical swishes summed
   * inside a millisecond is not four slices: it is one flangey slice, which is
   * precisely the artefact `AudioDirector`'s throttle exists to prevent.
   */
  slice: {
    voice: { kind: 'noise', duration: 0.13, freq: 2800, toFreq: 900, filter: 'highpass', q: 0.8 },
    policy: { gain: 0.55, minIntervalMs: 45, holdMs: 150, priority: FEEDBACK },
  },
  'slice.combo': {
    voice: { kind: 'chord', freq: 660, ratios: [1, 1.5, 2], duration: 0.22, stagger: 0.05 },
    policy: { gain: 0.6, holdMs: 340, priority: IMPORTANT },
  },
  /** A bomb ends the round instantly, so it gets the biggest sound in the game. */
  'slice.bomb': {
    voice: { kind: 'noise', duration: 0.7, freq: 700, toFreq: 55, filter: 'lowpass', q: 1.1 },
    policy: { gain: 1, holdMs: 750, priority: CRITICAL },
  },
  'life.lost': {
    voice: { kind: 'blip', freq: 320, toFreq: 170, duration: 0.3, wave: 'triangle' },
    policy: { gain: 0.7, holdMs: 340, priority: IMPORTANT },
  },

  /* ---------------------------------------------------------- star fighter */

  /**
   * The ship's gun, and the quietest cue in the table by a distance.
   *
   * It fires roughly four times a second for the length of a round. Anything that
   * sounds good once at full volume is exhausting by the second wave, and the
   * usual mistake is mixing it at the level it wants in isolation.
   */
  shoot: {
    voice: { kind: 'blip', freq: 900, toFreq: 420, duration: 0.055, wave: 'square' },
    policy: { gain: 0.2, minIntervalMs: 55, holdMs: 70, priority: AMBIENT },
  },
  explode: {
    voice: { kind: 'noise', duration: 0.34, freq: 1400, toFreq: 140, filter: 'lowpass', q: 0.9 },
    policy: { gain: 0.75, minIntervalMs: 40, holdMs: 360, priority: FEEDBACK },
  },
  pickup: {
    voice: { kind: 'chord', freq: 700, ratios: [1, 1.5, 2], duration: 0.16, stagger: 0.045 },
    policy: { gain: 0.55, holdMs: 260, priority: IMPORTANT },
  },
  /** The smart bomb. Long, low, and allowed to eclipse the wave it is destroying. */
  'bomb.use': {
    voice: { kind: 'noise', duration: 0.8, freq: 2000, toFreq: 70, filter: 'lowpass', q: 1.2 },
    policy: { gain: 1, holdMs: 850, priority: CRITICAL },
  },
  'wave.clear': {
    voice: {
      kind: 'chord',
      freq: 440,
      ratios: [1, 1.25, 1.5, 2],
      duration: 0.4,
      stagger: 0.09,
      wave: 'triangle',
    },
    policy: { gain: 0.6, holdMs: 720, priority: IMPORTANT },
  },
  'ship.hit': {
    voice: { kind: 'noise', duration: 0.42, freq: 420, toFreq: 110, filter: 'bandpass', q: 2 },
    policy: { gain: 0.9, holdMs: 460, priority: IMPORTANT },
  },
} as const satisfies Record<string, Cue>;

/**
 * Every sound a game may ask for.
 *
 * Derived from the table above rather than written out, so the two cannot drift
 * and a typo in a game is caught by `tsc` instead of by a quiet evening.
 */
export type CueName = keyof typeof CUES;

/** The policies, in the shape `AudioDirector` wants them. */
export const CUE_POLICIES: Readonly<Record<string, CuePolicy>> = Object.fromEntries(
  Object.entries(CUES).map(([name, cue]) => [name, cue.policy ?? {}]),
);
