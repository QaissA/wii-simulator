/**
 * Wire encode/decode — the single codec both the phone and the screen use.
 *
 * JSON today, MessagePack later: `docs/layer-1-controller.md` §Tech stack calls
 * for "JSON (dev) → MessagePack (prod)" because binary meaningfully cuts
 * bandwidth at 50 Hz. The swap point is `setWireFormat()` below; nothing else in
 * the codebase should know which format is live.
 */

import type { Message, Euler, Vec3, StateFrame, Delivered } from './types.js';
import { isValidRoomCode } from './constants.js';
import { isQuat, quatNormalize } from './quat.js';

/** A pluggable wire format. Both directions must be exact inverses. */
export interface WireFormat {
  readonly name: string;
  serialize(value: unknown): string | Uint8Array;
  deserialize(raw: string | Uint8Array): unknown;
}

export const jsonWireFormat: WireFormat = {
  name: 'json',
  serialize: (value) => JSON.stringify(value),
  deserialize: (raw) => JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)),
};

let activeFormat: WireFormat = jsonWireFormat;

/**
 * Swap the wire format process-wide. Both ends must agree, so flip this from
 * config, not per-call. Pass a MessagePack implementation here when moving to
 * production; the rest of the codebase is unaffected.
 */
export function setWireFormat(format: WireFormat): void {
  activeFormat = format;
}

export function getWireFormat(): WireFormat {
  return activeFormat;
}

/* ------------------------------- validation ------------------------------- */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Finite numbers only — NaN/Infinity survive JSON round-trips as `null`. */
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const asEuler = (v: unknown): Euler | null =>
  isObj(v) && isNum(v['a']) && isNum(v['b']) && isNum(v['g'])
    ? { a: v['a'], b: v['b'], g: v['g'] }
    : null;

const asVec3 = (v: unknown): Vec3 | null =>
  isObj(v) && isNum(v['x']) && isNum(v['y']) && isNum(v['z'])
    ? { x: v['x'], y: v['y'], z: v['z'] }
    : null;

const asButtonList = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((b) => typeof b === 'string') ? (v as string[]) : null;

/** Thrown by `decode` on anything that is not a well-formed message. */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

/**
 * Validate an already-parsed value into a `Message`.
 *
 * Returns `null` rather than throwing, so hostile or corrupt input is a normal
 * branch. Layer 4 validates input server-side for anti-cheat
 * (`docs/layer-4-backend.md` §Responsibilities) and must never crash on a
 * malformed frame.
 */
export function validate(value: unknown): Message | null {
  if (!isObj(value)) return null;

  const room = value['room'];
  const hasRoom = room !== undefined;
  if (hasRoom && !isValidRoomCode(room)) return null;
  // Built separately so `exactOptionalPropertyTypes` never sees `room: undefined`.
  const roomPart = hasRoom ? ({ room: room as string } as const) : ({} as const);

  switch (value['type']) {
    case 'state': {
      const o = asEuler(value['o']);
      const acc = asVec3(value['acc']);
      const rot = asEuler(value['rot']);
      const btn = asButtonList(value['btn']);
      const t = value['t'];
      const q = value['q'];
      if (!o || !acc || !rot || !btn || !isNum(t) || !isQuat(q)) return null;
      // Normalize on arrival rather than trusting the sender. A quaternion that
      // drifted off the unit sphere — or was never on it — makes `quatRotate`
      // scale the pointing vector as well as turn it, which reads as a pointer
      // whose sensitivity wanders. Cheap here, invisible everywhere else.
      return { type: 'state', t, q: quatNormalize(q), o, acc, rot, btn, ...roomPart };
    }
    case 'button': {
      const name = value['name'];
      const down = value['down'];
      if (typeof name !== 'string' || typeof down !== 'boolean') return null;
      return { type: 'button', name, down, ...roomPart };
    }
    case 'gesture': {
      const name = value['name'];
      if (typeof name !== 'string') return null;
      return { type: 'gesture', name, ...roomPart };
    }
    case 'join': {
      if (!isValidRoomCode(room)) return null;
      return { type: 'join', room };
    }
    case 'ping': {
      const t = value['t'];
      if (!isNum(t)) return null;
      return { type: 'ping', t };
    }
    case 'pong': {
      const t = value['t'];
      const serverT = value['serverT'];
      if (!isNum(t) || !isNum(serverT)) return null;
      return { type: 'pong', t, serverT };
    }
    default:
      return null;
  }
}

/* --------------------------------- codec --------------------------------- */

export function encode(msg: Message): string | Uint8Array {
  return activeFormat.serialize(msg);
}

/** Decode and validate. Returns `null` on anything malformed. */
export function tryDecode(raw: string | Uint8Array): Message | null {
  let parsed: unknown;
  try {
    parsed = activeFormat.deserialize(raw);
  } catch {
    return null;
  }
  return validate(parsed);
}

/** Decode, throwing on malformed input. Prefer `tryDecode` on any network edge. */
export function decode(raw: string | Uint8Array): Message {
  const msg = tryDecode(raw);
  if (!msg) throw new ProtocolError(`malformed message (${activeFormat.name})`);
  return msg;
}

/**
 * Stamp an arriving message with receive time and estimated one-way latency,
 * producing what Layer 3 actually consumes.
 */
export function stamp<M extends Message>(
  msg: M,
  recvTs: number,
  latencyMs: number | null,
): Delivered<M> {
  return { ...msg, recvTs, latencyMs };
}

/**
 * Age of a state frame at render time, ms — capture → now.
 *
 * This is the number to graph against `LATENCY_BUDGET_MS`. Requires the clocks
 * to be reconciled first (see `ClockSync.toLocal`).
 */
export function frameAge(frame: Delivered<StateFrame>, now: number): number {
  return now - frame.t;
}
