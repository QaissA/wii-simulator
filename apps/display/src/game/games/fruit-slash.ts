/**
 * Fruit slash (T3.8) — point, and slice along the stroke.
 *
 * `docs/implementation-plan.md` §Phase 3c: *"T3.8 needs T1.7 and is the reason
 * T1.7 comes first. Slicing is a stroke through 2D screen space: where the phone
 * points, sampled over time, forming a path that is tested against fruit
 * colliders. On Euler angles that path distorts as the wrist rolls and breaks
 * entirely near vertical. On a pointing vector it is just a polyline."*
 *
 * That paragraph is the whole design, and the line that matters most is the one
 * about the gesture layer: **there is no `swing` binding here.** A slice is
 * `aim` sampled over time plus a speed threshold on the pointer, so the game
 * asks where the phone is aiming and never what the accelerometer thought about
 * it.
 *
 * Two consequences worth keeping:
 *
 *   - **Rolling the wrist mid-stroke does not bend the cut.** A pointing vector
 *     is invariant to rotation about itself (see `pointingDeg` in
 *     `packages/engine/src/input-adapter.ts`), which is exactly the property a
 *     stroke needs and the one Euler angles could not offer.
 *   - **The cut is a polyline, not an event.** Collision tests the *segment*
 *     between consecutive samples, so a fast flick that crosses a fruit between
 *     two frames still slices it. Testing only the sample points would drop
 *     precisely the fastest, most satisfying strokes.
 *
 * All gameplay — blade sampling included — runs in the fixed-step `update`.
 * `render` only interpolates and draws. That split is what keeps "did that slice
 * land" independent of the display's refresh rate.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RingGeometry,
} from 'three';
import type { Camera } from 'three';
import { PredictiveAxis, segmentIntersectsCircle } from '@wii/engine';
import type { InputMapping } from '@wii/engine';

import { gradientPlane } from '../../render/decor.js';

import type { GameContext, GameInstance, GameModule } from '../module.js';

/* ------------------------------------------------------------------ tuning */

/** World units visible. The world is sized in these, never in pixels. */
const VIEW_HEIGHT = 10;
const VIEW_WIDTH = 17.8;

/**
 * How far the pointer reaches, world units from centre.
 *
 * Slightly inside the view so the blade never sits on the frame edge, where a
 * fruit would be unsliceable while still looking reachable.
 */
const SPAN_X = VIEW_WIDTH / 2 - 0.7;
const SPAN_Y = VIEW_HEIGHT / 2 - 0.7;

/** Trail length as a duration, so it looks the same at any step rate. */
const TRAIL_MS = 170;
/** Hard cap on retained samples — TRAIL_MS at the sim rate, plus headroom. */
const MAX_TRAIL = 24;
const BLADE_HALF_WIDTH = 0.115;

/**
 * Pointer speed above which the blade cuts, world units per second.
 *
 * The only threshold this game has, and it replaces `SWING_THRESHOLD` entirely.
 * Too low and resting jitter slices everything on screen; too high and a
 * deliberate flick passes straight through. Because it is a *pointer* speed
 * rather than an accelerometer magnitude, it means the same thing at any grip.
 *
 * TODO(on-device): unvalidated against a real hand. Judge it by whether a
 * deliberate stroke always cuts and a slow re-aim never does. Plan ref: T3.8.
 */
const CUT_SPEED = 6.5;

/** Ignore samples closer than this — a still hand would otherwise fill the trail. */
const MIN_SEGMENT = 0.012;

const GRAVITY = -17;
const FRUIT_RADIUS = 0.52;
/** Bombs read slightly smaller, so they are distinguishable at a glance. */
const BOMB_RADIUS = 0.46;

/** Fruit are launched from below this, off-screen. */
const SPAWN_Y = -VIEW_HEIGHT / 2 - FRUIT_RADIUS - 0.4;
const SPAWN_X = VIEW_WIDTH / 2 - 2.6;
/** Apex height above centre, world units. Keeps every throw reachable. */
const APEX_MIN = 2.2;
const APEX_MAX = 4.4;

