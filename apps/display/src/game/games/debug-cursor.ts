/**
 * Debug cursor (T3.4) — tilt drives a dot.
 *
 * This was the vertical-slice proof, and it is now a `GameModule` like any
 * other. That move was the cheapest possible test of the T3.6 seam: if the thing
 * the display was originally built around cannot be expressed as a game module,
 * the interface is wrong. It could, and nothing below this file changed.
 *
 * It stays in the menu on purpose. It is the fastest way to answer "is the link
 * healthy and is pointing calibrated" without loading a real game, and every
 * on-device tuning session starts here.
 */

import { PredictiveAxis } from '@wii/engine';
import { LATENCY_BUDGET_MS, SEND_HZ } from '@wii/protocol';
import type { Euler } from '@wii/protocol';
import {
  Color,
  GridHelper,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  SphereGeometry,
} from 'three';

import { DEBUG_MAPPING } from '../../input/mappings.js';
import type { StatusTone } from '../../ui/overlay.js';
import type { GameContext, GameInstance, GameModule } from '../module.js';

/** Half-width and half-height of the area the cursor sweeps, world units. */
const SPAN_X = 2.4;
const SPAN_Y = 1.0;
/** Vertical centre of that area. */
const CENTRE_Y = 1.2;

const IDLE_COLOR = new Color(0x2f6fed);
const HIT_COLOR = new Color(0xffd166);

/** How long the cursor stays lit after a swing, ms. */
const FLASH_MS = 220;

/**
 * Treat an axis as pinned at this magnitude.
 *
 * `applyBinding` clamps to ±1, so an orientation outside the binding's range
 * produces a constant ±1 that never moves. Held upright, a phone sits at `beta`
 * ≈ 90° against a 40° range — the vertical axis is pinned before the player has
 * tilted anything, and reads as "up and down does not work" rather than as
 * "calibrate first".
 */
const PINNED_AT = 0.995;

/** How long an axis must stay pinned before the hint appears, ms. */
const PINNED_GRACE_MS = 700;

class DebugCursor implements GameInstance {
  readonly #ctx: GameContext;
  readonly #group = new Group();

  readonly #cursor: Mesh;
  readonly #cursorMaterial: MeshBasicMaterial;

  /**
   * Prediction runs on the *axis* value, not the raw angle — so this stays
   * ignorant of how orientation maps to gameplay, which is `InputAdapter`'s job.
   */
  readonly #axisX = new PredictiveAxis();
  readonly #axisY = new PredictiveAxis();

  #unsubscribe: Array<() => void> = [];
  #flashUntil = 0;
  #lastActionLabel = '—';
  #lastO: Euler | null = null;
  #pinnedSince: number | null = null;

  constructor(ctx: GameContext) {
    this.#ctx = ctx;

    const grid = new GridHelper(10, 20, 0x1d2739, 0x141b28);
    const target = new Mesh(
      new RingGeometry(0.34, 0.36, 64),
      new MeshBasicMaterial({ color: 0x1f2a3d }),
    );
    target.position.set(0, CENTRE_Y, -0.02);

    this.#cursorMaterial = new MeshBasicMaterial({ color: IDLE_COLOR.clone() });
    this.#cursor = new Mesh(new SphereGeometry(0.13, 32, 16), this.#cursorMaterial);
    this.#cursor.position.set(0, CENTRE_Y, 0);

    this.#group.add(grid, target, this.#cursor);
  }

