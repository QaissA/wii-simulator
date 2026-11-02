/**
 * Pointing preference — which way a tilt moves things.
 *
 * ## What this used to be, and why most of it is gone
 *
 * Before T1.7 this file carried three knobs (`X`, `Y`, `S`) because the axes
 * were driven by named Euler angles, and named Euler angles mean different
 * things in different grips:
 *
 *   flat, pointing away (a Wii remote)  — tilt right → right, nose up → up
 *   upright, screen facing you (a phone) — both reversed
 *
 * Worse than a sign flip, near-vertical was degenerate: `beta` approaches 90°,
 * where the Euler representation couples `alpha` and `gamma`. Leaning the phone
 * left and right then registered in `alpha`, and a `gamma`-driven axis read a
 * flat zero — an axis that looked broken rather than mis-mapped. `S` existed to
 * swap which angle drove horizontal, which is to say: to hand-patch a
 * representational defect from the far end of the wire.
 *
 * **T1.7 removed the defect rather than the symptom.** The axes now read
 * `point.x`/`point.y`, which rotate a forward vector by the calibrated
 * quaternion and ask where it lands. That is the same question in every grip, so
 * `S` has nothing left to swap and is gone, along with the stored `xSource`.
 *
 * ## What is left, and why
 *
 * `X` and `Y` stay. They are no longer compensating for anything — the pointing
 * axes are correctly signed by construction, which is why neither default is
 * inverted any more. They remain because "should aiming up move the cursor up,
 * or should it feel like a joystick" is a genuine preference some players hold,
 * and because during on-device verification they are the fastest way to tell a
 * mis-signed axis from a mis-calibrated pose.
 */

import type { AxisBinding, InputMapping } from '@wii/engine';

export interface Grip {
  /** Invert the horizontal axis. */
  x: boolean;
  /** Invert the vertical axis. */
  y: boolean;
}

/**
 * Horizontal inverted by default, and the reason is a convention, not a bug.
 *
 * The pointing math is signed for a **laser pointer**: aim right, cursor right.
 * That is correct and 16 tests in `packages/protocol/test/grip.test.js` pin it
 * across all three grips. But it is only what a hand expects when the phone is
 * held *aimed at the display*, and the sensors cannot tell that pose from its
 * mirror — gravity fixes which device axis is horizontal, never which end of it
 * faces the screen. A phone held with its aiming axis reversed reads every
 * horizontal motion backwards, and no amount of quaternion work can know.
 *
 * So it is a convention with two settings, and this is the one on-device
 * verification preferred. `X` flips it back, and the choice persists.
 */
export const DEFAULT_GRIP: Grip = { x: true, y: false };

/**
 * Versioned key.
 *
 * The stored value is a *delta* from the default mapping, so when a default
 * changes an old entry silently means the opposite of what it used to. v3 held
 * inversions chosen to compensate for the Euler axes, which the pointing axes do
 * not need — carrying them forward would leave someone with a double inversion
 * they have no reason to suspect. v4 stored a delta from an un-inverted default,
 * so every v4 entry now means its own opposite. Both are discarded rather than
 * migrated: the failure they cause is a cursor that moves backwards for reasons
 * the player cannot see, which is worse than one lost keypress.
 */
const STORAGE_KEY = 'wii.grip.v5';

export function loadGrip(): Grip {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_GRIP };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const p = parsed as Record<string, unknown>;
      return { x: p['x'] === true, y: p['y'] === true };
    }
  } catch {
    /* unavailable or corrupt — the default is a fine fallback */
  }
  return { ...DEFAULT_GRIP };
}

export function saveGrip(grip: Grip): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(grip));
  } catch {
    /* private mode — the choice just won't persist */
  }
}

/**
 * Apply the preference to a game's mapping.
 *
 * Only `aim.x` and `aim.y` are touched by name. A game with differently-named
 * axes is left alone, which is correct: this is a pointing adjustment, and a
 * game that does not point does not want it.
 *
 * Note this no longer rewrites a binding's `source`. Which source an axis reads
 * is the game's decision and is now grip-independent; all this can do is flip a
 * sign.
 */
export function applyGrip(mapping: InputMapping, grip: Grip): InputMapping {
  if (!mapping.axes) return mapping;

  const axes: Record<string, AxisBinding> = {};
  for (const [name, binding] of Object.entries(mapping.axes)) {
    const flipped = name === 'aim.x' ? grip.x : name === 'aim.y' ? grip.y : false;
    axes[name] = flipped ? { ...binding, invert: !(binding.invert ?? false) } : { ...binding };
  }
  return { ...mapping, axes };
}

/** Compact state for a HUD row: `X–`, `–Y`, `XY`. */
export function gripLabel(grip: Grip): string {
  return `${grip.x ? 'X' : '–'}${grip.y ? 'Y' : '–'}`;
}

/**
 * Bind the preference keys to the display's keyboard.
 *
 * The display's keyboard is the only input surface that is not the phone, which
 * is exactly what this needs: settling a preference takes one hand on the phone
 * and instant feedback, not a code edit and a reload per attempt.
 *
 * Returns an unsubscribe.
 */
export function bindGripKeys(current: () => Grip, onChange: (next: Grip) => void): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const key = e.key.toLowerCase();
    if (key !== 'x' && key !== 'y' && key !== 'r') return;

    const grip = current();
    const next: Grip = key === 'r' ? { ...DEFAULT_GRIP } : { ...grip, [key]: !grip[key] };

    saveGrip(next);
    onChange(next);
  };

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
