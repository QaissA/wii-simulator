/**
 * ResultsScene — what happened, and what next.
 *
 * `SceneManager` has declared `play → results` legal since T3.3; this is the
 * first thing to use it. Both onward edges it allows are offered: A plays the
 * same game again, B returns to the menu. Nothing else is reachable from here,
 * which is deliberate — a results screen that can wander back into a torn-down
 * game is the failure the transition table exists to prevent.
 */

import type { ActionEvent, Scene, SceneName } from '@wii/engine';
import { Group, Mesh, MeshBasicMaterial, TorusGeometry } from 'three';

import { applyGrip } from '../input/grip.js';
import { MENU_MAPPING } from '../input/mappings.js';
import { el } from '../ui/overlay.js';
import type { DisplayContext } from './context.js';
import { Subscriptions } from './context.js';

export class ResultsScene implements Scene {
  readonly name = 'results' as const;

  readonly #ctx: DisplayContext;
  readonly #subs = new Subscriptions();
  readonly #group = new Group();
  readonly #ring: Mesh;

  constructor(ctx: DisplayContext) {
    this.#ctx = ctx;
    this.#ring = new Mesh(
      new TorusGeometry(1.5, 0.02, 8, 128),
      new MeshBasicMaterial({ color: 0x35d07f }),
    );
    this.#ring.position.set(0, 1, -1);
    this.#group.add(this.#ring);
  }

  enter(): void {
    const ctx = this.#ctx;
    ctx.stage.setContent(this.#group);
    ctx.overlay.setHud([]);
    ctx.input.setMapping(applyGrip(MENU_MAPPING, ctx.grip()));

    const result = ctx.play.result;
    const module = ctx.play.module;

    const panel = el('div', 'panel');
    panel.append(
      el('div', 'panel-eyebrow', module ? module.title : 'Round over'),
      el('div', 'score', result ? String(result.score) : '—'),
    );
    if (result?.record) panel.append(el('div', 'panel-record', 'new best'));
    if (result?.detail) panel.append(el('div', 'panel-label', result.detail));
    panel.append(el('div', 'panel-label', 'A to play again · B for the menu'));
    ctx.overlay.setCenter(panel);
    ctx.overlay.setStatus('round over', 'good');

    // One or the other, never both: a fanfare landing on top of a descending
    // game-over reads as a bug in the sound rather than as good news.
    ctx.audio.play(result?.record ? 'ui.record' : 'game.over');

    this.#subs.add(ctx.input.onAction((e: ActionEvent) => this.#onAction(e)));

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') ctx.scenes.tryGoTo('play');
      else if (e.key === 'Escape') ctx.scenes.tryGoTo('lobby');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    this.#subs.add(() => window.removeEventListener('keydown', onKey));
  }

  exit(_to: SceneName): void {
    this.#subs.clear();
    this.#ctx.overlay.setCenter(null);
  }

  update(dtSeconds: number): void {
    if (!this.#ctx.client.controllerPresent) {
      // `results → lobby` is legal; `results → pairing` is not, and the lobby
      // will forward to pairing on its own next step.
      this.#ctx.scenes.tryGoTo('lobby');
      return;
    }
    this.#ring.rotation.z += dtSeconds * 0.35;
  }

  #onAction(e: ActionEvent): void {
    if (e.phase === 'ended') return;
    if (e.action === 'confirm') {
      this.#ctx.audio.play('ui.confirm');
      this.#ctx.scenes.tryGoTo('play');
    } else if (e.action === 'quit') {
      this.#ctx.audio.play('ui.back');
      this.#ctx.scenes.tryGoTo('lobby');
    }
  }
}
