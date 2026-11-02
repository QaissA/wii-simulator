/**
 * Haptics — Vibration API wrapper.
 *
 * `docs/layer-1-controller.md` §Modules: "Vibration API on button press and
 * gesture."
 *
 * Unsupported everywhere on iOS Safari, so every call is best-effort and the UI
 * must never depend on one having happened.
 *
 * TODO(on-device): UNVERIFIED on Android — confirm the patterns actually fire and
 * that press/release feel distinct rather than blurring into one buzz. Expected
 * to be silently absent on iOS; confirm that too, so it is a known gap rather
 * than a suspected bug during playtesting. Plan ref: T1.4.
 */

const supported = (): boolean => typeof navigator.vibrate === 'function';

/** Vibrate for `ms`, or run `pattern`. Silently does nothing where unsupported. */
export function vibrate(pattern: number | number[]): void {
  if (!supported()) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* some browsers throw when the page is not visible */
  }
}

export const haptics = {
  /** Crisp tap for a button press. */
  press: (): void => vibrate(12),
  /** Softer tick for a release, so press and release feel distinct. */
  release: (): void => vibrate(6),
  /** Heavier, two-beat thump for a recognized gesture. */
  gesture: (): void => vibrate([18, 24, 30]),
  /** Double pulse confirming calibration. */
  confirm: (): void => vibrate([10, 60, 10]),
  get supported(): boolean {
    return supported();
  },
};
