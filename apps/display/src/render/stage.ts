/**
 * Stage — the Three.js bootstrap: renderer, scene, camera, resize.
 *
 * Deliberately thin. Everything that decides *what* the screen does lives in
 * `packages/engine` and knows nothing about WebGL; this file is the swappable
 * part `layer-3-display-engine.md` leaves room for when it names Godot as the
 * primary engine. Keeping it this small is what makes that claim true rather
 * than aspirational.
 */

import {
  Color,
  Group,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Camera } from 'three';

/**
 * Cap the device pixel ratio at 2.
 *
 * A 4K TV or a retina laptop reports 2–3, and rendering at 3× costs ~2.25× the
 * fragments of 2× for a difference nobody sitting across a room can see. Frame
 * time is part of the latency budget — `00-overview.md` §Latency budget counts
 * render time in the same 50–80 ms as the network — so this is a latency
 * decision, not just a quality one.
 */
const MAX_PIXEL_RATIO = 2;

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Everything the current scene owns. Cleared wholesale on scene change. */
  readonly world = new Group();

  /**
   * Camera actually used for rendering.
   *
   * A 2D game supplies an orthographic camera rather than fighting perspective;
   * anything 3D leaves this null and gets the default. Kept as an override
   * rather than letting scenes mutate `camera`, so a game that forgets to clean
   * up cannot leave the next one looking through its lens.
   */
  #override: Camera | null = null;

  readonly #canvas: HTMLCanvasElement;
  readonly #onResize = () => this.resize();

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;

    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;

    this.scene = new Scene();
    this.scene.background = new Color(0x0b0f16);
    this.scene.add(this.world);

    this.camera = new PerspectiveCamera(55, 1, 0.1, 100);
    this.camera.position.set(0, 1.6, 4.5);
    this.camera.lookAt(new Vector3(0, 1, 0));

    window.addEventListener('resize', this.#onResize);
    this.resize();
  }

  resize(): void {
    const width = this.#canvas.clientWidth || window.innerWidth;
    const height = this.#canvas.clientHeight || window.innerHeight;

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    // `false` — never let Three write inline CSS sizes onto the canvas. The
    // layout is the stylesheet's job; letting both drive it produces a canvas
    // that grows a few pixels on every resize event.
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();

    // An overridden camera is the game's, but keeping its projection current on
    // resize is not the game's problem — it has no resize event of its own.
    const override = this.#override;
    if (override && 'isOrthographicCamera' in override) {
      const ortho = override as unknown as {
        top: number;
        bottom: number;
        left: number;
        right: number;
        updateProjectionMatrix(): void;
      };
      const halfHeight = (ortho.top - ortho.bottom) / 2;
      const halfWidth = halfHeight * (width / Math.max(height, 1));
      ortho.left = -halfWidth;
      ortho.right = halfWidth;
      ortho.updateProjectionMatrix();
    }
  }

  /** Replace the current scene's contents. */
  setContent(group: Group | null): void {
    this.world.clear();
    if (group) this.world.add(group);
  }

  /** Override the render camera, or pass null to restore the default. */
  setCamera(camera: Camera | null): void {
    this.#override = camera;
  }

  render(): void {
    this.renderer.render(this.scene, this.#override ?? this.camera);
  }

  dispose(): void {
    window.removeEventListener('resize', this.#onResize);
    this.renderer.dispose();
  }
}
