/**
 * PWAShell — service worker registration and screen wake lock.
 *
 * `docs/layer-1-controller.md` §Modules: "service worker, manifest, wake lock."
 *
 * The wake lock matters more than it looks: a controller held still for a few
 * seconds — aiming, waiting for a serve — will otherwise dim and lock, which
 * stops the sensor stream mid-game.
 */

let wakeLock: WakeLockSentinel | null = null;

/**
 * TODO(on-device): install flow UNVERIFIED. Confirm "Add to Home Screen" works
 * on both platforms and that the installed app launches fullscreen with the
 * manifest's portrait lock applied — iOS honours a different subset of manifest
 * fields than Android. Plan ref: T1.1.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    // Vite serves public/ from the site root, so this path holds in dev and build.
    await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch {
    /* the app works fine uninstalled; SW failure is not fatal */
  }
}

/**
 * Hold a screen wake lock. Re-acquires on visibility change, because the browser
 * releases the lock whenever the page is hidden and does not restore it.
 *
 * TODO(on-device): UNVERIFIED. Confirm the screen survives being held still for
 * 30 s mid-game, and that the re-acquire actually fires after switching away and
 * back. A silent failure here reads to the player as the controller randomly
 * dying, since a locked screen also stops the sensor stream. Plan ref: T1.1.
 */
export async function keepAwake(): Promise<boolean> {
  if (!('wakeLock' in navigator)) return false;
  const acquire = async (): Promise<void> => {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      /* denied, or battery saver is on */
    }
  };
  await acquire();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wakeLock === null) void acquire();
  });
  return wakeLock !== null;
}

export async function releaseWakeLock(): Promise<void> {
  try {
    await wakeLock?.release();
  } catch {
    /* already released */
  }
  wakeLock = null;
}