const LIVES = 3;

/** Seconds between throws, easing down as the score climbs. */
const SPAWN_INTERVAL_START = 1.15;
const SPAWN_INTERVAL_MIN = 0.5;

/**
 * The backdrop, as a gradient rather than one flat colour.
 *
 * Fruit are thrown from below and fall back through the whole height of the
 * screen, so height is the axis the eye has to read — and a flat field gives it
 * nothing to read against. Darker at the top also keeps contrast where the
 * fruit spend most of their hang time.
 */
const BACKDROP_TOP = 0x0a1120;
const BACKDROP_BOTTOM = 0x1b2742;
const BOMB_COLOR = 0x1b2130;
const BOMB_FUSE = 0xff5a5a;
const CURSOR_COLOR = 0x8fa6c9;
const BLADE_COLOR = 0xf2f6ff;

/** One shared material per fruit colour — no per-slice allocation. */
const FRUIT_COLORS = [0xff5f6d, 0xffb03a, 0x8ed35b, 0x4ec5d6, 0xc86bff];

/** `THREE.DynamicDrawUsage`, inlined so the import list stays about geometry. */
const DYNAMIC_DRAW = 35048;

/* -------------------------------------------------------------- primitives */

interface TrailPoint {
  x: number;
  y: number;
  /** Simulation time, ms. */
  t: number;
}

interface Fruit {
  mesh: Mesh;
  active: boolean;
  bomb: boolean;
  /**
   * Index into the palette, so a reused fruit can restyle its *children* too.
   *
   * The pool swaps `mesh.material` on reuse; the flesh and highlight are child
   * meshes with their own materials, and an index is what keeps all three in
   * step. Carrying the material alone would have left a recoloured fruit wearing
   * the previous one's flesh.
   */
  colorIndex: number;
  radius: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  angle: number;
  prevX: number;
  prevY: number;
  prevAngle: number;
}

/** A sliced half, flying apart. Cosmetic only — never collides with anything. */
interface Half {
  mesh: Mesh;
  active: boolean;
  which: 0 | 1;
  colorIndex: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  angle: number;
  prevX: number;
  prevY: number;
  prevAngle: number;
}

/* --------------------------------------------------------------- the blade */

/**
 * The visible stroke, as a tapered ribbon.
 *
 * Built as a mesh rather than a `Line` because WebGL ignores `linewidth` above 1
 * on essentially every desktop driver — a `Line` blade would be a hairline
 * whatever width it asked for. Two vertices per trail point, offset along the
 * segment normal, tapering to nothing at the tail so the stroke reads as motion
 * rather than as a stick.
 *
 * Buffers are allocated once at `MAX_TRAIL` and redrawn via `setDrawRange`, so a
 * stroke costs no allocation at all.
 */
class BladeRibbon {
  readonly mesh: Mesh;
  readonly #position: BufferAttribute;
  readonly #geometry = new BufferGeometry();

