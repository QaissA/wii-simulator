/**
 * Flappy (T3.7) — one input, side-on scroller.
 *
 * `docs/implementation-plan.md` §Phase 3c picks this as the first real game, not
 * because it is the most fun but because of what it does **not** need: no
 * pointing, no direction, no orientation at all. It is the only game in the plan
 * that does not depend on T1.7, so it can be built and played while the
 * quaternion work is still open.
 *
 * Its real value is as a latency instrument. A cursor forgives input lag —
 * a late cursor still looks like a cursor. Flappy does not: if the flap lands a
 * frame after the tap, the gap you aimed for is the gap you clip. If something
 * in the 50–80 ms budget regresses, this notices before any dashboard does.
 *
 * The one action is deliberately bound to **both** a button and a gesture. They
 * take different paths through the stack — a button is a discrete reliable
 * message, a gesture comes off the accelerometer — and having both means the
 * game keeps working while gesture thresholds are still being tuned.
 */

import {
  BoxGeometry,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
} from 'three';
import type { Camera, Object3D } from 'three';
import type { InputMapping } from '@wii/engine';

import { gradientPlane, ridge, starField } from '../../render/decor.js';

import type { GameContext, GameInstance, GameModule } from '../module.js';

/* ------------------------------------------------------------------ tuning */

/** World units visible vertically. The world is sized in these, not in pixels. */
const VIEW_HEIGHT = 10;
const VIEW_WIDTH = 17.8;

const GRAVITY = -26;
/** Upward velocity a flap sets — not adds. */
const FLAP_SPEED = 8.6;
/** Terminal downward speed, so a long fall stays readable rather than a blur. */
const MAX_FALL = -16;

const SCROLL_SPEED = 5.4;
const GAP_HEIGHT = 3.1;
const PIPE_WIDTH = 1.3;
const PIPE_SPACING = 5.6;

const BIRD_X = -4.2;
const BIRD_RADIUS = 0.42;

/** Highest and lowest a gap centre may sit, so gaps stay reachable. */
const GAP_MIN_Y = -VIEW_HEIGHT / 2 + GAP_HEIGHT / 2 + 1.1;
const GAP_MAX_Y = VIEW_HEIGHT / 2 - GAP_HEIGHT / 2 - 1.1;

/**
 * Grace period after the round starts, ms.
 *
 * Without it a player who is still reading the screen has already lost. The bird
 * hovers until the first flap instead of falling immediately.
 */
const READY_HINT = 'flap to start';

/**
 * A dusk palette, top to bottom.
 *
 * The sky is a gradient rather than one flat colour because the bird spends the
 * whole round moving vertically through it: a flat field gives the eye nothing
 * to read height against, and the same fall looks identical at the top of the
 * screen and the bottom.
 */
const SKY_TOP = 0x0b1020;
const SKY_HORIZON = 0x3a2b4d;

/** Two parallax ridges. Further away means darker, slower and lower contrast. */
const RIDGE_FAR = 0x1b2138;
const RIDGE_NEAR = 0x232a45;

const BIRD_COLOR = 0xffd166;
const BIRD_WING = 0xf0a93a;
const BIRD_BEAK = 0xff8a3d;

const PIPE_COLOR = 0x2f6fed;
/** The lip. Lighter, so the gap edge — the only part that kills you — reads first. */
const PIPE_CAP = 0x5b93ff;
const PIPE_SHADE = 0x2457bd;

const GROUND_COLOR = 0x141b2e;
const GROUND_EDGE = 0x2f3d5e;

/** Parallax factors, as a fraction of the pipes' scroll speed. */
const RIDGE_FAR_SCALE = 0.12;
const RIDGE_NEAR_SCALE = 0.28;
const STAR_SCALE = 0.04;

interface Pipe {
  mesh: Group;
  x: number;
  gapY: number;
  /** Already counted toward the score. */
  passed: boolean;
}

class Flappy implements GameInstance {
  readonly #ctx: GameContext;
  readonly #group = new Group();
  readonly #camera: OrthographicCamera;

  readonly #bird: Group;
  /** Wing, kept separately so a flap can animate it without a scene lookup. */
  readonly #wing: Mesh;
  readonly #pipes: Pipe[] = [];

  /** Background layers, scrolled in `render` at a fraction of the world speed. */
  readonly #parallax: Array<{ node: Object3D; scale: number; span: number }> = [];

  /** Time since the last flap, seconds — drives the wing only. */
  #sinceFlap = 1;

  #unsubscribe: Array<() => void> = [];

  /** Simulation state. Everything here advances only in `update`. */
  #birdY = 0;
  #birdV = 0;
  #started = false;
  #dead = false;
  #score = 0;
  #distance = 0;

  /** Previous-step position, for interpolated rendering. */
  #prevBirdY = 0;
  #prevPipeX: number[] = [];

