/**
 * LobbyScene — pick a game.
 *
 * The lobby used to be a single "press A" beat. With more than one game it
 * becomes the menu, which is the natural home for it: the `SceneManager` already
 * declared `lobby → play` legal, and a chooser between "a controller is here"
 * and "a game is running" is exactly what that edge was for.
 *
 * Selection is driven from the phone, because the phone is the only input device
 * a player has. Tilt highlights, A confirms. The display's arrow keys do the same
 * thing for anyone debugging without a phone in hand.
 */

import type { ActionEvent, Scene, SceneName } from '@wii/engine';
import { Group, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';

import { GAMES } from '../game/registry.js';
import { applyGrip } from '../input/grip.js';
import { MENU_MAPPING } from '../input/mappings.js';
import { el } from '../ui/overlay.js';
import type { DisplayContext } from './context.js';
import { Subscriptions } from './context.js';

/**
 * How far the stick must travel before the highlight moves, and how far it must
 * return before it can move again.
 *
 * A continuous axis driving a discrete list needs a Schmitt trigger, or the
 * highlight races through the menu while the player is still tilting. The
 * re-arm threshold is deliberately well inside the fire threshold.
 */
const STEP_AT = 0.55;
const REARM_AT = 0.3;

export class LobbyScene implements Scene {
  readonly name = 'lobby' as const;

  readonly #ctx: DisplayContext;
  readonly #subs = new Subscriptions();
  readonly #group = new Group();
  readonly #pip: Mesh;

  #index = 0;
  #armed = true;
  #pulse = 0;

  constructor(ctx: DisplayContext) {
    this.#ctx = ctx;
    this.#pip = new Mesh(
      new SphereGeometry(0.22, 32, 16),
      new MeshBasicMaterial({ color: 0x35d07f }),
    );
    this.#pip.position.set(0, 1, 0);
    this.#group.add(this.#pip);
  }

  enter(): void {
    const ctx = this.#ctx;
    ctx.stage.setContent(this.#group);
    ctx.overlay.setHud([]);

    // The menu has its own mapping — one axis and one button. A game's mapping
    // is installed by PlayScene, so nothing here depends on what was played last.
    ctx.input.setMapping(applyGrip(MENU_MAPPING, ctx.grip()));

    this.#paint();

    this.#subs.add(ctx.input.onAction((e: ActionEvent) => this.#onAction(e)));

    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') this.#move(-1);
      else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') this.#move(1);
      else if (e.key === 'Enter') this.#start();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    this.#subs.add(() => window.removeEventListener('keydown', onKey));

    this.#subs.add(ctx.onGripChange(() => this.#paint()));
  }

  exit(_to: SceneName): void {
    this.#subs.clear();
    this.#ctx.overlay.setCenter(null);
  }

  update(dtSeconds: number): void {
    const ctx = this.#ctx;

    // A guard, not an event — this scene is entered *because* presence changed,
    // so the edge is already gone by the time `enter` could subscribe.
    if (!ctx.client.controllerPresent) {
      ctx.audio.play('ui.dropped');
      ctx.scenes.tryGoTo('pairing');
      return;
    }

    // Tilt-to-highlight, with a re-arm so one tilt is one step.
    const x = ctx.input.axis('menu.x');
    if (this.#armed && Math.abs(x) > STEP_AT) {
      this.#move(x > 0 ? 1 : -1);
      this.#armed = false;
    } else if (!this.#armed && Math.abs(x) < REARM_AT) {
      this.#armed = true;
    }

    this.#pulse += dtSeconds * 2.4;
    this.#pip.scale.setScalar(1 + Math.sin(this.#pulse) * 0.08);
  }

  #onAction(e: ActionEvent): void {
    // `ended` would let the release of the button that *entered* this scene
    // immediately start a game.
    if (e.phase === 'ended') return;
    if (e.action === 'confirm') this.#start();
  }

  #move(delta: number): void {
    const next = (this.#index + delta + GAMES.length) % GAMES.length;
    if (next === this.#index) return;
    this.#index = next;
    this.#ctx.audio.play('ui.move');
    this.#paint();
  }

  #start(): void {
    const game = GAMES[this.#index];
    if (!game) return;
    this.#ctx.audio.play('ui.confirm');
    this.#ctx.play.select(game);
    this.#ctx.scenes.tryGoTo('play');
  }

  #paint(): void {
    const ctx = this.#ctx;
    const panel = el('div', 'panel');
    panel.append(el('div', 'panel-eyebrow', 'Controller connected'));

    const list = el('div', 'game-list');
    GAMES.forEach((game, i) => {
      const row = el('div', 'game-row');
      if (i === this.#index) row.dataset['selected'] = 'true';
      row.append(el('div', 'game-title', game.title), el('div', 'game-blurb', game.blurb));
      if (game.grip) row.append(el('div', 'game-grip', game.grip));
      list.append(row);
    });
    panel.append(list, el('div', 'panel-label', 'tilt to choose · A to start'));

    ctx.overlay.setCenter(panel);
    ctx.overlay.setStatus('ready', 'good');
  }
}
