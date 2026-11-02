/**
 * Layer 1 entry point.
 *
 * The capture loop from `docs/layer-1-controller.md` §Architecture:
 *
 *   tap → permission → sensor listeners → [calibrate → filter → gesture-detect]
 *       → serialize → NetClient
 *
 * Capture runs at display rate (~60 Hz); sending is throttled to `SEND_HZ` (50).
 * Discrete events bypass the throttle entirely.
 *
 * TODO(on-device): this file's wiring was verified only on desktop Chrome, where
 * no sensor ever fires — so the loop was proven to *run*, never to produce
 * meaningful values. Every `TODO(on-device)` in `./modules/` is downstream of
 * that gap. List them with:
 *
 *     rg "TODO\(on-device\)" apps/controller packages/protocol
 *
 * The outstanding items and the order to work through them are in
 * `docs/implementation-plan.md` §Phase 1 → Outstanding.
 */

import { LATENCY_BUDGET_MS, magnitude, quatFromEuler, quatToEuler } from '@wii/protocol';
import type { RoomCode } from '@wii/protocol';

import { Calibrator } from './modules/calibrator.js';
import { GestureRecognizer } from './modules/gesture-recognizer.js';
import { InputSerializer } from './modules/input-serializer.js';
import { NetClient } from './modules/net-client.js';
import { PairingUI, relayUrlFor } from './modules/pairing-ui.js';
import { SensorFusion } from './modules/sensor-fusion.js';
import { SensorReader } from './modules/sensor-reader.js';
import { TraceRecorder } from './modules/trace-recorder.js';
import { haptics } from './modules/haptics.js';
import { isSecureForSensors, requestSensorAccess } from './modules/permission-gate.js';
import { keepAwake, registerServiceWorker } from './modules/pwa-shell.js';

/** Throws rather than returning null — a missing element is a broken build. */
function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

const gate = el('gate');
const gateBtn = el<HTMLButtonElement>('gate-btn');
const gateMsg = el('gate-msg');
const gateSub = el('gate-sub');
const app = el('app');

const reader = new SensorReader();
const calibrator = new Calibrator();
const fusion = new SensorFusion();
const gestures = new GestureRecognizer();
const serializer = new InputSerializer();
const trace = new TraceRecorder();

const heldButtons = new Set<string>();

const pairing = new PairingUI({
  input: el<HTMLInputElement>('room'),
  connectBtn: el<HTMLButtonElement>('connect'),
  status: el('status'),
  message: el('pair-msg'),
  latency: el('latency'),
});

const net = new NetClient({
  onState: (state, detail) => pairing.setState(state, detail),
});

pairing.onConnect((room: RoomCode) => net.connect(relayUrlFor(), room));
pairing.onDisconnect(() => net.disconnect());

/* ------------------------------- the gate -------------------------------- */

// Warn before the tap, not after: on an insecure origin the permission request
// will fail no matter what the player does.
if (!isSecureForSensors()) {
  gateSub.textContent = 'Needs HTTPS — open the tunnel URL, not the LAN address.';
}

gateBtn.addEventListener('click', () => {
  // No `await` before this call — see permission-gate.ts. Awaiting first would
  // spend the user activation and make iOS reject the request.
  void requestSensorAccess().then((outcome) => {
    if (!outcome.ok) {
      gateMsg.textContent = 'Cannot start';
      gateSub.textContent = outcome.detail;
      return;
    }
    gate.hidden = true;
    app.hidden = false;
    reader.start();
    void keepAwake();
    requestAnimationFrame(loop);

    // A scanned QR already carries the room, so pair without making the player
    // read the code back off the screen.
    const prefilled = pairing.prefilledRoom;
    if (prefilled) net.connect(relayUrlFor(), prefilled);
  });
});

/* -------------------------------- controls -------------------------------- */

el('calibrate').addEventListener('click', () => {
  const o = reader.read().o;
  calibrator.capture(quatFromEuler(o.a, o.b, o.g));
  // Reset the filter too, or it spends a second dragging the pre-calibration
  // estimate toward the new zero.
  fusion.reset();
  haptics.confirm();
  pairing.message('Calibrated.');
});

const debugPanel = el('debug');
el('debug-toggle').addEventListener('click', () => {
  debugPanel.hidden = !debugPanel.hidden;
});

