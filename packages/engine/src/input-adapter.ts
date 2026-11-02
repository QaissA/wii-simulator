/**
 * InputAdapter — network frames → abstract game actions.
 *
 * `docs/layer-3-display-engine.md` §Architecture calls this "the key seam": it
 * "converts `state`/`gesture`/`button` messages into engine actions ('swing' →
 * tennis swing or bowling release) so the same controller drives any game."
 *
 * And §Gotchas: "Keep the InputAdapter's mapping data-driven so new games don't
 * require netcode changes."
 *
 * That second line is the whole design constraint, so it is worth being precise
 * about what it rules out. A game must never ask "was button A pressed" or "what
 * is `o.g` right now". It asks for an **action** (`"swing"`) or an **axis**
 * (`"aim.x"`), and a plain data object decides which wire fields feed those. Add
 * bowling and you write a new mapping literal; you do not touch this file, the
 * transport, or the protocol.
 *
 * The adapter handles one player's stream. Multi-player (Layer 4) keeps one
 * adapter per player rather than teaching this class about identity.
 */

import { deltaDeg, quatRotate } from '@wii/protocol';
import type { Delivered, Euler, Message, Quat, StateFrame, Vec3Tuple } from '@wii/protocol';

/** Abstract, game-defined name — `"swing"`, `"jump"`, `"release"`. */
export type ActionName = string;

export type ActionPhase = 'started' | 'ended' | 'triggered';

export interface ActionEvent {
  action: ActionName;
  /**
   * `started`/`ended` bracket a held action (from a button); `triggered` is a
   * one-shot with no duration (from a gesture). Games that only care about the
   * moment of activation can ignore `ended` entirely.
   */
  phase: ActionPhase;
  /** Local receive time, ms — already stamped by Layer 2. */
  t: number;
  /** Gesture strength where the source provides one. */
  value?: number;
}

/**
 * Which orientation component feeds an axis.
 *
 * `alpha`/`beta`/`gamma` read one Euler angle directly. They are kept because
 * some axes genuinely want one angle — a menu highlight driven by roll, say —
 * and because they cost nothing.
 *
 * `point.x`/`point.y` are the ones a pointing game wants, and the reason T1.7
 * exists. They ask **where the phone is pointing** rather than what a named
 * angle is doing, which is one stable question at any grip where the angle is
 * three different questions depending on how the phone is held.
 */
export type AxisSource = 'alpha' | 'beta' | 'gamma' | 'point.x' | 'point.y';

/** The two sources that read the quaternion rather than an angle. */
export const isPointingSource = (s: AxisSource): boolean => s === 'point.x' || s === 'point.y';

/**
 * Which way the phone "points", in the **device** frame.
 *
 * Out of the back of the phone, which is where a screen-facing grip aims — the
 * way people actually pick a phone up. A phone held flat and aimed away like a
 * Wii remote points along its own `+y` instead, so that grip is a mapping
 * literal (`forward: [0, 1, 0]`) and not a code change. That is the seam working
 * as intended: grip is data.
 */
export const DEFAULT_FORWARD: Vec3Tuple = [0, 0, -1];

export interface AxisBinding {
  source: AxisSource;
  /**
   * Degrees mapped to the full -1..1 output. 45 means ±45° covers the range;
   * beyond that the axis clamps.
   */
  rangeDeg: number;
  /**
   * Degrees around centre treated as zero. Real sensors never sit still, so
   * without this a resting hand produces constant low-level drift.
   */
  deadzoneDeg?: number;
  invert?: boolean;
  /**
   * Pointing sources only: the device-frame vector treated as "forward".
   * Defaults to `DEFAULT_FORWARD`. Ignored by the angle sources.
   */
  forward?: Vec3Tuple;
}

/** Everything an axis can be computed from — one state frame's orientation. */
export interface Orientation {
  /** Calibrated orientation. Authoritative. */
  q: Quat;
  /** The same rotation as angles, for the angle-named sources. */
  o: Euler;
}

/**
 * The data-driven part. A game supplies one of these; nothing else changes.
 *
 * ```ts
 * const tennis: InputMapping = {
 *   buttons:  { a: 'swing', b: 'lob' },
 *   gestures: { swing: 'swing', shake: 'taunt' },
 *   axes:     { 'aim.x': { source: 'gamma', rangeDeg: 45, deadzoneDeg: 2 } },
 * };
 * ```
 */
export interface InputMapping {
  buttons?: Record<string, ActionName>;
  gestures?: Record<string, ActionName>;
  axes?: Record<string, AxisBinding>;
}

const RAD = 180 / Math.PI;

const eulerField = (o: Euler, source: AxisSource): number =>
  source === 'alpha' ? o.a : source === 'beta' ? o.b : o.g;