  /**
   * Deterministic pseudo-random gap placement.
   *
   * A seeded generator rather than `Math.random` so a run can be reproduced from
   * its seed — which is what makes "it always kills me at the fourth pipe"
   * something that can be looked at rather than only complained about.
   */
  #seed = 0x2f6fed;

  constructor(ctx: GameContext) {
    this.#ctx = ctx;

    this.#camera = new OrthographicCamera(
      -VIEW_WIDTH / 2,
      VIEW_WIDTH / 2,
      VIEW_HEIGHT / 2,
      -VIEW_HEIGHT / 2,
      0.1,
      100,
    );
    this.#camera.position.set(0, 0, 10);

    const sky = gradientPlane(VIEW_WIDTH, VIEW_HEIGHT, SKY_TOP, SKY_HORIZON);
    sky.position.z = -5;

    // Scenery uses its own generator, so re-seeding the *gameplay* one on every
    // reset cannot also reshuffle the sky mid-session.
    const decorRandom = seeded(0x9e3779b9);

    const stars = starField(70, VIEW_WIDTH * 2, VIEW_HEIGHT, decorRandom);
    stars.position.z = -4.5;

    const far = ridge(VIEW_WIDTH, 1.5, RIDGE_FAR, 9, decorRandom);
    far.position.set(0, -VIEW_HEIGHT / 2 + 1.3, -4);

    const near = ridge(VIEW_WIDTH, 1.1, RIDGE_NEAR, 7, decorRandom);
    near.position.set(0, -VIEW_HEIGHT / 2 + 0.95, -3);

