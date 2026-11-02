/**
 * What every scene is handed.
 *
 * A plain object rather than a base class, so a scene stays a small module that
 * implements `Scene` from `@wii/engine` and nothing more. The engine's
 * `SceneManager` owns lifecycle; this owns the wiring a scene needs to do its
 * job.
 */

import type { InputAdapter, SceneManager } from '@wii/engine';
import type { RoomCode } from '@wii/protocol';

import type { Audio } from '../audio/audio-manager.js';
import type { Grip } from '../input/grip.js';
import type { DisplayClient } from '../net/display-client.js';
import type { Stage } from '../render/stage.js';
import type { Overlay } from '../ui/overlay.js';
import type { PlayScene } from './play-scene.js';

export interface DisplayContext {
  stage: Stage;
  overlay: Overlay;
  client: DisplayClient;
  input: InputAdapter;
  scenes: SceneManager;
  /** The speaker. Shared with every game — see `GameContext.audio`. */
  audio: Audio;
  /** The code the phone must enter or scan. Fixed for the page's lifetime. */
  room: RoomCode;
  /** URL encoded into the pairing QR. */
  controllerUrl: string;
  /**
   * The play scene, reachable by name because the lobby has to hand it a choice
   * and the results scene has to read what that choice scored. The alternative —
   * threading selection through `SceneManager` — would teach the engine about
   * games, which is exactly the coupling `packages/engine` exists to avoid.
   */
  play: PlayScene;
  /** Current grip adjustment. Temporary; removed with T1.7. */
  grip(): Grip;
  /** Fires when the grip keys change it, so scenes can re-apply their mapping. */
  onGripChange(fn: () => void): () => void;
}

/** Collects unsubscribe handles so a scene's `exit` is a single call. */
export class Subscriptions {
  readonly #handles: Array<() => void> = [];

  add(unsubscribe: () => void): void {
    this.#handles.push(unsubscribe);
  }

  clear(): void {
    // Reverse order, so a later subscription that depends on an earlier one is
    // torn down first — the same reason destructors unwind in reverse.
    while (this.#handles.length) this.#handles.pop()?.();
  }
}
