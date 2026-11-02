/**
 * GameLoop — fixed-step simulation with interpolated rendering.
 *
 * `docs/layer-3-display-engine.md` §Architecture: "Fixed-timestep simulation
 * with interpolated rendering for smooth motion under variable frame rate."
 *
 * Two properties matter and they pull against each other:
 *
 *   - **Determinism.** Physics must advance in identical increments regardless
 *     of frame rate, or the same swing produces different results on a 60 Hz
 *     laptop and a 144 Hz monitor. That rules out `dt`-scaled updates.
 *   - **Smoothness.** A fixed step rarely lines up with the display's refresh,
 *     so rendering the raw simulation state stutters. Hence `alpha`: the
 *     fraction of a step the renderer is *between* the last two sim states, used
 *     to interpolate.
 *
 * The subtle failure is the **spiral of death**: if a frame takes longer than
 * the step, the loop runs extra steps to catch up; if those steps cost more than
 * they recover, the backlog grows and the app locks up. `maxFrameMs` caps how
 * much time a single frame may contribute, so a long stall — a backgrounded tab,
 * a garbage-collection pause, a laptop lid closing — is *dropped* rather than
 * simulated. Simulation time falls behind wall-clock, which is correct: nobody
 * wants ten seconds of physics fast-forwarded on resume.
 */

export interface GameLoopOptions {
  /** Simulation rate, Hz. 60 is the usual choice for physics. */
  stepHz?: number;
  /**
   * Longest wall-clock time one frame may contribute, ms. Anything beyond this
   * is discarded rather than simulated.
   */
  maxFrameMs?: number;
  /** Fixed-step simulation tick. `dt` is always exactly the step, in seconds. */
  update: (dtSeconds: number, simTimeMs: number) => void;
  /** Render. `alpha` is 0..1 — how far between the last two sim states we are. */
  render?: (alpha: number) => void;
}

export interface TickResult {
  /** Simulation steps run this frame. */
  steps: number;
  /** Interpolation factor for the renderer, 0..1. */
  alpha: number;
  /** Milliseconds discarded by the `maxFrameMs` clamp. Non-zero means a stall. */
  droppedMs: number;
}

const DEFAULT_STEP_HZ = 60;
/**
 * 250 ms — fifteen steps at 60 Hz, and the long-standing convention for
 * fixed-timestep loops.
 *
 * The tempting mistake is to set this near the frame budget (~83 ms). That is
 * far too tight: an ordinary GC pause or asset decode blows past it, and the
 * loop then silently discards real time, which the player sees as the game
 * briefly running slow. The clamp is a circuit breaker for catastrophic stalls —
 * a backgrounded tab, a closed lid — not a smoothing mechanism for jitter.
 * Anything short enough to trip on a normal hitch is doing the wrong job.
 */
const DEFAULT_MAX_FRAME_MS = 250;

export class GameLoop {
  readonly stepMs: number;
  readonly #stepSeconds: number;
  readonly #maxFrameMs: number;
  readonly #update: GameLoopOptions['update'];
  readonly #render: GameLoopOptions['render'];

  #accumulator = 0;
  #simTimeMs = 0;
  #lastNow: number | null = null;
  #totalSteps = 0;

  constructor(options: GameLoopOptions) {
    const stepHz = options.stepHz ?? DEFAULT_STEP_HZ;
    this.stepMs = 1000 / stepHz;
    this.#stepSeconds = 1 / stepHz;
    this.#maxFrameMs = options.maxFrameMs ?? DEFAULT_MAX_FRAME_MS;
    this.#update = options.update;
    this.#render = options.render;
  }

  /**
   * Advance to `now`. Call once per animation frame.
   *
   * The first call only establishes a baseline — there is no previous timestamp
   * to measure from, so it runs no steps.
   */
  tick(now: number): TickResult {
    if (this.#lastNow === null) {
      this.#lastNow = now;
      return { steps: 0, alpha: 0, droppedMs: 0 };
    }

    const elapsed = Math.max(0, now - this.#lastNow);
    this.#lastNow = now;

    const used = Math.min(elapsed, this.#maxFrameMs);
    const droppedMs = elapsed - used;
    this.#accumulator += used;

    let steps = 0;
    while (this.#accumulator >= this.stepMs) {
      this.#accumulator -= this.stepMs;
      this.#simTimeMs += this.stepMs;
      this.#totalSteps++;
      steps++;
      this.#update(this.#stepSeconds, this.#simTimeMs);
    }

    const alpha = this.#accumulator / this.stepMs;
    this.#render?.(alpha);
    return { steps, alpha, droppedMs };
  }

  /** Simulated time, ms. Diverges from wall-clock after a dropped stall. */
  get simTimeMs(): number {
    return this.#simTimeMs;
  }

  get totalSteps(): number {
    return this.#totalSteps;
  }

  /** Leftover time not yet simulated, ms. Always less than one step. */
  get pendingMs(): number {
    return this.#accumulator;
  }

  /**
   * Forget the timing baseline without discarding simulation state.
   *
   * Call when resuming from a background tab: the next `tick` then measures from
   * that moment instead of charging the whole invisible gap to the accumulator.
   */
  resume(): void {
    this.#lastNow = null;
    this.#accumulator = 0;
  }

  reset(): void {
    this.#accumulator = 0;
    this.#simTimeMs = 0;
    this.#lastNow = null;
    this.#totalSteps = 0;
  }
}
