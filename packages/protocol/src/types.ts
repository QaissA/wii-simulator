/**
 * The shared input contract.
 *
 * Source of truth: `docs/00-overview.md` §Shared input contract, mirrored by
 * `docs/layer-1-controller.md` §Output contract.
 *
 * Every layer imports these types. Layers 1 and 3 must never define their own
 * copy — `docs/layer-2-transport.md` §Gotchas: "Keep control and input codecs in
 * one shared package so the phone and screen never drift."
 */

import type { Quat } from './quat.js';

/** Orientation triple, degrees. alpha (yaw) / beta (pitch) / gamma (roll). */
export interface Euler {
  a: number;
  b: number;
  g: number;
}

/** Linear acceleration (m/s²) or any 3-axis vector. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Room code shown on the screen and encoded into the QR. */
export type RoomCode = string;

/**
 * High-frequency controller state, sent at `SEND_HZ` (default 50).
 *
 * Goes on the UNRELIABLE channel. Dropping one of these is always better than
 * delaying the next — see `docs/layer-2-transport.md` §Gotchas.
 */
export interface StateFrame {
  type: 'state';
  /**
   * Capture timestamp, ms, **on the relay's clock**.
   *
   * Which clock this is measured against is part of the contract, not an
   * implementation detail. The receiver subtracts it from its own clock to get
   * frame age, and two devices' local clocks have no defined relationship — so a
   * sender must convert through `ClockSync.toRemote` before stamping, and a
   * receiver back through `ClockSync.toLocal` before using it.
   *
   * Stamping a sender-local value here instead produces a frame age that is
   * really clock skew: a plausible number that is wrong, which is worse than no
   * number at all. Layer 3 was the first code to read this field and found
   * exactly that.
   */
  t: number;
  /**
   * Calibrated orientation as a quaternion, `[x, y, z, w]`.
   *
   * **This is the field games read.** It rotates a vector from the device frame
   * into the calibrated frame, so "where is the phone pointing" is
   * `quatRotate(q, forward)` — one stable question at any attitude.
   *
   * Calibrated here means `q_neutral⁻¹ · q_current`: an actual composition of
   * rotations, unlike the per-angle subtraction `o` carries, which is only
   * valid near the pose it was captured in. Plan ref: T1.7.
   */
  q: Quat;
  /**
   * The same orientation as Euler angles, degrees — **derived from `q`**, never
   * measured alongside it, so the two cannot drift apart.
   *
   * Kept for the debug HUD and for axis bindings that name an angle directly.
   * It is not trustworthy near `beta` ±90°, where `alpha` and `gamma` collapse
   * into each other; that degeneracy is the whole reason `q` exists. Anything
   * that must be right at every attitude reads `q`.
   */
  o: Euler;
  /** Linear acceleration excluding gravity, m/s². */
  acc: Vec3;
  /** Rotation rate, deg/s. */
  rot: Euler;
  /** Names of currently-held buttons. */
  btn: string[];
  /** Present once paired; absent in local demo mode. */
  room?: RoomCode;
}

/** Discrete button transition. Reliable channel — never drop these. */
export interface ButtonEvent {
  type: 'button';
  name: string;
  down: boolean;
  room?: RoomCode;
}

/** Recognized gesture ("swing", "shake", ...). Reliable channel. */
export interface GestureEvent {
  type: 'gesture';
  name: string;
  room?: RoomCode;
}

/** Controller asking to join a room by code. Reliable channel. */
export interface JoinMessage {
  type: 'join';
  room: RoomCode;
}

/**
 * Clock-sync probe. Not part of the doc's four message types, but required by
 * `ClockSync` (T2.3) and `Heartbeat` (T2.4) and therefore part of the wire
 * contract. Reliable channel.
 */
export interface PingMessage {
  type: 'ping';
  /** Sender's clock when the ping left, ms. Echoed verbatim in the pong. */
  t: number;
}

export interface PongMessage {
  type: 'pong';
  /** The `t` from the ping that triggered this pong. */
  t: number;
  /** Responder's clock when it handled the ping, ms. */
  serverT: number;
}

/** Anything that can cross the wire. */
export type Message =
  | StateFrame
  | ButtonEvent
  | GestureEvent
  | JoinMessage
  | PingMessage
  | PongMessage;

export type MessageType = Message['type'];

/**
 * A message as delivered to Layer 3.
 *
 * `docs/layer-2-transport.md` §Interfaces: "Out (to Layer 3): same messages,
 * delivered with a `recvTs` and estimated one-way latency."
 */
export type Delivered<M extends Message = Message> = M & {
  /** Receiver's clock when the message arrived, ms. */
  recvTs: number;
  /** Estimated one-way latency, ms. `null` until ClockSync has a sample. */
  latencyMs: number | null;
};

/**
 * Delivery guarantee for a message.
 *
 * `reliable`   — ordered, retransmitted. Control traffic and discrete events.
 * `unreliable` — may drop or reorder. Continuous state only.
 */
export type Channel = 'reliable' | 'unreliable';

/**
 * Which channel a message belongs on. Single source of truth for both the
 * WebSocket path (T2.2) and the WebRTC DataChannel path (T2.5).
 *
 * Only `state` is unreliable. Putting it on the reliable channel causes
 * head-of-line blocking and stacks stale frames — the specific failure named in
 * `docs/layer-2-transport.md` §Gotchas.
 */
export function channelFor(msg: Message): Channel {
  return msg.type === 'state' ? 'unreliable' : 'reliable';
}

/* ---- narrowing helpers, so callers never hand-write `m.type === '...'` ---- */

export const isStateFrame = (m: Message): m is StateFrame => m.type === 'state';
export const isButtonEvent = (m: Message): m is ButtonEvent => m.type === 'button';
export const isGestureEvent = (m: Message): m is GestureEvent => m.type === 'gesture';
export const isJoinMessage = (m: Message): m is JoinMessage => m.type === 'join';
export const isPingMessage = (m: Message): m is PingMessage => m.type === 'ping';
export const isPongMessage = (m: Message): m is PongMessage => m.type === 'pong';