/**
 * How far off centre the phone is pointing, in degrees, on one screen axis.
 *
 * Rotate the forward vector by the calibrated quaternion and read where it
 * lands. At the calibration pose the rotation is identity, so the vector sits at
 * `forward` and both angles read zero — the cursor is centred, by construction,
 * whatever grip was calibrated.
 *
 * Signs, since they decide whether the cursor tracks the hand or mirrors it.
 * With the default forward (`-z`, out of the back of the phone):
 *
 *   - Turning the phone to aim **right** rotates `-z` toward device `+x`, so
 *     `p.x` goes positive and the azimuth does too. Right is positive.
 *   - Tipping the phone to aim **up** rotates `-z` toward device `+y`, so `p.y`
 *     goes positive and so does the elevation. Up is positive.
 *
 * Both match screen coordinates with no inversion, which is the point: the
 * `invert: true` that both debug axes used to carry was compensating for the
 * Euler representation, not for anything physical.
 *
 * **Roll about the pointing axis does not move the vector at all.** That is the
 * property Euler angles could not offer and the whole reason the games can be
 * built on this: a player who rolls their wrist mid-swing does not drag the
 * cursor sideways.
 *
 * One caveat worth stating rather than discovering. Azimuth and elevation are a
 * valid decomposition of where the vector points, but not an isometric one —
 * like longitude and latitude, a fixed angular step covers more azimuth the
 * further it sits from centre. Inside a ±40° binding the error is well under 1%,
 * far below what a hand can hold, but a mapping that opened the range to ±80°
 * would start to feel it near the corners.
 */
function pointingDeg(q: Quat, binding: AxisBinding): number {
  const f = normalize(binding.forward ?? DEFAULT_FORWARD);
  const { right, up } = pointingFrame(f);
  const p = quatRotate(q, f);

  if (binding.source === 'point.y') {
    // Clamped because `asin` outside [-1, 1] is NaN, and a NaN axis propagates
    // silently all the way into the render rather than failing anywhere useful.
    return Math.asin(Math.max(-1, Math.min(1, dot(p, up)))) * RAD;
  }
  // Measured against the forward direction rather than a fixed axis, so it stays
  // continuous through straight-ahead instead of flipping sign there.
  return Math.atan2(dot(p, right), dot(p, f)) * RAD;
}

/**
 * `"swing:left"` → `"swing"`. A name with no colon is returned unchanged.
 *
 * Split on the *first* colon so a future `"swing:left:hard"` still degrades to
 * `"swing"` rather than to something no mapping has heard of.
 */
function baseGesture(name: string): string {
  const at = name.indexOf(':');
  return at === -1 ? name : name.slice(0, at);
}