el('dump-trace').addEventListener('click', () => {
  trace.download('trace');
  pairing.message(`Exported ${trace.size} samples.`);
});

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-button]')) {
  const name = btn.dataset['button'];
  if (!name) continue;

  const press = (e: Event): void => {
    e.preventDefault(); // stop the synthetic mouse event that follows a touch
    if (heldButtons.has(name)) return;
    heldButtons.add(name);
    btn.classList.add('held');
    haptics.press();
    net.send(serializer.button(name, true, net.room));
  };

  const release = (e: Event): void => {
    e.preventDefault();
    if (!heldButtons.delete(name)) return;
    btn.classList.remove('held');
    haptics.release();
    net.send(serializer.button(name, false, net.room));
  };

  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  // Without these a finger sliding off the button leaves it stuck down.
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
}

/* ------------------------------ debug readout ----------------------------- */

const dbg = {
  o: el('dbg-o'),
  acc: el('dbg-acc'),
  rot: el('dbg-rot'),
  mag: el('dbg-mag'),
  peak: el('dbg-peak'),
  hz: el('dbg-hz'),
  gesture: el('dbg-gesture'),
  source: el('dbg-source'),
};

const f1 = (n: number): string => n.toFixed(1);
let lastGesture = '—';
let lastHudPaint = 0;

function paintDebug(o: { a: number; b: number; g: number }, mag: number, now: number): void {
  // 10 Hz. Repainting the HUD at capture rate costs more than the capture does.
  if (debugPanel.hidden || now - lastHudPaint < 100) return;
  lastHudPaint = now;

  const s = reader.read();
  dbg.o.textContent = `a ${f1(o.a)}  b ${f1(o.b)}  g ${f1(o.g)}`;
  dbg.acc.textContent = `x ${f1(s.acc.x)}  y ${f1(s.acc.y)}  z ${f1(s.acc.z)}`;
  dbg.rot.textContent = `a ${f1(s.rot.a)}  b ${f1(s.rot.b)}  g ${f1(s.rot.g)}`;
  // Shown against the threshold so a near-miss is visible during tuning.
  dbg.mag.textContent = `${f1(mag)} / ${gestures.threshold}`;
  dbg.peak.textContent = f1(gestures.peak);
  dbg.hz.textContent = `${serializer.hz}`;
  dbg.gesture.textContent = lastGesture;
  // Which device axis the calibration pose resolved to aim with. Worth showing:
  // a grip that reads wrong here explains a cursor that tracks wrong, and it is
  // the one part of the pointing frame a player can check against their hand.
  const [, fy] = calibrator.forward;
  const gripName = !calibrator.calibrated ? 'uncalibrated' : fy > 0.5 ? 'flat' : 'upright';
  dbg.source.textContent =
    (reader.receiving ? s.source : 'no events yet') + ` · grip ${gripName}`;

  const latency = net.latencyMs;
  pairing.setLatency(latency);
  el('latency').classList.toggle('over-budget', latency !== null && latency > LATENCY_BUDGET_MS.max);
}

/* ------------------------------ capture loop ------------------------------ */

function loop(now: number): void {
  requestAnimationFrame(loop);

  const raw = reader.read();
  const rawQ = quatFromEuler(raw.o.a, raw.o.b, raw.o.g);
  const calibrated = calibrator.apply(rawQ);
  const fused = fusion.update(calibrated, raw.rot, now);

  // Gestures are classified in the **calibrated, screen-relative** frame (T1.8),
  // not in the device frame. Magnitude is rotation-invariant, so swing and shake
  // behave exactly as before; direction is the whole reason for the rotation.
  const fired = gestures.update(calibrator.toScreenFrame(raw.acc, rawQ), now);
  if (fired) {
    // The HUD shows the direction and how decisive it was — the two numbers a
    // tuning session needs. A dash means the flick was too diagonal to call.
    lastGesture = `${fired.wireName} @ ${f1(fired.magnitude)} x${f1(fired.dominance)}`;
    haptics.gesture();
    // The *wire* name, so a directional flick reaches the display as
    // `swing:left`. Games that only map `swing` still match, via the base-name
    // fallback in `InputAdapter`.
    net.send(serializer.gesture(fired.wireName, net.room));
  }

  // Raw, pre-calibration samples: a trace must be replayable against a *changed*
  // calibration, so it has to store what the sensor said, not what we made of it.
  trace.push({ o: raw.o, acc: raw.acc, rot: raw.rot }, now);

  // `now` is the rAF clock — monotonic, right for throttling. The wire stamp is
  // wall-clock translated onto the relay's clock, because the display reads it
  // against *its* clock to compute frame age. See InputSerializer.maybeState.
  const frame = serializer.maybeState(
    { q: fused, acc: raw.acc, rot: raw.rot, buttons: [...heldButtons] },
    now,
    net.room,
    net.toRelayTime(Date.now()),
  );
  if (frame) net.send(frame);

  paintDebug(quatToEuler(fused), magnitude(raw.acc), now);
}

void registerServiceWorker();