  enter(): void {
    const ctx = this.#ctx;
    ctx.stage.setContent(this.#group);
    this.#axisX.reset();
    this.#axisY.reset();

    this.#unsubscribe.push(
      ctx.client.onFrame((frame, captureLocalMs) => {
        this.#lastO = frame.o;
        // Fed with the *capture* time on this machine's clock. Arrival time would
        // make prediction extrapolate over zero elapsed time and do nothing —
        // which looks like prediction being off rather than like a bug.
        this.#axisX.push(ctx.input.axis('aim.x'), captureLocalMs);
        this.#axisY.push(ctx.input.axis('aim.y'), captureLocalMs);
      }),
    );

    this.#unsubscribe.push(
      ctx.input.onAction((e) => {
        if (e.phase === 'ended') return;
        this.#lastActionLabel = `${e.action} (${e.phase})`;
        if (e.action === 'swing') {
          this.#flashUntil = Date.now() + FLASH_MS;
          this.#ctx.audio.play('debug.gesture');
        }
        if (e.action === 'reset') {
          this.#axisX.reset();
          this.#axisY.reset();
        }
      }),
    );
  }

  exit(): void {
    for (const off of this.#unsubscribe) off();
    this.#unsubscribe = [];
    this.#ctx.overlay.setHud([]);
  }

  update(): void {
    // Nothing to simulate: the cursor is driven entirely by render-time
    // prediction, because its whole purpose is to sit where the hand is *now*.
  }

  render(): void {
    const now = Date.now();
    const ax = clamp(this.#axisX.valueAt(now), -1, 1);
    const ay = clamp(this.#axisY.valueAt(now), -1, 1);

    const pinned = Math.abs(ax) >= PINNED_AT || Math.abs(ay) >= PINNED_AT;
    if (!pinned) this.#pinnedSince = null;
    else if (this.#pinnedSince === null) this.#pinnedSince = now;

    this.#cursor.position.x = ax * SPAN_X;
    this.#cursor.position.y = CENTRE_Y + ay * SPAN_Y;

    const lit = now < this.#flashUntil;
    this.#cursorMaterial.color.copy(lit ? HIT_COLOR : IDLE_COLOR);
    this.#cursor.scale.setScalar(lit ? 1.4 : 1);

    this.#paintHud(now, ax, ay);
  }

  #paintHud(now: number, ax: number, ay: number): void {
    const { client, overlay } = this.#ctx;
    const age = client.frameAgeMs(now);
    const hz = client.receiveHz;

    overlay.setHud([
      ['link', client.linkState, client.linkState === 'online' ? 'good' : 'warn'],
      ['room', client.room ?? '—'],
      ['age', age === null ? '—' : `${age.toFixed(0)} ms`, ageTone(age)],
      ['one-way', client.latencyMs === null ? '—' : `${client.latencyMs.toFixed(0)} ms`],
      ['hz', hz.toFixed(0), hz >= SEND_HZ * 0.8 ? 'good' : hz > 0 ? 'warn' : 'bad'],
      ['aim.x', ax.toFixed(2), Math.abs(ax) >= PINNED_AT ? 'bad' : 'idle'],
      ['aim.y', ay.toFixed(2), Math.abs(ay) >= PINNED_AT ? 'bad' : 'idle'],
      ['action', this.#lastActionLabel],
      ['grip', this.#ctx.gripLabel()],
      // The three angles, kept as a readout even though nothing reads them for
      // input any more (T1.7 moved the axes onto the quaternion). They stay
      // because they are still the fastest way to see that orientation is
      // arriving at all, and to recognise the near-vertical pose where the
      // Euler view goes degenerate while the cursor keeps working.
      ['alpha', this.#lastO ? this.#lastO.a.toFixed(1) : '—'],
      ['beta', this.#lastO ? this.#lastO.b.toFixed(1) : '—'],
      ['gamma', this.#lastO ? this.#lastO.g.toFixed(1) : '—'],
    ]);

    // A pinned axis is the one failure that looks like nothing happening at all,
    // so it gets said in words rather than left to be read off a static number.
    const stuck = this.#pinnedSince !== null && now - this.#pinnedSince > PINNED_GRACE_MS;
    overlay.setStatus(
      stuck
        ? 'an axis is pinned — hold the phone how you want it and press Calibrate'
        : 'tilt the phone · X/Y flip an axis · R resets · B to quit',
      stuck ? 'bad' : 'good',
    );
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Colour the age readout against the budget rather than against a feeling. */
function ageTone(age: number | null): StatusTone {
  if (age === null) return 'idle';
  if (age <= LATENCY_BUDGET_MS.good) return 'good';
  if (age <= LATENCY_BUDGET_MS.max) return 'warn';
  return 'bad';
}

export const debugCursor: GameModule = {
  id: 'debug-cursor',
  title: 'Debug cursor',
  blurb: 'Tilt moves a dot. Latency, axes and gestures, all on one screen.',
  grip: 'any — this is where you calibrate',
  mapping: DEBUG_MAPPING,
  create: (ctx) => new DebugCursor(ctx),
};