    this.#parallax.push(
      { node: stars, scale: STAR_SCALE, span: VIEW_WIDTH * 2 },
      { node: far, scale: RIDGE_FAR_SCALE, span: VIEW_WIDTH },
      { node: near, scale: RIDGE_NEAR_SCALE, span: VIEW_WIDTH },
    );

    const ground = new Mesh(
      new PlaneGeometry(VIEW_WIDTH, 1.2),
      new MeshBasicMaterial({ color: GROUND_COLOR }),
    );
    ground.position.set(0, -VIEW_HEIGHT / 2 + 0.6, -1);

    // A bright lip on the floor. The floor is lethal, so its exact height is
    // worth stating rather than leaving to a colour boundary the eye must guess.
    const groundEdge = new Mesh(
      new PlaneGeometry(VIEW_WIDTH, 0.07),
      new MeshBasicMaterial({ color: GROUND_EDGE }),
    );
    groundEdge.position.set(0, -VIEW_HEIGHT / 2 + 1.2, -0.9);

    this.#bird = new Group();
    this.#bird.position.x = BIRD_X;

    const body = new Mesh(
      new CircleGeometry(BIRD_RADIUS, 24),
      new MeshBasicMaterial({ color: BIRD_COLOR }),
    );

    // Beak and eye both sit forward of centre, which is what tells a player
    // which way the bird faces — a plain disc has no heading at all.
    const beak = new Mesh(
      new CircleGeometry(BIRD_RADIUS * 0.34, 3),
      new MeshBasicMaterial({ color: BIRD_BEAK }),
    );
    beak.position.set(BIRD_RADIUS * 0.85, -BIRD_RADIUS * 0.1, 0.01);
    beak.rotation.z = -Math.PI / 2;

    const eye = new Mesh(
      new CircleGeometry(BIRD_RADIUS * 0.2, 12),
      new MeshBasicMaterial({ color: 0x11141f }),
    );
    eye.position.set(BIRD_RADIUS * 0.32, BIRD_RADIUS * 0.3, 0.02);

    this.#wing = new Mesh(
      new CircleGeometry(BIRD_RADIUS * 0.5, 16),
      new MeshBasicMaterial({ color: BIRD_WING }),
    );
    this.#wing.position.set(-BIRD_RADIUS * 0.2, 0, 0.01);
    this.#wing.scale.y = 0.6;

    this.#bird.add(body, this.#wing, beak, eye);

    this.#group.add(sky, stars, far, near, ground, groundEdge, this.#bird);
  }

  camera(): Camera {
    return this.#camera;
  }

  enter(): void {
    const ctx = this.#ctx;
    ctx.stage.setContent(this.#group);
    this.#reset();

    this.#unsubscribe.push(
      ctx.input.onAction((e) => {
        // `started` and `triggered` both count; a button-up must not flap, or
        // every press would flap twice.
        if (e.phase === 'ended') return;
        if (e.action !== 'flap') return;
        this.#flap();
      }),
    );
  }

  exit(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#ctx.overlay.setHud([]);
    this.#ctx.overlay.setStatus('');
  }

  update(dt: number): void {
    // Cosmetic only, but it belongs in the fixed step like everything else: a
    // wing driven off render time would beat at the display's refresh rate.
    this.#sinceFlap += dt;

    if (this.#dead) return;

    this.#prevBirdY = this.#birdY;
    this.#prevPipeX = this.#pipes.map((p) => p.x);

    // Before the first flap the bird hovers. A player still reading the screen
    // should not already be losing.
    if (!this.#started) return;

    this.#birdV = Math.max(this.#birdV + GRAVITY * dt, MAX_FALL);
    this.#birdY += this.#birdV * dt;
    this.#distance += SCROLL_SPEED * dt;

    for (const pipe of this.#pipes) {
      pipe.x -= SCROLL_SPEED * dt;
      if (!pipe.passed && pipe.x + PIPE_WIDTH / 2 < BIRD_X - BIRD_RADIUS) {
        pipe.passed = true;
        this.#score++;
        this.#ctx.audio.play('flappy.pass');
      }
    }

    // Recycle pipes that have left the view rather than allocating new geometry
    // every few seconds.
    for (const pipe of this.#pipes) {
      if (pipe.x < -VIEW_WIDTH / 2 - PIPE_WIDTH) {
        const rightmost = Math.max(...this.#pipes.map((p) => p.x));
        pipe.x = rightmost + PIPE_SPACING;
        pipe.gapY = this.#nextGapY();
        pipe.passed = false;
        this.#layoutPipe(pipe);
      }
    }

    if (this.#hitSomething()) this.#die();
  }

  render(alpha: number): void {
    // Interpolate between the last two simulation states, which is the whole
    // reason GameLoop hands over `alpha`: the sim runs at a fixed 60 Hz and the
    // display may not.
    const y = this.#prevBirdY + (this.#birdY - this.#prevBirdY) * alpha;
    this.#bird.position.y = y;
    // A little tilt sells the fall without affecting the simulation.
    this.#bird.rotation.z = clamp(this.#birdV * 0.045, -1.1, 0.55);

    this.#pipes.forEach((pipe, i) => {
      const prev = this.#prevPipeX[i] ?? pipe.x;
      pipe.mesh.position.x = prev + (pipe.x - prev) * alpha;
    });

    // Background layers scroll with total distance, so they stay continuous
    // across a pipe recycling and cannot drift out of step with the world.
    for (const layer of this.#parallax) {
      const offset = -this.#distance * layer.scale;
      // Wrapped into one span so a layer never runs off its own width.
      layer.node.position.x = ((offset % layer.span) + layer.span) % layer.span - layer.span / 2;
    }

    // The wing sweeps once per flap and settles. Purely cosmetic: it reads off
    // `#sinceFlap`, never the other way round, so it cannot affect the sim.
    const beat = Math.max(0, 1 - this.#sinceFlap * 6);
    this.#wing.scale.y = 0.6 - beat * 0.45;
    this.#wing.position.y = beat * BIRD_RADIUS * 0.3;

    this.#ctx.overlay.setHud([
      ['score', String(this.#score)],
      ['best', String(loadBest())],
    ]);
  }

  /* ------------------------------------------------------------- internals */

  #flap(): void {
    if (this.#dead) return;
    this.#started = true;
    this.#ctx.audio.play('flap');
    // Set rather than add: a flap should mean the same thing whether the bird
    // was rising or plummeting, which is what makes the control predictable.
    this.#birdV = FLAP_SPEED;
    this.#sinceFlap = 0;
    this.#ctx.overlay.setStatus('');
  }

  #die(): void {
    this.#dead = true;
    this.#ctx.audio.play('flappy.crash');
    this.#ctx.end({
      score: this.#score,
      detail: this.#score === 1 ? '1 pipe' : `${this.#score} pipes`,
      record: saveBest(this.#score),
    });
  }

  #hitSomething(): boolean {
    const top = VIEW_HEIGHT / 2;
    const floor = -VIEW_HEIGHT / 2 + 1.2;
    if (this.#birdY - BIRD_RADIUS < floor) return true;
    // The ceiling is not lethal — clipping it stops upward motion instead.
    if (this.#birdY + BIRD_RADIUS > top) {
      this.#birdY = top - BIRD_RADIUS;
      this.#birdV = Math.min(this.#birdV, 0);
    }

    for (const pipe of this.#pipes) {
      const dx = Math.abs(pipe.x - BIRD_X);
      if (dx > PIPE_WIDTH / 2 + BIRD_RADIUS) continue;
      const withinGap =
        this.#birdY - BIRD_RADIUS > pipe.gapY - GAP_HEIGHT / 2 &&
        this.#birdY + BIRD_RADIUS < pipe.gapY + GAP_HEIGHT / 2;
      if (!withinGap) return true;
    }
    return false;
  }

  #reset(): void {
    this.#birdY = 0;
    this.#prevBirdY = 0;
    this.#birdV = 0;
    this.#started = false;
    this.#dead = false;
    this.#sinceFlap = 1;
    this.#score = 0;
    this.#distance = 0;
    this.#seed = 0x2f6fed;

    for (const pipe of this.#pipes) this.#group.remove(pipe.mesh);
    this.#pipes.length = 0;

    // Enough to cover the view plus one waiting off-screen.
    const count = Math.ceil(VIEW_WIDTH / PIPE_SPACING) + 2;
    for (let i = 0; i < count; i++) {
      const mesh = new Group();
      const pipe: Pipe = {
        mesh,
        x: VIEW_WIDTH / 2 + 2 + i * PIPE_SPACING,
        gapY: this.#nextGapY(),
        passed: false,
      };
      // Two shafts, each with a lip at its gap end. `#layoutPipe` still moves
      // only `children[0]` and `children[1]`, so the caps ride along as their
      // children and the layout code stays as simple as it was.
      mesh.add(pipeHalf(-1), pipeHalf(1));
      this.#group.add(mesh);
      this.#pipes.push(pipe);
      this.#layoutPipe(pipe);
    }
    this.#prevPipeX = this.#pipes.map((p) => p.x);

    this.#ctx.overlay.setStatus(READY_HINT, 'good');
  }

  /** Position the two halves so the gap lands where `gapY` says. */
  #layoutPipe(pipe: Pipe): void {
    const [lower, upper] = pipe.mesh.children as Mesh[];
    if (lower) lower.position.y = pipe.gapY - GAP_HEIGHT / 2 - VIEW_HEIGHT / 2;
    if (upper) upper.position.y = pipe.gapY + GAP_HEIGHT / 2 + VIEW_HEIGHT / 2;
    pipe.mesh.position.x = pipe.x;
  }

  /** xorshift — small, deterministic, and good enough to place a gap. */
  #nextGapY(): number {
    let x = this.#seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#seed = x >>> 0;
    const unit = (this.#seed % 10_000) / 10_000;
    return GAP_MIN_Y + unit * (GAP_MAX_Y - GAP_MIN_Y);
  }
}

