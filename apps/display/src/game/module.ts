/**
 * The seam every game plugs into (T3.6).
 *
 * `docs/layer-3-display-engine.md` §Gotchas: "Keep the InputAdapter's mapping
 * data-driven so new games don't require netcode changes." A `GameModule` is
 * what that promise buys — a game is a mapping literal plus a scene, and adding
 * one touches nothing below this file.
 *
 * The interface is deliberately thin, and it is meant to stay that way until
 * there are three games to generalise from. `docs/implementation-plan.md`
 * §Phase 3c: "the second and third games are what reveal what actually wants to
 * be shared, and anything abstracted before then is a guess."
 *
 * The one rule with teeth: **a game reads abstract actions and axes, never wire
 * fields.** It asks whether `"flap"` fired, not whether a gesture named `swing`
 * arrived on an accelerometer. A game that needs to know where an action came
 * from has breached the seam, and that is worth fixing rather than working
 * around.
 */

import type { InputAdapter, InputMapping } from '@wii/engine';
import type { Camera } from 'three';

import type { Audio } from '../audio/audio-manager.js';
import type { DisplayClient } from '../net/display-client.js';
import type { Stage } from '../render/stage.js';
import type { Overlay } from '../ui/overlay.js';

/** What a finished round reports back. */
export interface GameResult {
  score: number;
  /** One line under the score — "3 pipes", "sliced 14". Optional. */
  detail?: string;
  /**
   * This round beat the stored best.
   *
   * The game is the only thing that can know — each one keeps its own best in
   * `localStorage` under its own key — and the results screen is the only thing
   * that can *say so*. Reported rather than announced, so the celebration stays a
   * presentation decision made in one place instead of four.
   */
  record?: boolean;
}

/** Everything a running game is handed. */
export interface GameContext {
  stage: Stage;
  overlay: Overlay;
  input: InputAdapter;
  /**
   * The speaker. A game asks for a named cue — `audio.play('slice')` — and the
   * sound design lives in `audio/cues.ts`.
   *
   * The same rule as the one above, applied to output: **a game names what
   * happened, never what it should sound like.** A game reaching past this for an
   * oscillator has breached the seam exactly as one reading `btn` directly would
   * have, and the cost is the same — the sound design stops being one file you
   * can balance and starts being four you have to hunt through.
   *
   * `play` never throws and never blocks. If the browser has not unlocked audio
   * yet (see `AudioManager` — on this display it frequently has not, because the
   * player is touching a phone rather than the screen) the call is a no-op, and
   * a game must play identically with the sound off.
   */
  audio: Audio;
  /** For frame age and link state — a game should rarely need this. */
  client: DisplayClient;
  /** Call once when the round ends; the host moves to the results scene. */
  end(result: GameResult): void;
  /**
   * Current grip adjustment, as a short label for a HUD row.
   *
   * Temporary, and deliberately narrow: games get to *display* it, never to act
   * on it. It disappears with the rest of the workaround at T1.7 — see
   * `input/grip.ts`.
   */
  gripLabel(): string;
}

/** A game in progress. Lifecycle mirrors `Scene`, which is not an accident. */
export interface GameInstance {
  enter(): void;
  exit(): void;
  /** Fixed-step simulation. `dt` is always exactly the step, in seconds. */
  update(dtSeconds: number, simTimeMs: number): void;
  /** `alpha` is 0..1 — how far between the last two sim states we are. */
  render(alpha: number): void;
  /**
   * Camera to render with. Returning `undefined` keeps the stage's default
   * perspective camera — right for anything 3D. A 2D game supplies its own
   * orthographic one rather than fighting perspective.
   */
  camera?(): Camera | undefined;
}

export interface GameModule {
  /** Stable identifier — used in URLs and saved state, so do not rename it. */
  readonly id: string;
  readonly title: string;
  /** One line, shown under the title in the menu. */
  readonly blurb: string;
  /**
   * How this game wants the controller mapped.
   *
   * The whole point of the seam: the mapping travels with the game, so adding
   * one is a literal here rather than a change to input handling.
   */
  readonly mapping: InputMapping;
  /** How the player is expected to hold the phone. Shown in the menu. */
  readonly grip?: string;
  create(ctx: GameContext): GameInstance;
}
