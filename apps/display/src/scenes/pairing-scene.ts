/**
 * PairingScene (T3.1) — the screen a player looks at before anything else.
 *
 * `layer-3-display-engine.md` §Latency & feel: "Show pairing state clearly (this
 * screen renders the QR the phone scans)."
 *
 * The QR encodes a **controller URL carrying `?room=`**, not the bare code —
 * see `../config.ts` for why. The code is also shown as text, because a QR is
 * useless to the second player standing behind the first, and because a scan
 * fails silently often enough that a typeable fallback is not optional.
 */

import type { Scene, SceneName } from '@wii/engine';
import { Group, Mesh, MeshBasicMaterial, TorusGeometry } from 'three';

import type { DisplayContext } from './context.js';
import { Subscriptions } from './context.js';
import { el } from '../ui/overlay.js';
import { renderQr } from '../ui/qr.js';

export class PairingScene implements Scene {
  readonly name = 'pairing' as const;

  readonly #ctx: DisplayContext;
  readonly #subs = new Subscriptions();
  readonly #group = new Group();
  readonly #ring: Mesh;

  /** Guards the async QR render against a scene change mid-flight. */
  #generation = 0;

  constructor(ctx: DisplayContext) {
    this.#ctx = ctx;
    this.#ring = new Mesh(
      new TorusGeometry(1.4, 0.02, 8, 128),
      new MeshBasicMaterial({ color: 0x2f6fed }),
    );
    this.#ring.position.set(0, 1, -1);
    this.#group.add(this.#ring);
  }

  enter(): void {
    const ctx = this.#ctx;
    const generation = ++this.#generation;

    ctx.stage.setContent(this.#group);
    ctx.overlay.setCenter(this.#buildPanel());
    this.#paintStatus();

    // Status repainting is edge-driven; the scene *transition* is not — see the
    // note in LobbyScene.update for why that distinction matters.
    this.#subs.add(ctx.client.onLinkState(() => this.#paintStatus()));
    this.#subs.add(ctx.client.onPresence(() => this.#paintStatus()));

    // The audio hint lives on *this* screen and no other. See `AudioManager`:
    // the browser will not let the page make a sound until someone touches this
    // machine, and after pairing nobody does — every later input arrives from the
    // phone over a socket, which grants no activation. This is the last moment a
    // player is looking at the display with nothing else to do, so it is the only
    // moment the ask is not an interruption.
    this.#subs.add(ctx.audio.onChange(() => this.#paintAudioHint()));
    this.#paintAudioHint();

    void this.#attachQr(generation);
  }

  exit(_to: SceneName): void {
    this.#generation++;
    this.#subs.clear();
    this.#ctx.overlay.setCenter(null);
  }

  update(dtSeconds: number): void {
    // A controller that is actually sending is the only signal worth advancing
    // on. `online` alone means the relay answered, which says nothing about
    // whether a phone is on the other end.
    if (this.#ctx.client.controllerPresent) {
      // Played on the way out rather than in the lobby's `enter`, because the
      // lobby is also entered from a finished round and a re-pair chime there
      // would be a lie.
      this.#ctx.audio.play('ui.paired');
      this.#ctx.scenes.tryGoTo('lobby');
      return;
    }

    // Motion for its own sake: a completely static screen reads as "crashed".
    this.#ring.rotation.z += dtSeconds * 0.35;
  }

  #buildPanel(): HTMLElement {
    const panel = el('div', 'panel');
    panel.append(
      el('div', 'panel-eyebrow', 'Scan to play'),
      el('div', 'qr-slot'),
      el('div', 'panel-label', 'or enter this code on your phone'),
      el('div', 'room-code', this.#ctx.room),
      el('div', 'panel-url', this.#ctx.controllerUrl),
      el('div', 'audio-hint'),
    );
    return panel;
  }

  /**
   * One line, and only when there is something to say.
   *
   * Three states worth distinguishing, because the fix differs: blocked wants a
   * click, muted wants a keypress, and working wants silence from the UI. The
   * muted line is shown too — a display that was muted last session persists that
   * (`AudioManager`), and "the sound is broken" is otherwise the obvious reading.
   */
  #paintAudioHint(): void {
    const slot = this.#ctx.overlay.center.querySelector('.audio-hint');
    if (!(slot instanceof HTMLElement)) return;
    const { audio } = this.#ctx;

    if (audio.muted) {
      slot.textContent = 'sound is muted · press M';
      slot.dataset['tone'] = 'muted';
    } else if (audio.blocked) {
      slot.textContent = 'click this screen once to enable sound';
      slot.dataset['tone'] = 'blocked';
    } else {
      slot.textContent = '';
      delete slot.dataset['tone'];
    }
  }

  async #attachQr(generation: number): Promise<void> {
    const slot = this.#ctx.overlay.center.querySelector('.qr-slot');
    if (!slot) return;
    try {
      const canvas = await renderQr(this.#ctx.controllerUrl);
      // The scene may have moved on while the QR was rendering. Appending it now
      // would drop a stale code onto whatever screen is current.
      if (generation !== this.#generation) return;
      slot.replaceChildren(canvas);
    } catch (err) {
      // A failed QR is a degraded pairing screen, not a broken one — the room
      // code beneath it still works, so say so rather than throwing.
      if (generation !== this.#generation) return;
      slot.replaceChildren(el('div', 'qr-failed', 'QR unavailable — use the code below'));
      console.warn('[display] QR render failed', err);
    }
  }

  #paintStatus(): void {
    const { client, overlay } = this.#ctx;
    if (client.controllerPresent) return overlay.setStatus('controller connected', 'good');
    switch (client.linkState) {
      case 'online':
        return overlay.setStatus(`waiting for a controller · room ${client.room ?? '—'}`, 'idle');
      case 'connecting':
        return overlay.setStatus('connecting to relay…', 'warn');
      default:
        return overlay.setStatus('relay offline', 'bad');
    }
  }
}
