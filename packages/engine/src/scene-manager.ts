/**
 * SceneManager — the display's state machine.
 *
 * `docs/layer-3-display-engine.md` §Modules: "menu / pairing / lobby / in-game /
 * results state machine."
 *
 * Transitions are declared rather than implicit, so an illegal move (results →
 * lobby without passing through the menu, say) is a loud error at the call site
 * instead of a screen that quietly renders the wrong thing. The failure this
 * prevents is subtle: without a guard, a late network event — a `join` arriving
 * after a match ended — can silently drag the display back into a scene it has
 * already torn down.
 */

export type SceneName = 'menu' | 'pairing' | 'lobby' | 'play' | 'results';

export interface Scene {
  readonly name: SceneName;
  /** Called when the scene becomes current. */
  enter?(from: SceneName | null): void;
  /** Called before leaving. Release timers and listeners here. */
  exit?(to: SceneName): void;
  /** Fixed-step update, only while current. */
  update?(dtSeconds: number, simTimeMs: number): void;
  /** Interpolated render, only while current. */
  render?(alpha: number): void;
}

/**
 * Legal transitions.
 *
 * `pairing → menu` and `lobby → pairing` exist so a player can back out; `play →
 * pairing` does not, because dropping a controller mid-match should surface a
 * reconnect prompt rather than silently abandoning the game.
 */
const TRANSITIONS: Record<SceneName, readonly SceneName[]> = {
  menu: ['pairing'],
  pairing: ['menu', 'lobby'],
  lobby: ['pairing', 'play'],
  play: ['results', 'lobby'],
  results: ['menu', 'lobby'],
};

export function canTransition(from: SceneName, to: SceneName): boolean {
  return TRANSITIONS[from].includes(to);
}

export class SceneTransitionError extends Error {
  constructor(from: SceneName, to: SceneName) {
    super(`illegal scene transition: ${from} → ${to}`);
    this.name = 'SceneTransitionError';
  }
}

export class SceneManager {
  readonly #scenes = new Map<SceneName, Scene>();
  #current: Scene | null = null;
  readonly #history: SceneName[] = [];

  constructor(scenes: readonly Scene[] = []) {
    for (const scene of scenes) this.#scenes.set(scene.name, scene);
  }

  register(scene: Scene): void {
    this.#scenes.set(scene.name, scene);
  }

  get current(): SceneName | null {
    return this.#current?.name ?? null;
  }

  /** Scenes entered so far, oldest first. Useful in tests and for a back action. */
  get history(): readonly SceneName[] {
    return [...this.#history];
  }

  /** Enter the first scene. Bypasses the transition table by definition. */
  start(name: SceneName): void {
    const scene = this.#require(name);
    this.#current = scene;
    this.#history.push(name);
    scene.enter?.(null);
  }

  /**
   * Move to another scene.
   *
   * @throws SceneTransitionError if the move is not declared legal.
   */
  goTo(name: SceneName): void {
    const from = this.#current;
    if (!from) {
      this.start(name);
      return;
    }
    if (from.name === name) return; // idempotent — re-entering is a no-op
    if (!canTransition(from.name, name)) throw new SceneTransitionError(from.name, name);

    const next = this.#require(name);
    // Exit fully before entering, so a scene's teardown can never observe the
    // manager already pointing at its successor.
    from.exit?.(name);
    this.#current = next;
    this.#history.push(name);
    next.enter?.(from.name);
  }

  /** Try to move; returns false instead of throwing when the move is illegal. */
  tryGoTo(name: SceneName): boolean {
    if (this.#current && !canTransition(this.#current.name, name)) return false;
    this.goTo(name);
    return true;
  }

  update(dtSeconds: number, simTimeMs: number): void {
    this.#current?.update?.(dtSeconds, simTimeMs);
  }

  render(alpha: number): void {
    this.#current?.render?.(alpha);
  }

  #require(name: SceneName): Scene {
    const scene = this.#scenes.get(name);
    if (!scene) throw new Error(`scene not registered: ${name}`);
    return scene;
  }
}