  constructor() {
    this.#position = new BufferAttribute(new Float32Array(MAX_TRAIL * 2 * 3), 3);
    this.#position.setUsage(DYNAMIC_DRAW);
    this.#geometry.setAttribute('position', this.#position);

    // Two triangles per quad, for every gap between consecutive trail points.
    const index: number[] = [];
    for (let i = 0; i < MAX_TRAIL - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.#geometry.setIndex(index);
    this.#geometry.setDrawRange(0, 0);

    // Per-vertex RGBA, fading the tail to fully transparent.
    //
    // The ribbon already tapers in *width*, which reads as a stroke narrowing to
    // a point — but a hard-edged point still ends abruptly. Fading the alpha
    // along the same axis makes the tail dissolve instead, which is what a fast
    // swipe actually looks like. The colour is constant; only alpha varies, so
    // the two are separable if the blade ever wants a hot core.
    const colors = new Float32Array(MAX_TRAIL * 2 * 4);
    const blade = new Color(BLADE_COLOR);
    for (let i = 0; i < MAX_TRAIL; i++) {
      // Squared, so the fade is weighted toward the head where the eye is.
      const a = Math.pow((i + 1) / MAX_TRAIL, 2) * 0.95;
      for (const v of [0, 1]) {
        const o = (i * 2 + v) * 4;
        colors[o] = blade.r;
        colors[o + 1] = blade.g;
        colors[o + 2] = blade.b;
        colors[o + 3] = a;
      }
    }
    this.#geometry.setAttribute('color', new BufferAttribute(colors, 4));

    this.mesh = new Mesh(
      this.#geometry,
      new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }),
    );
    this.mesh.position.z = 1;
    // The ribbon's bounding box is rewritten every frame and would otherwise
    // have to be recomputed to stop Three culling a perfectly visible blade.
    this.mesh.frustumCulled = false;
  }

  /** Rebuild from the current trail. `points` runs oldest to newest. */
  update(points: readonly TrailPoint[]): void {
    if (points.length < 2) {
      this.#geometry.setDrawRange(0, 0);
      return;
    }

    const array = this.#position.array as Float32Array;
    const count = Math.min(points.length, MAX_TRAIL);
    const first = points.length - count;

    for (let i = 0; i < count; i++) {
      const p = points[first + i] as TrailPoint;
      // Direction taken from the neighbours, so the ribbon turns smoothly
      // through a corner instead of pinching at it.
      const before = points[Math.max(first, first + i - 1)] as TrailPoint;
      const after = points[Math.min(points.length - 1, first + i + 1)] as TrailPoint;
      let dx = after.x - before.x;
      let dy = after.y - before.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;

      // Taper from nothing at the tail to full width at the head.
      const w = BLADE_HALF_WIDTH * ((i + 1) / count);
      const nx = -dy * w;
      const ny = dx * w;

      const o = i * 6;
      array[o] = p.x + nx;
      array[o + 1] = p.y + ny;
      array[o + 2] = 0;
      array[o + 3] = p.x - nx;
      array[o + 4] = p.y - ny;
      array[o + 5] = 0;
    }

    this.#position.needsUpdate = true;
    this.#geometry.setDrawRange(0, (count - 1) * 6);
  }

  clear(): void {
    this.#geometry.setDrawRange(0, 0);
  }
}

/* ---------------------------------------------------------------- the game */

class FruitSlash implements GameInstance {
  readonly #ctx: GameContext;
  readonly #group = new Group();
  readonly #camera: OrthographicCamera;

  /**
   * Prediction runs on the *axis*, exactly as the debug cursor does — so this
   * game stays ignorant of how orientation becomes gameplay, which is
   * `InputAdapter`'s job and nothing to do with fruit.
   */
  readonly #axisX = new PredictiveAxis();
  readonly #axisY = new PredictiveAxis();

  readonly #blade = new BladeRibbon();
  readonly #cursor: Mesh;

  readonly #fruit: Fruit[] = [];
  readonly #halves: Half[] = [];
  readonly #trail: TrailPoint[] = [];

  readonly #fruitMaterials: MeshBasicMaterial[];
  /** Lighter core of each fruit — the cut face, and what makes a disc a fruit. */
  readonly #fleshMaterials: MeshBasicMaterial[];
  /** A small off-centre specular. Two draw calls buying most of what light would. */
  readonly #shineMaterials: MeshBasicMaterial[];
  readonly #bombMaterial: MeshBasicMaterial;
  readonly #fruitGeometry = new CircleGeometry(FRUIT_RADIUS, 28);
  readonly #bombGeometry = new CircleGeometry(BOMB_RADIUS, 24);
  readonly #halfGeometries: [CircleGeometry, CircleGeometry];

  #unsubscribe: Array<() => void> = [];

  /* simulation state */
  #started = false;
  #over = false;
  #score = 0;
  #lives = LIVES;
  #simMs = 0;
  #spawnAt = 0;
  #cutting = false;
  #strokeSlices = 0;
  #comboLabel = '';
  #comboUntil = 0;
  #seed = 0x51ce;

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

