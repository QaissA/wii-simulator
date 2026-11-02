/**
 * URL conventions shared with the controller.
 *
 * These three functions are the display's half of a contract the controller
 * already implements in `apps/controller/src/modules/pairing-ui.ts`:
 *
 *   - the phone reads its room code from `?room=`;
 *   - the phone reads a relay override from `?relay=`;
 *   - therefore the QR this screen renders must be a **controller URL carrying
 *     both**, not a bare room code.
 *
 * Getting that backwards produces a QR that scans perfectly and pairs nothing.
 */

import { isValidRoomCode } from '@wii/protocol';
import type { RoomCode } from '@wii/protocol';

/** Relay port. Matches the relay's default in `apps/server/src/index.ts`. */
const RELAY_PORT = 8081;
/** Controller dev port. Matches `apps/controller/vite.config.ts`. */
const CONTROLLER_PORT = 8080;

const params = (search: string): URLSearchParams => new URLSearchParams(search);

/**
 * Fixed room code from `?room=`, if one was supplied.
 *
 * Normally the display mints its own code, but pinning it makes a reload
 * non-destructive: the phone stays paired instead of having to re-scan every
 * time the screen is refreshed, which during development is constantly.
 */
export function roomFromUrl(search = window.location.search): RoomCode | null {
  const raw = params(search).get('room');
  if (!raw) return null;
  const code = raw.toUpperCase();
  return isValidRoomCode(code) ? code : null;
}

/**
 * Relay URL. Defaults to this page's own host on the relay port — correct for
 * LAN testing — and is overridden with `?relay=` when tunnelling.
 */
export function relayUrlFor(search = window.location.search): string {
  const override = params(search).get('relay');
  if (override) return override;
  // Set at build time for hosted deploys, where the relay is on its own host.
  const hosted = import.meta.env['VITE_RELAY_URL'] as string | undefined;
  if (hosted) return hosted;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.hostname}:${RELAY_PORT}`;
}

/**
 * The URL the QR encodes: where the phone should open the controller.
 *
 * `?relay=` is propagated to the phone rather than left to it. The phone would
 * otherwise derive the relay from *its own* hostname — which, once the
 * controller is behind a tunnel, is the controller's tunnel host and not the
 * relay's. The result is a phone that loads fine and never connects, and the
 * failure is indistinguishable from the relay being down.
 */
export function controllerUrlFor(room: RoomCode, search = window.location.search): string {
  const p = params(search);
  const override = p.get('controller');
  const base =
    override ||
    (import.meta.env['VITE_CONTROLLER_URL'] as string | undefined) ||
    `${window.location.protocol}//${window.location.hostname}:${CONTROLLER_PORT}`;

  const url = new URL(base, window.location.href);
  url.searchParams.set('room', room);
  // Pass the hosted relay on too, so the phone never falls back to guessing it.
  const relay = p.get('relay') || (import.meta.env['VITE_RELAY_URL'] as string | undefined);
  if (relay) url.searchParams.set('relay', relay);
  return url.toString();
}
