/**
 * Star fighter — a shoot-'em-up. Point to fly, waves of aliens, weapon pickups.
 *
 * The fourth game, and the second built entirely on T1.7's pointing axes. Where
 * fruit slash asks *where the phone points* and tests a stroke, this asks the
 * same question and flies a ship there — which is the cheapest possible evidence
 * that the pointing frame is a general-purpose input rather than one game's
 * trick.
 *
 * ## What it needed that did not exist: nothing
 *
 * No new engine capability, no protocol change, no gesture work. It is a mapping
 * literal, this file, and one line of the registry — the fourth time §Phase 3c's
 * claim has held. Notably it does **not** need T1.8: a shmup wants continuous
 * aim, not directional flicks, so it was buildable the moment T1.7 landed.
 *
 * ## The one shared thing it reuses
 *
 * `segmentIntersectsCircle` from `packages/engine/src/geometry.ts`, which the
 * third game contributed. Bullets here move ~14 world units per second at a
 * 60 Hz step — over a third of an alien's diameter per step, and far more for
 * the fastest ones — so testing bullet *positions* would let shots pass straight
 * through an enemy between two frames. That is exactly the defect the swept test
 * was written for, and it is the plan's rule paying off rather than a
 * coincidence: *"the second and third games are what reveal what actually wants
 * to be shared."*
 *
 * ## Auto-fire, and why the button is a bomb
 *
 * Holding a fire button while aiming a phone is genuinely awkward — the thumb
 * that holds it is on the hand doing the aiming, and the tremor shows up in the
 * cursor. So the guns are automatic and `a` is a smart bomb with limited
 * charges, which is both a genre staple and a decision the player makes rather
 * than a key they hold down.
 *
 * All gameplay runs in the fixed-step `update`; `render` only interpolates. The
 * ship is the one exception, drawn from render-time prediction so aiming stays
 * immediate — the same split, and the same reason, as fruit slash's cursor.
 */