    const backdrop = gradientPlane(VIEW_WIDTH, VIEW_HEIGHT, BACKDROP_TOP, BACKDROP_BOTTOM);
    backdrop.position.z = -5;

    this.#fruitMaterials = FRUIT_COLORS.map((color) => new MeshBasicMaterial({ color }));
    // Derived from the palette rather than listed separately, so adding a fruit
    // colour stays a one-line change to FRUIT_COLORS.
    this.#fleshMaterials = FRUIT_COLORS.map(
      (color) =>
        new MeshBasicMaterial({ color: new Color(color).lerp(new Color(0xfff3e2), 0.55) }),
    );
    this.#shineMaterials = FRUIT_COLORS.map(
      (color) =>
        new MeshBasicMaterial({
          color: new Color(color).lerp(new Color(0xffffff), 0.8),
          transparent: true,
          opacity: 0.75,
        }),
    );
    this.#bombMaterial = new MeshBasicMaterial({ color: BOMB_COLOR });
    this.#halfGeometries = [
      new CircleGeometry(FRUIT_RADIUS, 24, 0, Math.PI),
      new CircleGeometry(FRUIT_RADIUS, 24, Math.PI, Math.PI),
    ];

    // A quiet ring showing where the phone points even when the blade is idle.
    // Without it a player who is aiming rather than slicing has no feedback at
    // all, and reads the game as unresponsive rather than as waiting.
    this.#cursor = new Mesh(
      new RingGeometry(0.14, 0.17, 32),
      new MeshBasicMaterial({ color: CURSOR_COLOR, transparent: true, opacity: 0.55 }),
    );
    this.#cursor.position.z = 0.5;

    this.#group.add(backdrop, this.#blade.mesh, this.#cursor);
  }

  camera(): Camera {
    return this.#camera;
  }

  enter(): void {
    const ctx = this.#ctx;
    ctx.stage.setContent(this.#group);
    this.#reset();

    this.#unsubscribe.push(
      ctx.client.onFrame((_frame, captureLocalMs) => {
        // Fed with the *capture* time on this machine's clock. Arrival time
        // would make prediction extrapolate over zero elapsed time and do
        // nothing — which looks like prediction being off rather than a bug.
        this.#axisX.push(ctx.input.axis('aim.x'), captureLocalMs);
        this.#axisY.push(ctx.input.axis('aim.y'), captureLocalMs);
      }),
    );
  }

  exit(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#ctx.overlay.setHud([]);
    this.#ctx.overlay.setStatus('');
  }

  update(dt: number, simTimeMs: number): void {
    if (this.#over) return;
    this.#simMs = simTimeMs;

    this.#sampleBlade(simTimeMs);
    this.#advanceFruit(dt);
    this.#advanceHalves(dt);

    if (this.#started) this.#maybeSpawn(dt);
  }

  render(alpha: number): void {
    const now = Date.now();

    // The cursor is drawn from the *render-time* prediction so aiming feels
    // immediate, while the blade is drawn from simulation samples so what you
    // see cut is what actually cut. At 60 Hz the two differ by under one step.
    const ax = clamp(this.#axisX.valueAt(now), -1, 1);
    const ay = clamp(this.#axisY.valueAt(now), -1, 1);
    this.#cursor.position.x = ax * SPAN_X;
    this.#cursor.position.y = ay * SPAN_Y;

    this.#blade.update(this.#trail);

    for (const f of this.#fruit) {
      if (!f.active) continue;
      f.mesh.position.x = f.prevX + (f.x - f.prevX) * alpha;
      f.mesh.position.y = f.prevY + (f.y - f.prevY) * alpha;
      f.mesh.rotation.z = f.prevAngle + (f.angle - f.prevAngle) * alpha;
    }

    for (const h of this.#halves) {
      if (!h.active) continue;
      h.mesh.position.x = h.prevX + (h.x - h.prevX) * alpha;
      h.mesh.position.y = h.prevY + (h.y - h.prevY) * alpha;
      h.mesh.rotation.z = h.prevAngle + (h.angle - h.prevAngle) * alpha;
    }

    this.#ctx.overlay.setHud([
      ['score', String(this.#score)],
      ['best', String(loadBest())],
      ['lives', this.#lives > 0 ? '*'.repeat(this.#lives) : '—', this.#lives <= 1 ? 'bad' : 'idle'],
    ]);

    if (this.#comboLabel && this.#simMs < this.#comboUntil) {
      this.#ctx.overlay.setStatus(this.#comboLabel, 'good');
    } else if (this.#comboLabel) {
      this.#comboLabel = '';
      this.#ctx.overlay.setStatus('');
    }
  }

  /* ------------------------------------------------------- blade + slicing */

  /**
   * Append one blade sample and test the segment it just swept.
   *
   * Testing the segment rather than the point is what makes fast strokes work:
   * at 60 Hz a quick flick moves several fruit-widths between samples, and a
   * point test would simply miss the fruit it visibly passed through.
   */
  #sampleBlade(simTimeMs: number): void {
    const now = Date.now();
    const x = clamp(this.#axisX.valueAt(now), -1, 1) * SPAN_X;
    const y = clamp(this.#axisY.valueAt(now), -1, 1) * SPAN_Y;

    // Drop anything older than the trail window, so the ribbon's length is a
    // duration rather than a sample count.
    while (this.#trail.length > 0 && simTimeMs - (this.#trail[0] as TrailPoint).t > TRAIL_MS) {
      this.#trail.shift();
    }

    const last = this.#trail[this.#trail.length - 1];
    if (!last) {
      this.#trail.push({ x, y, t: simTimeMs });
      return;
    }

    const dx = x - last.x;
    const dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    const dtSeconds = Math.max(1, simTimeMs - last.t) / 1000;
    const speed = dist / dtSeconds;

    // A hand holding still would otherwise pack the trail with near-identical
    // points and leave the ribbon with a meaningless direction.
    if (dist < MIN_SEGMENT) {
      this.#endStroke();
      return;
    }

    this.#trail.push({ x, y, t: simTimeMs });
    if (this.#trail.length > MAX_TRAIL) this.#trail.shift();

    if (speed < CUT_SPEED) {
      this.#endStroke();
      return;
    }

    if (!this.#cutting) {
      this.#cutting = true;
      this.#strokeSlices = 0;
    }

    // The first cutting stroke starts the round, so a player who is still
    // reading the screen is not already losing lives. Clearing the hint is part
    // of starting: left up, "swipe to slice" sits over a game already in
    // progress and reads as the game not having noticed.
    if (!this.#started) {
      this.#started = true;
      this.#ctx.overlay.setStatus('');
    }

    this.#cut(last.x, last.y, x, y);
  }

  /** Close the current stroke and award any combo it earned. */
  #endStroke(): void {
    if (!this.#cutting) return;
    this.#cutting = false;

    if (this.#strokeSlices >= 2) {
      // The bonus is the whole point of a combo: one stroke through four fruit
      // should beat four separate strokes, or there is no reason to aim.
      const bonus = this.#strokeSlices;
      this.#score += bonus;
      this.#comboLabel = `combo x${this.#strokeSlices}  +${bonus}`;
      this.#comboUntil = this.#simMs + 900;
      // Louder with a bigger combo, capped so a lucky six through the middle of
      // a wave does not blow the mix apart. This is what `gainScale` is for: one
      // cue, varied per instance, instead of five near-identical entries.
      this.#ctx.audio.play('slice.combo', Math.min(1, 0.6 + this.#strokeSlices * 0.12));
    }
    this.#strokeSlices = 0;
  }

  /** Test one blade segment against every live fruit. */
  #cut(x0: number, y0: number, x1: number, y1: number): void {
    for (const f of this.#fruit) {
      if (!f.active) continue;
      if (!segmentIntersectsCircle(x0, y0, x1, y1, f.x, f.y, f.radius)) continue;

      f.active = false;
      f.mesh.visible = false;

      if (f.bomb) {
        this.#ctx.audio.play('slice.bomb');
        this.#finish(true);
        return;
      }

      this.#score++;
      this.#strokeSlices++;
      // One stroke can cut several fruit in the same step. The cue is throttled
      // in `audio/cues.ts` rather than here — how many swishes a flurry is worth
      // is a mixing question, and the game should not be second-guessing it.
      this.#ctx.audio.play('slice');
      this.#spawnHalves(f, x1 - x0, y1 - y0);
    }
  }

  /* ------------------------------------------------------------ simulation */

  #advanceFruit(dt: number): void {
    for (const f of this.#fruit) {
      if (!f.active) continue;

      f.prevX = f.x;
      f.prevY = f.y;
      f.prevAngle = f.angle;

      f.vy += GRAVITY * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.angle += f.spin * dt;

      // Fallen back out of the world.
      if (f.vy < 0 && f.y < SPAWN_Y - 0.6) {
        f.active = false;
        f.mesh.visible = false;
        // A dropped bomb is a relief, not a penalty — only fruit cost a life.
        if (!f.bomb && this.#started) this.#loseLife();
      }
    }
  }

  #advanceHalves(dt: number): void {
    for (const h of this.#halves) {
      if (!h.active) continue;

      h.prevX = h.x;
      h.prevY = h.y;
      h.prevAngle = h.angle;

      h.vy += GRAVITY * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.angle += h.spin * dt;

      if (h.y < SPAWN_Y - 1) {
        h.active = false;
        h.mesh.visible = false;
      }
    }
  }

  #loseLife(): void {
    this.#lives--;
    this.#ctx.audio.play('life.lost');
    if (this.#lives <= 0) this.#finish(false);
  }

  #finish(byBomb: boolean): void {
    if (this.#over) return;
    this.#over = true;
    this.#lives = Math.max(0, this.#lives);
    this.#ctx.end({
      score: this.#score,
      detail: byBomb ? 'sliced a bomb' : `sliced ${this.#score}`,
      record: saveBest(this.#score),
    });
  }

  /* -------------------------------------------------------------- spawning */

  #maybeSpawn(dt: number): void {
    this.#spawnAt -= dt;
    if (this.#spawnAt > 0) return;

    // Ramp toward the floor rather than stepping: difficulty that arrives in
    // jumps reads as the game breaking rather than as it getting harder.
    const eased = Math.max(SPAWN_INTERVAL_MIN, SPAWN_INTERVAL_START - this.#score * 0.012);
    this.#spawnAt = eased * (0.75 + this.#random() * 0.5);

    // Occasional pairs and triples — the only way a combo is reachable at all.
    const burst = this.#score > 6 && this.#random() < 0.3 ? (this.#random() < 0.35 ? 3 : 2) : 1;
    for (let i = 0; i < burst; i++) this.#throwOne();
  }

  #throwOne(): void {
    // No bombs until the player has found the rhythm, then a slowly rising
    // share, capped so the screen never becomes mostly bombs.
    const bombChance = this.#score < 5 ? 0 : Math.min(0.22, 0.04 + this.#score * 0.006);
    const bomb = this.#random() < bombChance;

    const f = this.#take(bomb);

    f.x = (this.#random() * 2 - 1) * SPAWN_X;
    f.y = SPAWN_Y;
    // Solve for the launch speed that reaches the intended apex exactly, so no
    // throw ever leaves the top of the screen or stalls halfway up.
    const apex = APEX_MIN + this.#random() * (APEX_MAX - APEX_MIN);
    f.vy = Math.sqrt(2 * -GRAVITY * (apex - SPAWN_Y));
    // Drift back toward the middle, so throws from the edges stay reachable.
    f.vx = -f.x * 0.17 + (this.#random() * 2 - 1) * 0.6;
    f.spin = (this.#random() * 2 - 1) * 2.4;
    f.angle = 0;
    f.prevX = f.x;
    f.prevY = f.y;
    f.prevAngle = 0;
  }

  /** Reuse a spent fruit, or grow the pool once and never again. */
  #take(bomb: boolean): Fruit {
    let f = this.#fruit.find((c) => !c.active && c.bomb === bomb);
    if (!f) {
      const mesh = new Mesh(
        bomb ? this.#bombGeometry : this.#fruitGeometry,
        bomb ? this.#bombMaterial : (this.#fruitMaterials[0] as MeshBasicMaterial),
      );
      this.#group.add(mesh);

      if (bomb) {
        // A red pip, so a bomb is never mistaken for a dark fruit.
        const fuse = new Mesh(
          new CircleGeometry(BOMB_RADIUS * 0.3, 12),
          new MeshBasicMaterial({ color: BOMB_FUSE }),
        );
        fuse.position.set(0, BOMB_RADIUS * 0.55, 0.01);
        mesh.add(fuse);
      } else {
        // Children in a fixed order — `#restyle` addresses them by index, and
        // reordering here without changing it would recolour the wrong one.
        const flesh = new Mesh(
          new CircleGeometry(FRUIT_RADIUS * 0.66, 24),
          this.#fleshMaterials[0] as MeshBasicMaterial,
        );
        flesh.position.z = 0.01;
        const shine = new Mesh(
          new CircleGeometry(FRUIT_RADIUS * 0.19, 12),
          this.#shineMaterials[0] as MeshBasicMaterial,
        );
        shine.position.set(-FRUIT_RADIUS * 0.34, FRUIT_RADIUS * 0.36, 0.02);
        mesh.add(flesh, shine);
      }

      f = {
        mesh,
        active: false,
        bomb,
        radius: bomb ? BOMB_RADIUS : FRUIT_RADIUS,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        spin: 0,
        angle: 0,
        prevX: 0,
        prevY: 0,
        prevAngle: 0,
        colorIndex: 0,
      };
      this.#fruit.push(f);
    }

    if (!bomb) {
      const pick = Math.floor(this.#random() * FRUIT_COLORS.length) % FRUIT_COLORS.length;
      f.colorIndex = pick;
      this.#restyle(f.mesh, pick);
    }
    f.active = true;
    f.mesh.visible = true;
    return f;
  }

  /**
   * Recolour a pooled fruit and its children to one palette entry.
   *
   * Addresses the children positionally, which is why `#take` builds them in a
   * fixed order and says so. A named lookup would be safer and costs a string
   * compare per fruit per spawn; the comment is the cheaper guard.
   */
  #restyle(mesh: Mesh, index: number): void {
    mesh.material = this.#fruitMaterials[index] as MeshBasicMaterial;
    const flesh = mesh.children[0] as Mesh | undefined;
    const shine = mesh.children[1] as Mesh | undefined;
    if (flesh) flesh.material = this.#fleshMaterials[index] as MeshBasicMaterial;
    if (shine) shine.material = this.#shineMaterials[index] as MeshBasicMaterial;
  }

  /** Two halves flying apart, perpendicular to the cut. Cosmetic only. */
  #spawnHalves(from: Fruit, cutX: number, cutY: number): void {
    const len = Math.hypot(cutX, cutY) || 1;
    const dx = cutX / len;
    const dy = cutY / len;
    // Perpendicular to the stroke — the halves separate *across* the cut, which
    // is what makes the stroke's direction legible after the fact.
    const nx = -dy;
    const ny = dx;
    const angle = Math.atan2(dy, dx);

    for (const which of [0, 1] as const) {
      const sign = which === 0 ? 1 : -1;
      const h = this.#takeHalf(which, from.colorIndex);
      h.x = from.x;
      h.y = from.y;
      h.prevX = from.x;
      h.prevY = from.y;
      h.vx = from.vx + nx * sign * 2.1;
      h.vy = from.vy + ny * sign * 2.1;
      h.spin = sign * 3.2;
      h.angle = angle;
      h.prevAngle = angle;
    }
  }

  #takeHalf(which: 0 | 1, colorIndex: number): Half {
    let h = this.#halves.find((c) => !c.active && c.which === which);
    if (!h) {
      const mesh = new Mesh(
        this.#halfGeometries[which],
        this.#fruitMaterials[colorIndex] as MeshBasicMaterial,
      );
      // A slightly inset flesh face, so a cut half shows rind at its rim and
      // pale flesh across the cut — the thing that says it was *sliced* rather
      // than merely broken into two discs.
      const flesh = new Mesh(
        new CircleGeometry(
          FRUIT_RADIUS * 0.82,
          24,
          which === 0 ? 0 : Math.PI,
          Math.PI,
        ),
        this.#fleshMaterials[colorIndex] as MeshBasicMaterial,
      );
      flesh.position.z = 0.01;
      mesh.add(flesh);
      this.#group.add(mesh);
      h = {
        mesh,
        active: false,
        which,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        spin: 0,
        angle: 0,
        prevX: 0,
        prevY: 0,
        prevAngle: 0,
        colorIndex,
      };
      this.#halves.push(h);
    }

    if (h.colorIndex !== colorIndex) {
      h.colorIndex = colorIndex;
      h.mesh.material = this.#fruitMaterials[colorIndex] as MeshBasicMaterial;
      const flesh = h.mesh.children[0] as Mesh | undefined;
      if (flesh) flesh.material = this.#fleshMaterials[colorIndex] as MeshBasicMaterial;
    }
    h.active = true;
    h.mesh.visible = true;
    return h;
  }

  /* ---------------------------------------------------------------- helpers */

  #reset(): void {
    this.#started = false;
    this.#over = false;
    this.#score = 0;
    this.#lives = LIVES;
    this.#simMs = 0;
    this.#spawnAt = 0;
    this.#cutting = false;
    this.#strokeSlices = 0;
    this.#comboLabel = '';
    this.#seed = 0x51ce;

    this.#trail.length = 0;
    this.#blade.clear();
    this.#axisX.reset();
    this.#axisY.reset();

    for (const f of this.#fruit) {
      f.active = false;
      f.mesh.visible = false;
    }
    for (const h of this.#halves) {
      h.active = false;
      h.mesh.visible = false;
    }

    this.#ctx.overlay.setStatus('swipe to slice', 'good');
  }

  /** xorshift — deterministic, so a run can be reproduced from its seed. */
  #random(): number {
    let x = this.#seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#seed = x >>> 0;
    return (this.#seed % 100_000) / 100_000;
  }
}

/* ----------------------------------------------------------------- helpers */

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const BEST_KEY = 'wii.fruit-slash.best';

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
 * Aim, and nothing else.
 *
 * No `swing`, no `shake`. This is the mapping that proves T1.7 was worth doing:
 * a slice is where the phone points, sampled over time, so the only bindings the
 * game needs are the two pointing axes — plus `b`, which `PlayScene` turns into
 * backing out to the menu for every game.
 *
 * `aim.x`/`aim.y` are the names the grip preference recognises, so a player's
 * inversion applies here exactly as it does to the debug cursor.
 *
 * The range is tighter than the debug cursor's 40°: slicing wants the whole
 * screen inside a flick of the wrist, not a deliberate sweep.
 */
const FRUIT_MAPPING: InputMapping = {
  buttons: { b: 'quit' },
  axes: {
    'aim.x': { source: 'point.x', rangeDeg: 34, deadzoneDeg: 1 },
    'aim.y': { source: 'point.y', rangeDeg: 34, deadzoneDeg: 1 },
  },
};

export const fruitSlash: GameModule = {
  id: 'fruit-slash',
  title: 'Fruit slash',
  blurb: 'Point and swipe. Mind the bombs.',
  grip: 'any — calibrate, then aim where you look',
  mapping: FRUIT_MAPPING,
  create: (ctx) => new FruitSlash(ctx),
};
