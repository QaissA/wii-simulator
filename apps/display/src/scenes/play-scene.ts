/**
 * PlayScene — the host a `GameModule` runs inside.
 *
 * It owns everything that is true of *every* game and nothing that is true of
 * any particular one: install the game's mapping, swap the camera, forward the
 * loop, handle quitting, and turn a finished round into a results transition.
 *
 * The whole file is short, and that is the point. If hosting a game ever needs
 * to know which game it is hosting, the seam has sprung a leak.
 */

import type { Scene, SceneName } from '@wii/engine';

import { applyGrip, gripLabel } from '../input/grip.js';
import type { GameInstance, GameModule, GameResult } from '../game/module.js';
import type { DisplayContext } from './context.js';
import { Subscriptions } from './context.js';

export class PlayScene implements Scene {
  readonly name = 'play' as const;

  readonly #subs = new Subscriptions();

  #ctx: DisplayContext | null = null;
  #module: GameModule | null = null;
  #game: GameInstance | null = null;
  #result: GameResult | null = null;

  /**
   * Handed the context after construction, because the context contains this
   * scene: the lobby has to hand it a chosen game and the results scene has to
   * read what that game scored.
   *
   * A two-step is honest about the cycle. The alternative — passing a
   * half-built context into the constructor — leaves a window where the fields
   * exist but are undefined, and nothing marks which ones.
   */
  attach(ctx: DisplayContext): void {
    this.#ctx = ctx;
  }

  #require(): DisplayContext {
    if (!this.#ctx) throw new Error('PlayScene used before attach()');
    return this.#ctx;
  }

  /** Chosen in the lobby, read here on entry. */
  get module(): GameModule | null {
    return this.#module;
  }

  select(module: GameModule): void {
    this.#module = module;
  }

  /** What the finished round scored. Read by the results scene. */
  get result(): GameResult | null {
    return this.#result;
  }

  enter(): void {
    const ctx = this.#require();
    const module = this.#module;
    if (!module) {
      // Nothing chosen — refuse rather than render an empty stage.
      ctx.scenes.tryGoTo('lobby');
      return;
    }

    this.#result = null;

    // The game's own mapping, with the grip adjustment folded in. The game never
    // sees the adjustment; it asks for `aim.x` and gets whatever is correct for
    // how this player holds the phone.
    ctx.input.setMapping(applyGrip(module.mapping, ctx.grip()));

    this.#game = module.create({
      stage: ctx.stage,
      overlay: ctx.overlay,
      input: ctx.input,
      client: ctx.client,
      audio: ctx.audio,
      end: (result) => this.#finish(result),
      gripLabel: () => gripLabel(ctx.grip()),
    });

    ctx.overlay.setCenter(null);
    ctx.stage.setCamera(this.#game.camera?.() ?? null);
    this.#game.enter();
    ctx.audio.play('game.start');

    // Re-applied whenever the grip keys change, so an adjustment takes effect
    // mid-game rather than on the next round.
    this.#subs.add(
      ctx.onGripChange(() => {
        ctx.input.setMapping(applyGrip(module.mapping, ctx.grip()));
      }),
    );

    // Quitting is a game-independent concern, so it lives here rather than being
    // reimplemented — and forgotten — in each game.
    this.#subs.add(
      ctx.input.onAction((e) => {
        if (e.phase !== 'started') return;
        if (e.action === 'quit') {
          ctx.audio.play('ui.back');
          ctx.scenes.tryGoTo('lobby');
        }
      }),
    );

    this.#subs.add(
      ctx.client.onPresence((present) => {
        // Checked as an event *and* as a guard below: the event covers a drop
        // during play, the guard covers one that happened before this scene
        // could subscribe.
        if (!present) {
          ctx.audio.play('ui.dropped');
          ctx.scenes.tryGoTo('lobby');
        }
      }),
    );
  }

  exit(_to: SceneName): void {
    this.#subs.clear();
    this.#game?.exit();
    this.#game = null;
    const ctx = this.#require();
    ctx.stage.setCamera(null);
    // Full headroom for whatever comes next, and no cue still inside a throttle
    // window it entered during a round that is now over.
    ctx.audio.reset();
  }

  update(dtSeconds: number, simTimeMs: number): void {
    if (!this.#require().client.controllerPresent) {
      this.#require().scenes.tryGoTo('lobby');
      return;
    }
    this.#game?.update(dtSeconds, simTimeMs);
  }

  render(alpha: number): void {
    this.#game?.render(alpha);
  }

  #finish(result: GameResult): void {
    // A game may call `end` from inside its own update; deferring the transition
    // keeps the scene from being torn down while it is still running.
    if (this.#result) return;
    this.#result = result;
    queueMicrotask(() => this.#require().scenes.tryGoTo('results'));
  }
}