/**
 * One shaft of a pipe, with a lip at the gap end.
 *
 * `side` is +1 for the upper pipe (its gap end points down) and -1 for the
 * lower. The shaft keeps its original geometry and origin so `#layoutPipe` is
 * unchanged — the cap and the shading stripe are children, positioned in the
 * shaft's own space.
 */
function pipeHalf(side: -1 | 1): Mesh {
  const shaft = new Mesh(
    new BoxGeometry(PIPE_WIDTH, VIEW_HEIGHT, 0.1),
    new MeshBasicMaterial({ color: PIPE_COLOR }),
  );

  // A darker stripe down one edge. With no lighting this is the only thing that
  // keeps a pipe from reading as a flat rectangle of colour.
  const shade = new Mesh(
    new PlaneGeometry(PIPE_WIDTH * 0.26, VIEW_HEIGHT),
    new MeshBasicMaterial({ color: PIPE_SHADE }),
  );
  shade.position.set(PIPE_WIDTH * 0.37, 0, 0.06);
  shaft.add(shade);

  const cap = new Mesh(
    new BoxGeometry(PIPE_WIDTH * 1.22, 0.42, 0.12),
    new MeshBasicMaterial({ color: PIPE_CAP }),
  );
  // `side` +1 means the gap is below this shaft, so the lip sits at its bottom.
  cap.position.set(0, (side === 1 ? -1 : 1) * (VIEW_HEIGHT / 2 - 0.21), 0.07);
  shaft.add(cap);

  return shaft;
}

/** xorshift as a closure — the scenery's own, independent of the gameplay seed. */
function seeded(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return (x % 10_000) / 10_000;
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const BEST_KEY = 'wii.flappy.best';

function loadBest(): number {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const n = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** @returns whether this beat the stored best — the results screen celebrates it. */
function saveBest(score: number): boolean {
  try {
    if (score <= loadBest()) return false;
    localStorage.setItem(BEST_KEY, String(score));
    return true;
  } catch {
    // Private mode — the best score just won't persist. Reporting a record we
    // could not store would promise a number that is gone on the next reload.
    return false;
  }
}

/**
 * One action, reached two ways.
 *
 * No axes at all: this game asks nothing of orientation, which is exactly why it
 * can ship before T1.7.
 */
const FLAPPY_MAPPING: InputMapping = {
  buttons: { a: 'flap' },
  gestures: { swing: 'flap', shake: 'flap' },
};

export const flappy: GameModule = {
  id: 'flappy',
  title: 'Flappy',
  blurb: 'One button. Mind the gap.',
  grip: 'any — press A, or flick the phone',
  mapping: FLAPPY_MAPPING,
  create: (ctx) => new Flappy(ctx),
};
