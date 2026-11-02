/**
 * Layer 3 display — entry point.
 *
 * The wiring is deliberately flat, and the order below is the architecture from
 * `layer-3-display-engine.md` §Architecture read left to right:
 *
 *   network frames → InputAdapter → GameLoop(fixed update) → Renderer(interpolated)
 *
 * Everything with a decision in it lives in `packages/engine` and is already
 * tested without a browser, or in `src/game/` behind the T3.6 seam. What is left
 * here is the part that could not be either: creating a WebGL context, driving
 * requestAnimationFrame, and putting pixels on a screen.
 */

import { GameLoop, InputAdapter, SceneManager } from '@wii/engine';
import { generateRoomCode } from '@wii/protocol';

import { AudioManager, bindAudioKeys } from './audio/audio-manager.js';
import { controllerUrlFor, relayUrlFor, roomFromUrl } from './config.js';
import { bindGripKeys, loadGrip } from './input/grip.js';
import type { Grip } from './input/grip.js';
import { DisplayClient } from './net/display-client.js';
import { Stage } from './render/stage.js';
import { Overlay } from './ui/overlay.js';
import { LobbyScene } from './scenes/lobby-scene.js';
import { PairingScene } from './scenes/pairing-scene.js';
import { PlayScene } from './scenes/play-scene.js';
import { ResultsScene } from './scenes/results-scene.js';
import type { DisplayContext } from './scenes/context.js';

function boot(): void {
  const canvas = document.getElementById('stage');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('missing <canvas id="stage">');

  // A pinned `?room=` survives a reload, which during development is the
  // difference between re-scanning the QR on every save and not.
  const room = roomFromUrl() ?? generateRoomCode();

  const stage = new Stage(canvas);
  const overlay = new Overlay();
  const client = new DisplayClient({ url: relayUrlFor() });
  const input = new InputAdapter();
  const scenes = new SceneManager();
  const audio = new AudioManager();

  let grip: Grip = loadGrip();
  const gripListeners = new Set<() => void>();

  const play = new PlayScene();

  const ctx: DisplayContext = {
    stage,
    overlay,
    client,
    input,
    scenes,
    audio,
    room,
    controllerUrl: controllerUrlFor(room),
    play,
    grip: () => grip,
    onGripChange: (fn) => {
      gripListeners.add(fn);
      return () => gripListeners.delete(fn);
    },
  };

  // PlayScene is part of the context it needs — see PlayScene.attach.
  play.attach(ctx);

  scenes.register(new PairingScene(ctx));
  scenes.register(new LobbyScene(ctx));
  scenes.register(play);
  scenes.register(new ResultsScene(ctx));

  // One ingest point for the whole app. Scenes subscribe to what the adapter
  // produced; none of them decodes a wire message itself, which is what keeps
  // `InputAdapter` the single seam T3.2 was designed to be.
  client.onMessage((msg) => input.apply(msg));

  client.onLinkState((state, detail) => {
    if (state !== 'online') console.info(`[display] link ${state}${detail ? `: ${detail}` : ''}`);
  });

  // Grip keys are global rather than per-scene: the adjustment applies to
  // whatever is on screen, and a player finding it mid-game should not have to
  // back out to the menu to keep it.
  bindGripKeys(
    () => grip,
    (next) => {
      grip = next;
      for (const fn of [...gripListeners]) fn();
    },
  );

  // M mutes, for the same reason: whoever reaches for it is not going to back out
  // of a round first.
  bindAudioKeys(audio);

  // A debug surface, matching the one the controller exposes as `window.__e2e`.
  // `tools/display-check` asserts against it that cues actually fired during a
  // round — a screenshot cannot show that a sound happened, and neither can a
  // typecheck, so without this the whole audio layer is unverified code of
  // exactly the kind §Outstanding for 3b warns about shipping.
  Object.defineProperty(window, '__audio', {
    value: {
      stats: () => audio.stats,
      muted: () => audio.muted,
      blocked: () => audio.blocked,
    },
    configurable: true,
  });

  const loop = new GameLoop({
    update: (dt, simTimeMs) => {
      client.poll();
      scenes.update(dt, simTimeMs);
    },
    render: (alpha) => {
      scenes.render(alpha);
      stage.render();
    },
  });

  // The rAF timestamp, not `Date.now()`: the simulation needs a monotonic clock
  // that cannot jump backwards when the system clock is corrected mid-match.
  // Frame *age* deliberately uses wall-clock instead — see DisplayClient.
  const frame = (now: number): void => {
    requestAnimationFrame(frame);
    loop.tick(now);
  };

  document.addEventListener('visibilitychange', () => {
    // Resuming from a background tab: forget the timing baseline rather than
    // charging the whole invisible gap to the accumulator. Without this the loop
    // would run its `maxFrameMs` clamp on every single resume.
    if (document.visibilityState === 'visible') loop.resume();
  });

  scenes.start('pairing');
  client.connect(room);
  requestAnimationFrame(frame);

  console.info(`[display] room ${room} · relay ${relayUrlFor()} · controller ${ctx.controllerUrl}`);
}

boot();