const dot = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const cross = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function normalize(v: Vec3Tuple): Vec3Tuple {
  const n = Math.hypot(v[0], v[1], v[2]);
  // A zero forward vector is a typo in a mapping literal, not a runtime state.
  // Falling back keeps it a mis-aimed cursor rather than a screen full of NaN.
  return n === 0 ? DEFAULT_FORWARD : [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * The screen-aligned axes to measure deflection against, for a given forward.
 *
 * Built from `forward` rather than hardcoded, which is what makes `forward` a
 * real mapping knob: with the default (`-z`, a screen-facing grip) this returns
 * device `+x` and `+y`, exactly the fixed axes an earlier version assumed. With
 * a flat, Wii-remote grip (`+y`) it returns `+x` and `+z` instead — and both
 * grips read dead centre at their own calibration pose, which is the property
 * that matters and the one hardcoding quietly broke.
 */
function pointingFrame(f: Vec3Tuple): { right: Vec3Tuple; up: Vec3Tuple } {
  // Any hint not parallel to `f` works; `+y` (up the screen) keeps the default
  // grip's axes exactly on the device axes. Swap it when `f` is nearly parallel,
  // or the cross product collapses to zero and the frame is undefined.
  const hint: Vec3Tuple = Math.abs(dot(f, [0, 1, 0])) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  const right = normalize(cross(f, hint));
  return { right, up: cross(right, f) };
}

/**
 * Map one binding to -1..1.
 *
 * The angle sources use `deltaDeg` rather than plain subtraction so an axis
 * behaves sanely across the ±180 wrap — an alpha-driven axis is otherwise
 * discontinuous exactly where a player turns around. The pointing sources need
 * no such care: azimuth and elevation are already wrapped by construction.
 */
export function applyBinding(orientation: Orientation, binding: AxisBinding): number {
  const raw = isPointingSource(binding.source)
    ? pointingDeg(orientation.q, binding)
    : deltaDeg(0, eulerField(orientation.o, binding.source));
  const dead = binding.deadzoneDeg ?? 0;

  const magnitude = Math.abs(raw);
  if (magnitude <= dead) return 0;

  // Rescale past the deadzone so the axis still reaches ±1 at full range, rather
  // than losing the deadzone's worth of travel off the top.
  const span = Math.max(binding.rangeDeg - dead, Number.EPSILON);
  const scaled = ((magnitude - dead) / span) * Math.sign(raw);
  const clamped = Math.max(-1, Math.min(1, scaled));
  return binding.invert ? -clamped : clamped;
}

export class InputAdapter {
  #mapping: InputMapping;
  readonly #axes = new Map<string, number>();
  readonly #active = new Set<ActionName>();
  readonly #listeners = new Set<(e: ActionEvent) => void>();

  /** Latest orientation seen, so axes can be recomputed on a mapping swap. */
  #lastOrientation: Orientation | null = null;

  constructor(mapping: InputMapping = {}) {
    this.#mapping = mapping;
    this.#resetAxes();
  }

  /**
   * Swap the mapping at runtime — changing game, or rebinding.
   *
   * Held actions are released first. Without that, an action held under the old
   * mapping would stay stuck active forever, since its `ended` event will arrive
   * addressed to a binding that no longer exists.
   */
  setMapping(mapping: InputMapping, t = 0): void {
    for (const action of [...this.#active]) {
      this.#active.delete(action);
      this.#emit({ action, phase: 'ended', t });
    }
    this.#mapping = mapping;
    this.#resetAxes();
    if (this.#lastOrientation) this.#updateAxes(this.#lastOrientation);
  }

  get mapping(): InputMapping {
    return this.#mapping;
  }

  onAction(fn: (e: ActionEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** Feed one delivered message. Unmapped inputs are ignored, not errors. */
  apply(msg: Delivered | Message): void {
    const t = 'recvTs' in msg ? msg.recvTs : 0;

    switch (msg.type) {
      case 'state': {
        this.#lastOrientation = { q: msg.q, o: msg.o };
        this.#updateAxes(this.#lastOrientation);
        this.#syncHeldButtons(msg, t);
        return;
      }
      case 'button': {
        const action = this.#mapping.buttons?.[msg.name];
        if (!action) return;
        this.#setActive(action, msg.down, t);
        return;
      }
      case 'gesture': {
        // A directional gesture arrives as `"swing:left"` (T1.8). Try the specific
        // name first, then the part before the colon.
        //
        // That fallback is what lets direction ship without breaking a single
        // existing mapping: Flappy maps `swing` and neither knows nor cares which
        // way the flick went, while an endless runner maps `swing:left` and gets
        // the lane change. Both read the same wire event.
        //
        // It also means a controller predating T1.8 keeps working unchanged,
        // which is why direction rode into the *name* rather than into a new
        // field that would have forced a `PROTOCOL_VERSION` bump.
        const action = this.#mapping.gestures?.[msg.name] ?? this.#mapping.gestures?.[baseGesture(msg.name)];
        if (!action) return;
        // One-shot: no matching `ended`, so a game reacts on arrival.
        this.#emit({ action, phase: 'triggered', t });
        return;
      }
      default:
        // join/ping/pong carry no game input.
        return;
    }
  }

  /** Current value of a mapped axis, -1..1. Unknown axes read 0. */
  axis(name: string): number {
    return this.#axes.get(name) ?? 0;
  }

  /** True while a held action is active. */
  isActive(action: ActionName): boolean {
    return this.#active.has(action);
  }

  get activeActions(): readonly ActionName[] {
    return [...this.#active];
  }

  /** Clear all state — use between rounds so nothing leaks across a reset. */
  reset(): void {
    this.#active.clear();
    this.#lastOrientation = null;
    this.#resetAxes();
  }

  #resetAxes(): void {
    this.#axes.clear();
    for (const name of Object.keys(this.#mapping.axes ?? {})) this.#axes.set(name, 0);
  }

  #updateAxes(orientation: Orientation): void {
    const axes = this.#mapping.axes;
    if (!axes) return;
    for (const [name, binding] of Object.entries(axes)) {
      this.#axes.set(name, applyBinding(orientation, binding));
    }
  }

  /**
   * Reconcile held actions against the authoritative `btn` list on every state
   * frame.
   *
   * Button events are reliable, so in theory this is redundant. In practice a
   * client that reconnects mid-press missed the `down` that happened before it
   * joined, and a `up` sent while the link was down is simply gone — Layer 2
   * queues reliable traffic but drops it after a disconnect. The 50 Hz state
   * frame carries the truth, so it wins. Without this, a reconnect can leave a
   * player permanently holding, or unable to hold, a button.
   */
  #syncHeldButtons(frame: StateFrame, t: number): void {
    const buttons = this.#mapping.buttons;
    if (!buttons) return;

    const shouldBeActive = new Set<ActionName>();
    for (const name of frame.btn) {
      const action = buttons[name];
      if (action) shouldBeActive.add(action);
    }

    // Only actions this mapping sources from buttons may be corrected here —
    // gesture-triggered actions are one-shots and never appear in `btn`.
    for (const action of Object.values(buttons)) {
      const wanted = shouldBeActive.has(action);
      if (wanted !== this.#active.has(action)) this.#setActive(action, wanted, t);
    }
  }

  #setActive(action: ActionName, active: boolean, t: number): void {
    if (active) {
      if (this.#active.has(action)) return; // ignore repeats, emit edges only
      this.#active.add(action);
      this.#emit({ action, phase: 'started', t });
    } else {
      if (!this.#active.delete(action)) return;
      this.#emit({ action, phase: 'ended', t });
    }
  }

  #emit(e: ActionEvent): void {
    for (const fn of [...this.#listeners]) fn(e);
  }
}
