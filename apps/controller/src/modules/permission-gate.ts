/**
 * PermissionGate — the "tap to start" that satisfies iOS's user-activation
 * requirement.
 *
 * `docs/layer-1-controller.md` §Gotchas, both of which this module exists for:
 *   - "HTTPS is mandatory for sensors (localhost is exempt)."
 *   - "iOS blocks sensors unless `requestPermission()` runs inside a real tap
 *      handler."
 *
 * The second one has a sharp edge: the call must happen synchronously in the tap
 * handler. `await` anything before it and the user activation is spent, the
 * request is rejected, and the failure looks exactly like the user tapping Deny.
 *
 * TODO(on-device): THE ENTIRE iOS BRANCH IS UNTESTED. Desktop Chrome exposes no
 * `requestPermission`, so it takes the implicit-access path and exercises none of
 * the code below that matters. Only a real iPhone confirms that (a) the request
 * appears at all, (b) granting it starts the sensor stream, and (c) denying it
 * surfaces the message rather than hanging on a blank gate. Plan ref: T1.1.
 */

export type GateOutcome =
  | { ok: true }
  | { ok: false; reason: 'insecure' | 'denied' | 'unsupported' | 'error'; detail: string };

/** iOS 13+ exposes a static `requestPermission` that the type definitions omit. */
type PermissionRequester = { requestPermission?: () => Promise<PermissionState | string> };

const requesterFor = (ctor: unknown): PermissionRequester['requestPermission'] | undefined => {
  const r = (ctor as PermissionRequester | undefined)?.requestPermission;
  return typeof r === 'function' ? r.bind(ctor) : undefined;
};

/**
 * True when the page can access sensors at all. `localhost` is exempt from the
 * HTTPS rule, which is what makes desktop iteration possible.
 */
export function isSecureForSensors(): boolean {
  return window.isSecureContext;
}

/**
 * Request motion + orientation access. **Call this directly from a tap handler**
 * with no preceding `await`.
 */
export async function requestSensorAccess(): Promise<GateOutcome> {
  if (!isSecureForSensors()) {
    return {
      ok: false,
      reason: 'insecure',
      detail: 'Sensors need HTTPS. Open the tunnel URL, not the LAN address.',
    };
  }

  if (typeof DeviceMotionEvent === 'undefined' && typeof DeviceOrientationEvent === 'undefined') {
    return { ok: false, reason: 'unsupported', detail: 'This browser exposes no motion sensors.' };
  }

  const askMotion = requesterFor(DeviceMotionEvent);
  const askOrientation = requesterFor(DeviceOrientationEvent);

  // Android/desktop Chrome have no requestPermission — access is implicit.
  if (!askMotion && !askOrientation) return { ok: true };

  try {
    const results = await Promise.all(
      [askMotion, askOrientation].filter((f): f is NonNullable<typeof f> => !!f).map((f) => f()),
    );
    return results.every((r) => r === 'granted')
      ? { ok: true }
      : { ok: false, reason: 'denied', detail: 'Motion access was denied. Reload and allow it.' };
  } catch (err) {
    // Thrown when the call escaped its user activation — usually an `await`
    // sneaking in ahead of it.
    return {
      ok: false,
      reason: 'error',
      detail: err instanceof Error ? err.message : 'Permission request failed.',
    };
  }
}