import {
  BoxGeometry,
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

import { gradientPlane, starField } from '../../render/decor.js';
import type { GameContext, GameInstance, GameModule } from '../module.js';

/* ------------------------------------------------------------------ tuning */

const VIEW_HEIGHT = 10;
const VIEW_WIDTH = 17.8;

/** How far the ship may fly from centre, world units. */
const SPAN_X = VIEW_WIDTH / 2 - 1.1;
/**
 * The ship's vertical band.
 *
 * Deliberately narrow and low. A shmup reads bottom-to-top: the player needs to
 * see what is coming, and a ship free to fly into the formation turns aiming
 * into dodging at a range where nothing can be dodged.
 */
const SHIP_Y_MIN = -VIEW_HEIGHT / 2 + 0.9;
const SHIP_Y_MAX = -VIEW_HEIGHT / 2 + 3.4;

const SHIP_RADIUS = 0.34;
const ALIEN_RADIUS = 0.42;
const PICKUP_RADIUS = 0.3;

const BULLET_SPEED = 14;
const ALIEN_BULLET_SPEED = 6.2;
const BULLET_RADIUS = 0.09;

/** Seconds between the player's shots, by weapon level (index 0 unused). */
const FIRE_INTERVAL = [0.24, 0.24, 0.19, 0.16, 0.14];
/** Highest weapon level. Beyond this a pickup is worth points instead. */
const MAX_WEAPON = 4;

const LIVES = 3;
const BOMBS = 2;

/**
 * Invulnerability after a hit, seconds.
 *
 * Long enough to fly clear of whatever killed you. Without it a bullet stream
 * takes every life in the time it takes to notice the first one.
 */
const RESPAWN_GRACE = 1.6;

/** Formation geometry. */
const COLS = 8;
const ROWS = 3;
const ALIEN_GAP_X = 1.55;
const ALIEN_GAP_Y = 1.15;
const FORMATION_TOP = VIEW_HEIGHT / 2 - 1.2;

/** How fast the formation sways and creeps down, per wave. */
const SWAY_SPEED = 0.55;
const SWAY_WIDTH = 1.5;
const DESCENT_BASE = 0.16;
const DESCENT_PER_WAVE = 0.05;

/** Chance per alien per second of taking a shot, scaled by wave. */
const FIRE_CHANCE_BASE = 0.09;
const FIRE_CHANCE_PER_WAVE = 0.025;

/** Line the aliens must not cross. Reaching it ends the round outright. */
const INVASION_Y = SHIP_Y_MAX + 0.6;

/** Chance a destroyed alien drops a weapon pickup. */
const DROP_CHANCE = 0.14;
const PICKUP_FALL_SPEED = 2.1;

const SCORE_PER_ALIEN = 10;
const SCORE_PER_WAVE = 100;
const SCORE_PER_SPARE_PICKUP = 25;

/* ---------------------------------------------------------------- palette */

const SPACE_TOP = 0x05070f;
const SPACE_BOTTOM = 0x141d33;

const SHIP_COLOR = 0x6fd3ff;
const SHIP_TRIM = 0xffffff;
const SHIP_FLAME = 0xffb03a;

const BULLET_COLOR = 0xfff0a8;
const ALIEN_BULLET_COLOR = 0xff7a6b;

/** One colour per formation row, so a wave reads as ranks rather than a blob. */
const ALIEN_COLORS = [0xc86bff, 0x4ec5d6, 0x8ed35b];
const ALIEN_EYE = 0x0b1020;

const PICKUP_COLOR = 0xffd166;

/* ------------------------------------------------------------------ actors */

interface Moving {
  mesh: Mesh | Group;
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  prevX: number;
  prevY: number;
}

interface Bullet extends Moving {
  mesh: Mesh;
  /** Fired by the player, rather than at them. */
  friendly: boolean;
}

interface Alien extends Moving {
  mesh: Group;
  row: number;
  /** Column position within the formation, for the sway offset. */
  col: number;
}

interface Pickup extends Moving {
  mesh: Group;
}

/* ------------------------------------------------------------------- game */

class StarFighter implements GameInstance {
  readonly #ctx: GameContext;
  readonly #group = new Group();
  readonly #camera: OrthographicCamera;

  readonly #ship: Group;
  readonly #flame: Mesh;
  readonly #shield: Mesh;
  readonly #stars: Group;

  readonly #bullets: Bullet[] = [];
  readonly #aliens: Alien[] = [];
  readonly #pickups: Pickup[] = [];

  readonly #alienMaterials: MeshBasicMaterial[];

  /**
   * Aim is predicted, then the ship *chases* the prediction.
   *
   * Reading the axis straight would teleport the ship, which at this speed makes
   * collisions feel arbitrary — a player who cannot see the ship travel cannot
   * tell whether they flew into a bullet or it appeared on them. The chase is a
   * simple exponential toward the target, fast enough not to read as lag.
   */
  readonly #axisX = new PredictiveAxis();
  readonly #axisY = new PredictiveAxis();

  #unsubscribe: Array<() => void> = [];

  /* simulation state */
  #shipX = 0;
  #shipY = SHIP_Y_MIN;
  #prevShipX = 0;
  #prevShipY = SHIP_Y_MIN;
  #targetX = 0;
  #targetY = SHIP_Y_MIN;

  #score = 0;
  #lives = LIVES;
  #bombs = BOMBS;
  #weapon = 1;
  #wave = 1;
  #over = false;

  #simMs = 0;
  #fireCooldown = 0;
  #grace = 0;
  #swayPhase = 0;
  /** Set when a wave is cleared; the next spawns after a short breath. */
  #nextWaveAt = 0;

  #seed = 0x5f3a72c1;

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

    const backdrop = gradientPlane(VIEW_WIDTH, VIEW_HEIGHT, SPACE_TOP, SPACE_BOTTOM);
    backdrop.position.z = -5;

    // Two star layers at different speeds. In a game where the background is
    // otherwise empty, parallax is the only thing that says the ship is moving
    // rather than the aliens falling.
    this.#stars = new Group();
    const far = starField(90, VIEW_WIDTH, VIEW_HEIGHT * 2, this.#random.bind(this), 0x8fa6c9, 1.5);
    const near = starField(40, VIEW_WIDTH, VIEW_HEIGHT * 2, this.#random.bind(this), 0xffffff, 2.5);
    far.position.z = -4.5;
    near.position.z = -4;
    this.#stars.add(far, near);

    this.#alienMaterials = ALIEN_COLORS.map((color) => new MeshBasicMaterial({ color }));

    this.#ship = new Group();

    // A triangle, nose up. Three segments of a circle is the cheapest triangle
    // Three will make, and it is centred, which keeps rotation sane.
    const hull = new Mesh(
      new CircleGeometry(SHIP_RADIUS * 1.5, 3),
      new MeshBasicMaterial({ color: SHIP_COLOR }),
    );
    hull.rotation.z = Math.PI / 2;

    const cockpit = new Mesh(
      new CircleGeometry(SHIP_RADIUS * 0.34, 12),
      new MeshBasicMaterial({ color: SHIP_TRIM }),
    );
    cockpit.position.set(0, SHIP_RADIUS * 0.18, 0.01);

    const wings = new Mesh(
      new BoxGeometry(SHIP_RADIUS * 2.6, SHIP_RADIUS * 0.34, 0.05),
      new MeshBasicMaterial({ color: new Color(SHIP_COLOR).lerp(new Color(0x000000), 0.35) }),
    );
    wings.position.set(0, -SHIP_RADIUS * 0.5, -0.01);

    this.#flame = new Mesh(
      new CircleGeometry(SHIP_RADIUS * 0.5, 3),
      new MeshBasicMaterial({ color: SHIP_FLAME, transparent: true, opacity: 0.9 }),
    );
    this.#flame.rotation.z = -Math.PI / 2;
    this.#flame.position.set(0, -SHIP_RADIUS * 1.35, -0.02);

    // Drawn only during respawn grace, and it is the *only* signal that a hit
    // did not count — without it a player reads invulnerability as the game
    // ignoring collisions.
    this.#shield = new Mesh(
      new RingGeometry(SHIP_RADIUS * 1.7, SHIP_RADIUS * 1.95, 24),
      new MeshBasicMaterial({ color: SHIP_TRIM, transparent: true, opacity: 0.5 }),
    );
    this.#shield.position.z = 0.05;
    this.#shield.visible = false;

    this.#ship.add(wings, hull, cockpit, this.#flame, this.#shield);

    this.#group.add(backdrop, this.#stars, this.#ship);
  }

  camera(): Camera {
    return this.#camera;
  }

  enter(): void {
    const ctx = this.#ctx;
    ctx.stage.setContent(this.#group);
    this.#reset();

    this.#unsubscribe.push(
      // Capture time, not arrival time — arrival makes the predictor extrapolate
      // over zero elapsed time, which looks like prediction being switched off.
      ctx.client.onFrame((_frame, captureLocalMs) => {
        this.#axisX.push(ctx.input.axis('aim.x'), captureLocalMs);
        this.#axisY.push(ctx.input.axis('aim.y'), captureLocalMs);
      }),
      ctx.input.onAction((e) => {
        if (e.phase === 'ended' || e.action !== 'bomb') return;
        this.#useBomb();
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

    this.#prevShipX = this.#shipX;
    this.#prevShipY = this.#shipY;

    this.#advanceShip(dt, simTimeMs);
    this.#advanceFormation(dt);
    this.#advanceBullets(dt);
    this.#advancePickups(dt);
    this.#fire(dt);
    this.#collide();
    this.#maybeNextWave(simTimeMs);

    if (this.#grace > 0) this.#grace -= dt;
  }

  render(alpha: number): void {
    // The ship is drawn from the render-time prediction rather than from the
    // interpolated simulation, so aiming feels immediate even though every
    // collision was already decided on the fixed step.
    const now = performance.now();
    const predictedX = clamp(this.#axisX.valueAt(now), -1, 1) * SPAN_X;
    const predictedY = mapBand(clamp(this.#axisY.valueAt(now), -1, 1));

    const simX = this.#prevShipX + (this.#shipX - this.#prevShipX) * alpha;
    const simY = this.#prevShipY + (this.#shipY - this.#prevShipY) * alpha;

    // Mostly prediction, anchored to the simulation so the two cannot drift far
    // apart — a ship drawn somewhere its collisions are not is a bug players
    // describe as "it hit me from nowhere".
    this.#ship.position.set(simX * 0.25 + predictedX * 0.75, simY * 0.25 + predictedY * 0.75, 0);
    // Bank into the turn. Cosmetic, and read off the predicted velocity so it
    // leads the movement rather than trailing it.
    this.#ship.rotation.z = clamp(-this.#axisX.velocityPerSecond * 0.16, -0.5, 0.5);

    this.#flame.scale.y = 0.8 + Math.sin(this.#simMs * 0.03) * 0.25;
    this.#shield.visible = this.#grace > 0 && Math.floor(this.#simMs / 90) % 2 === 0;

    for (const b of this.#bullets) {
      if (!b.active) continue;
      b.mesh.position.set(
        b.prevX + (b.x - b.prevX) * alpha,
        b.prevY + (b.y - b.prevY) * alpha,
        0,
      );
    }
    for (const a of this.#aliens) {
      if (!a.active) continue;
      a.mesh.position.set(
        a.prevX + (a.x - a.prevX) * alpha,
        a.prevY + (a.y - a.prevY) * alpha,
        0,
      );
    }
    for (const p of this.#pickups) {
      if (!p.active) continue;
      p.mesh.position.set(
        p.prevX + (p.x - p.prevX) * alpha,
        p.prevY + (p.y - p.prevY) * alpha,
        0,
      );
      p.mesh.rotation.z = this.#simMs * 0.004;
    }

    // Starfield drifts down, so the ship reads as flying up the screen.
    for (let i = 0; i < this.#stars.children.length; i++) {
      const layer = this.#stars.children[i];
      if (!layer) continue;
      const speed = i === 0 ? 0.00035 : 0.0009;
      layer.position.y = -((this.#simMs * speed) % VIEW_HEIGHT);
    }

    this.#ctx.overlay.setHud([
      ['score', String(this.#score)],
      ['best', String(loadBest())],
      ['wave', String(this.#wave)],
      ['lives', '*'.repeat(Math.max(0, this.#lives))],
      ['laser', `L${this.#weapon}`],
      ['bombs', this.#bombs > 0 ? '*'.repeat(this.#bombs) : '–'],
    ]);
  }

  /* -------------------------------------------------------------- movement */

  #advanceShip(dt: number, simTimeMs: number): void {
    this.#targetX = clamp(this.#axisX.valueAt(simTimeMs), -1, 1) * SPAN_X;
    this.#targetY = mapBand(clamp(this.#axisY.valueAt(simTimeMs), -1, 1));

    // Exponential chase, expressed as a half-life so it behaves the same at any
    // step rate — the rule `packages/engine/src/prediction.ts` already sets.
    const t = 1 - Math.pow(2, -(dt * 1000) / 55);
    this.#shipX += (this.#targetX - this.#shipX) * t;
    this.#shipY += (this.#targetY - this.#shipY) * t;
  }

  #advanceFormation(dt: number): void {
    this.#swayPhase += dt * SWAY_SPEED;
    const sway = Math.sin(this.#swayPhase) * SWAY_WIDTH;
    const descent = DESCENT_BASE + (this.#wave - 1) * DESCENT_PER_WAVE;
    const fireChance = FIRE_CHANCE_BASE + (this.#wave - 1) * FIRE_CHANCE_PER_WAVE;

    for (const a of this.#aliens) {
      if (!a.active) continue;
      a.prevX = a.x;
      a.prevY = a.y;

      // Column offset makes the formation breathe rather than slide rigidly —
      // the rows trail each other slightly, which reads as alive.
      a.x = (a.col - (COLS - 1) / 2) * ALIEN_GAP_X + sway * (1 + a.row * 0.12);
      a.y -= descent * dt;

      if (a.y <= INVASION_Y) {
        this.#end('the swarm got through');
        return;
      }

      if (this.#random() < fireChance * dt) this.#spawnBullet(a.x, a.y - ALIEN_RADIUS, false);
    }
  }

  #advanceBullets(dt: number): void {
    for (const b of this.#bullets) {
      if (!b.active) continue;
      b.prevX = b.x;
      b.prevY = b.y;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      const out = b.y > VIEW_HEIGHT / 2 + 1 || b.y < -VIEW_HEIGHT / 2 - 1;
      if (out) this.#retire(b);
    }
  }

  #advancePickups(dt: number): void {
    for (const p of this.#pickups) {
      if (!p.active) continue;
      p.prevX = p.x;
      p.prevY = p.y;
      p.y -= PICKUP_FALL_SPEED * dt;
      if (p.y < -VIEW_HEIGHT / 2 - 1) this.#retire(p);
    }
  }

  #fire(dt: number): void {
    this.#fireCooldown -= dt;
    if (this.#fireCooldown > 0) return;
    this.#fireCooldown = FIRE_INTERVAL[this.#weapon] ?? FIRE_INTERVAL[1] ?? 0.24;

    // Once per volley, not once per bullet. Level 4 fires three at a time and
    // three copies of the same 55 ms blip inside one step is not "louder" — it is
    // the same waveform tripled, which reads as a fatter click and nothing else.
    this.#ctx.audio.play('shoot');

    const y = this.#shipY + SHIP_RADIUS;
    switch (this.#weapon) {
      case 1:
        this.#spawnBullet(this.#shipX, y, true);
        break;
      case 2:
        this.#spawnBullet(this.#shipX - 0.22, y, true);
        this.#spawnBullet(this.#shipX + 0.22, y, true);
        break;
      case 3:
        this.#spawnBullet(this.#shipX, y + 0.1, true);
        this.#spawnBullet(this.#shipX - 0.3, y, true);
        this.#spawnBullet(this.#shipX + 0.3, y, true);
        break;
      default:
        // Spread. The angled pair trade vertical speed for coverage, which is
        // what makes the top level feel different rather than merely denser.
        this.#spawnBullet(this.#shipX, y + 0.1, true);
        this.#spawnBullet(this.#shipX - 0.3, y, true, -2.6);
        this.#spawnBullet(this.#shipX + 0.3, y, true, 2.6);
        break;
    }
  }

  /* ------------------------------------------------------------- collision */

  #collide(): void {
    for (const b of this.#bullets) {
      if (!b.active) continue;

      if (b.friendly) {
        for (const a of this.#aliens) {
          if (!a.active) continue;
          // Swept, not point-in-circle: at 14 units/second a bullet crosses more
          // than a third of an alien between steps, so testing the endpoint
          // alone drops exactly the shots that were travelling fastest.
          if (!segmentIntersectsCircle(b.prevX, b.prevY, b.x, b.y, a.x, a.y, ALIEN_RADIUS)) {
            continue;
          }
          this.#retire(b);
          this.#killAlien(a);
          break;
        }
        continue;
      }

      if (this.#grace > 0) continue;
      if (segmentIntersectsCircle(b.prevX, b.prevY, b.x, b.y, this.#shipX, this.#shipY, SHIP_RADIUS)) {
        this.#retire(b);
        this.#loseLife();
      }
    }

    // Flying into the formation is fatal too, or the safest play is to sit
    // inside it where nothing can shoot you.
    if (this.#grace <= 0) {
      for (const a of this.#aliens) {
        if (!a.active) continue;
        if (Math.hypot(a.x - this.#shipX, a.y - this.#shipY) < ALIEN_RADIUS + SHIP_RADIUS) {
          this.#killAlien(a);
          this.#loseLife();
          break;
        }
      }
    }

    for (const p of this.#pickups) {
      if (!p.active) continue;
      if (Math.hypot(p.x - this.#shipX, p.y - this.#shipY) > PICKUP_RADIUS + SHIP_RADIUS) continue;
      this.#retire(p);
      this.#ctx.audio.play('pickup');
      if (this.#weapon < MAX_WEAPON) {
        this.#weapon++;
        this.#ctx.overlay.setStatus(`laser L${this.#weapon}`, 'good');
      } else {
        // Already maxed — pay it out rather than dropping it on the floor.
        this.#score += SCORE_PER_SPARE_PICKUP;
      }
    }
  }

  /* ----------------------------------------------------------------- rules */

  #killAlien(a: Alien): void {
    this.#retire(a);
    this.#score += SCORE_PER_ALIEN * this.#wave;
    // A bomb routes through here for every alien on screen at once. Nothing is
    // guarded here on purpose: the polyphony cap in `AudioDirector` is what keeps
    // thirty simultaneous explosions from summing into a clipped click, and it is
    // tested. A second ad-hoc limit in the game would only hide it.
    this.#ctx.audio.play('explode');
    if (this.#random() < DROP_CHANCE) this.#spawnPickup(a.x, a.y);
  }

  #loseLife(): void {
    this.#lives--;
    this.#weapon = Math.max(1, this.#weapon - 1);
    this.#grace = RESPAWN_GRACE;
    this.#ctx.audio.play('ship.hit');

    if (this.#lives <= 0) {
      this.#end(`wave ${this.#wave}`);
      return;
    }
    this.#ctx.overlay.setStatus(`${this.#lives} left`, 'bad');
  }

  #useBomb(): void {
    if (this.#over || this.#bombs <= 0) return;
    this.#bombs--;
    this.#ctx.audio.play('bomb.use');

    for (const a of this.#aliens) {
      if (!a.active) continue;
      this.#score += SCORE_PER_ALIEN * this.#wave;
      this.#retire(a);
    }
    // Incoming fire goes too. A bomb that cleared the aliens but left their
    // bullets in flight would kill the player it was spent to save.
    for (const b of this.#bullets) {
      if (b.active && !b.friendly) this.#retire(b);
    }
    this.#ctx.overlay.setStatus('bomb', 'good');
  }

  #maybeNextWave(simTimeMs: number): void {
    if (this.#aliens.some((a) => a.active)) return;

    if (this.#nextWaveAt === 0) {
      this.#nextWaveAt = simTimeMs + 900;
      this.#score += SCORE_PER_WAVE * this.#wave;
      this.#ctx.audio.play('wave.clear');
      this.#ctx.overlay.setStatus(`wave ${this.#wave} cleared`, 'good');
      return;
    }
    if (simTimeMs < this.#nextWaveAt) return;

    this.#wave++;
    this.#nextWaveAt = 0;
    this.#spawnWave();
    this.#ctx.overlay.setStatus('');
  }

  #end(detail: string): void {
    if (this.#over) return;
    this.#over = true;
    this.#ctx.end({ score: this.#score, detail, record: saveBest(this.#score) });
  }

  /* ----------------------------------------------------------------- pools */

  #spawnWave(): void {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const a = this.#takeAlien(row);
        a.col = col;
        a.row = row;
        a.x = (col - (COLS - 1) / 2) * ALIEN_GAP_X;
        a.y = FORMATION_TOP - row * ALIEN_GAP_Y;
        a.prevX = a.x;
        a.prevY = a.y;
      }
    }
  }

  #takeAlien(row: number): Alien {
    let a = this.#aliens.find((c) => !c.active && c.row === row);
    if (!a) {
      const mesh = new Group();
      const material = this.#alienMaterials[row % this.#alienMaterials.length] as MeshBasicMaterial;

      const body = new Mesh(new CircleGeometry(ALIEN_RADIUS, 20), material);
      // A squashed body plus two eyes is the whole character. Anything more
      // detailed is invisible at this size and costs a draw call per alien.
      body.scale.y = 0.82;
      const eyeGeometry = new CircleGeometry(ALIEN_RADIUS * 0.19, 10);
      const eyeMaterial = new MeshBasicMaterial({ color: ALIEN_EYE });
      const left = new Mesh(eyeGeometry, eyeMaterial);
      left.position.set(-ALIEN_RADIUS * 0.3, ALIEN_RADIUS * 0.08, 0.01);
      const right = new Mesh(eyeGeometry, eyeMaterial);
      right.position.set(ALIEN_RADIUS * 0.3, ALIEN_RADIUS * 0.08, 0.01);

      mesh.add(body, left, right);
      this.#group.add(mesh);

      a = {
        mesh,
        active: false,
        row,
        col: 0,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        prevX: 0,
        prevY: 0,
      };
      this.#aliens.push(a);
    }
    a.active = true;
    a.mesh.visible = true;
    return a;
  }

  #spawnBullet(x: number, y: number, friendly: boolean, vx = 0): void {
    let b = this.#bullets.find((c) => !c.active && c.friendly === friendly);
    if (!b) {
      const mesh = new Mesh(
        new PlaneGeometry(BULLET_RADIUS * 2, BULLET_RADIUS * 4.5),
        new MeshBasicMaterial({ color: friendly ? BULLET_COLOR : ALIEN_BULLET_COLOR }),
      );
      this.#group.add(mesh);
      b = {
        mesh,
        active: false,
        friendly,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        prevX: 0,
        prevY: 0,
      };
      this.#bullets.push(b);
    }
    b.x = x;
    b.y = y;
    b.prevX = x;
    b.prevY = y;
    b.vx = vx;
    b.vy = friendly ? BULLET_SPEED : -ALIEN_BULLET_SPEED;
    b.active = true;
    b.mesh.visible = true;
  }

  #spawnPickup(x: number, y: number): void {
    let p = this.#pickups.find((c) => !c.active);
    if (!p) {
      const mesh = new Group();
      mesh.add(
        new Mesh(
          new RingGeometry(PICKUP_RADIUS * 0.55, PICKUP_RADIUS, 4),
          new MeshBasicMaterial({ color: PICKUP_COLOR }),
        ),
        new Mesh(
          new CircleGeometry(PICKUP_RADIUS * 0.34, 8),
          new MeshBasicMaterial({ color: SHIP_TRIM }),
        ),
      );
      this.#group.add(mesh);
      p = {
        mesh,
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        prevX: 0,
        prevY: 0,
      };
      this.#pickups.push(p);
    }
    p.x = x;
    p.y = y;
    p.prevX = x;
    p.prevY = y;
    p.active = true;
    p.mesh.visible = true;
  }

  #retire(actor: Moving): void {
    actor.active = false;
    actor.mesh.visible = false;
  }

  /* --------------------------------------------------------------- helpers */

  #reset(): void {
    this.#score = 0;
    this.#lives = LIVES;
    this.#bombs = BOMBS;
    this.#weapon = 1;
    this.#wave = 1;
    this.#over = false;
    this.#simMs = 0;
    this.#fireCooldown = 0;
    this.#grace = RESPAWN_GRACE;
    this.#swayPhase = 0;
    this.#nextWaveAt = 0;
    this.#seed = 0x5f3a72c1;

    this.#shipX = 0;
    this.#shipY = SHIP_Y_MIN;
    this.#prevShipX = 0;
    this.#prevShipY = SHIP_Y_MIN;

    for (const a of this.#aliens) this.#retire(a);
    for (const b of this.#bullets) this.#retire(b);
    for (const p of this.#pickups) this.#retire(p);

    this.#axisX.reset();
    this.#axisY.reset();

    this.#spawnWave();
    this.#ctx.overlay.setStatus('point to fly', 'good');
  }

  /** xorshift — deterministic, so a wave that always kills you can be looked at. */
  #random(): number {
    let x = this.#seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.#seed = x >>> 0;
    return (this.#seed % 10_000) / 10_000;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Map a -1..1 axis onto the ship's vertical band. */
function mapBand(unit: number): number {
  return SHIP_Y_MIN + ((unit + 1) / 2) * (SHIP_Y_MAX - SHIP_Y_MIN);
}

const BEST_KEY = 'wii.star-fighter.best';

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
 * Two pointing axes and one button.
 *
 * No gestures, for the same reason fruit slash has none: this game asks where
 * the phone points, and a `swing` fired by the accelerometer mid-dodge would be
 * a bomb the player did not ask for. `SWING_THRESHOLD` has no influence here.
 *
 * The vertical range is tighter than the horizontal because the ship's band is
 * shorter than its lane — matching the ranges to the space they map onto is what
 * keeps the same wrist movement feeling equally sensitive on both axes.
 */
const SHOOTER_MAPPING: InputMapping = {
  buttons: { a: 'bomb', b: 'quit' },
  axes: {
    'aim.x': { source: 'point.x', rangeDeg: 32, deadzoneDeg: 1 },
    'aim.y': { source: 'point.y', rangeDeg: 20, deadzoneDeg: 1 },
  },
};

export const starFighter: GameModule = {
  id: 'star-fighter',
  title: 'Star fighter',
  blurb: 'Point to fly. Waves of aliens, and better lasers.',
  grip: 'any — calibrate, then aim where you look',
  mapping: SHOOTER_MAPPING,
  create: (ctx) => new StarFighter(ctx),
};
