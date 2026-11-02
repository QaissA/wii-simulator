/**
 * PairingUI — room-code entry and connection status.
 *
 * `docs/layer-1-controller.md` §Modules: "room code entry / QR scan target;
 * connection status."
 *
 * The QR path is the primary one in the finished product: the screen renders a
 * code (Layer 3, T3.1) whose URL carries `?room=XXXX`, the phone's camera opens
 * it, and pairing happens with no typing. `roomFromUrl()` is that path's landing
 * point. Manual entry stays as the fallback for when the camera is a hassle.
 */

import { ROOM_CODE_LENGTH, isValidRoomCode } from '@wii/protocol';
import type { ConnectionState } from './net-client.js';
import type { RoomCode } from '@wii/protocol';

/** Read a room code from `?room=` — where a scanned QR delivers the player. */
export function roomFromUrl(search = window.location.search): RoomCode | null {
  const raw = new URLSearchParams(search).get('room');
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return isValidRoomCode(code) ? code : null;
}

/**
 * Relay URL for a room. Defaults to the page's own host on the relay port,
 * which is right for LAN testing; override with `?relay=` when tunnelling the
 * server separately from the client.
 *
 * Port 8081 matches the relay's default (`apps/server/src/index.ts`), so LAN
 * testing needs no configuration.
 *
 * TODO(on-device): the tunnelled case is UNVERIFIED. A tunnel puts the relay on
 * a different host than the page and forces `wss://`, so the `?relay=` override
 * — not this default — is the real path for phone testing. Confirm a `wss://`
 * tunnel URL actually connects; a mixed-content block here fails in a way that
 * looks identical to the relay being down. Plan ref: T2.1.
 */
export function relayUrlFor(search = window.location.search): string {
  const override = new URLSearchParams(search).get('relay');
  if (override) return override;
  // Set at build time for hosted deploys, where the relay is on its own host.
  const hosted = import.meta.env['VITE_RELAY_URL'] as string | undefined;
  if (hosted) return hosted;
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.hostname}:8081`;
}

export interface PairingElements {
  input: HTMLInputElement;
  connectBtn: HTMLButtonElement;
  status: HTMLElement;
  message: HTMLElement;
  latency: HTMLElement;
}

export class PairingUI {
  readonly #el: PairingElements;
  #onConnect: (room: RoomCode) => void = () => {};
  #onDisconnect: () => void = () => {};
  #state: ConnectionState = 'offline';

  constructor(el: PairingElements) {
    this.#el = el;

    // Normalize as they type: codes get read aloud, so accept any casing and
    // quietly drop characters that are not in the alphabet.
    el.input.addEventListener('input', () => {
      el.input.value = el.input.value.toUpperCase().replace(/[^0-9A-Z]/g, '');
      this.#refresh();
    });

    el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') el.connectBtn.click();
    });

    el.connectBtn.addEventListener('click', () => {
      if (this.#state !== 'offline') {
        this.#onDisconnect();
        return;
      }
      const code = el.input.value;
      if (!isValidRoomCode(code)) {
        this.message(`Room codes are ${ROOM_CODE_LENGTH} characters.`);
        return;
      }
      this.#onConnect(code);
    });

    const fromUrl = roomFromUrl();
    if (fromUrl) el.input.value = fromUrl;
    this.#refresh();
  }

  onConnect(fn: (room: RoomCode) => void): void {
    this.#onConnect = fn;
  }

  onDisconnect(fn: () => void): void {
    this.#onDisconnect = fn;
  }

  /** Reflect the transport state. Called on every NetClient state change. */
  setState(state: ConnectionState, detail?: string): void {
    this.#state = state;
    const label = state === 'online' ? this.#el.input.value || 'online' : state;
    this.#el.status.textContent = state === 'offline' ? 'local' : label;
    this.#el.status.dataset['state'] = state;
    this.#el.connectBtn.textContent = state === 'offline' ? 'Connect' : 'Disconnect';
    if (detail) this.message(detail);
    else if (state === 'online') this.message('');
    this.#refresh();
  }

  setLatency(ms: number | null): void {
    this.#el.latency.textContent = ms === null ? '' : `${Math.round(ms)} ms`;
  }

  message(text: string): void {
    this.#el.message.textContent = text;
  }

  /** Auto-connect when a scanned QR supplied the code. */
  get prefilledRoom(): RoomCode | null {
    return roomFromUrl();
  }

  #refresh(): void {
    this.#el.connectBtn.disabled = this.#state === 'offline' && !isValidRoomCode(this.#el.input.value);
    this.#el.input.disabled = this.#state !== 'offline';
  }
}
