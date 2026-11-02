# Layer 1 — Controller (the phone)

**Purpose:** turn the phone into a motion controller. It captures orientation and acceleration,
detects gestures, reads button presses, and streams input frames. It holds **no game logic**, which
keeps it engine-agnostic and cheap to run as a no-install PWA.

> Reference implementation lives at `../index.html` (self-contained). This document is the spec that
> code follows.

## Responsibilities

- Gate sensor access behind a user tap (required by iOS).
- Read `deviceorientation` (tilt/yaw) and `devicemotion` (acceleration, rotation rate).
- Normalize/calibrate to a neutral pose.
- Detect gestures (swing/shake) from acceleration spikes.
- Capture button presses with haptic feedback.
- Serialize and stream input at a fixed rate (default 50 Hz).
- Run standalone (local demo) or connected to a game server.

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Language/UI | Plain TypeScript or Preact/Svelte | No heavy framework needed; the UI is a few buttons |
| Motion | `DeviceMotionEvent`, `DeviceOrientationEvent` | Built-in Web APIs |
| Permissions | Permissions API + iOS `requestPermission()` | iOS 13+ needs an explicit call from a tap |
| Smoothing | Complementary/Kalman filter; gyronorm.js polyfill | Normalizes cross-browser coordinate differences |
| Feedback | Vibration API, Screen Wake Lock | Haptics + keep screen awake |
| Packaging | Service worker + web manifest | Installable, launches fullscreen |
| Serialization | JSON (dev) → MessagePack (prod) | Binary cuts bandwidth at 50 Hz |

## Architecture

A fixed ~60 Hz capture loop, throttled to ~50 Hz on send:

```
tap → permission → sensor listeners → [calibrate → filter → gesture-detect] → serialize → NetClient
                                                    │
                                            (edge events: buttons, gestures sent immediately)
```

Local-first: the loop buffers and ships deltas so a dropped frame never blocks capture. Discrete events
(button down/up, gesture) go out immediately on the reliable channel; continuous state goes on the
throttled loop.

## Modules

Mirrors the numbered sections in `index.html`'s script block.

- **PermissionGate** — the "tap to start" that satisfies iOS's user-activation requirement; checks
  secure context (HTTPS/localhost) before requesting.
- **SensorReader** — subscribes to `devicemotion` / `deviceorientation`; handles null fields (some
  devices expose `accelerationIncludingGravity` only).
- **Calibrator** — stores beta/gamma offsets on a neutral-pose tap and subtracts them from every frame.
- **SensorFusion** — complementary filter fusing accel + gyro into stable orientation (extend the
  reference build here when jitter matters).
- **GestureRecognizer** — swing/shake via acceleration magnitude threshold + cooldown; replace with
  per-gesture classifiers for real games.
- **InputSerializer** — encodes the shared frame format (see below).
- **NetClient** — WebRTC DataChannel or WebSocket; no-op in local demo mode.
- **PairingUI** — room code entry / QR scan target; connection status.
- **Haptics** — Vibration API on button press and gesture.
- **PWAShell** — service worker, manifest, wake lock.

## Tuning knobs

Top of the script:

| Constant | Default | Effect |
|---|---|---|
| `SEND_HZ` | 50 | Frames/sec to the server |
| `SWING_THRESHOLD` | 16 (m/s²) | Lower = more sensitive swings |
| `GESTURE_COOLDOWN` | 280 (ms) | Lockout between gestures |

## Output contract

```jsonc
{ "type": "state",  "t": 12345, "o": {"a":0,"b":0,"g":0}, "acc": {"x":0,"y":0,"z":0}, "rot": {"a":0,"b":0,"g":0}, "btn": ["a"] }
{ "type": "button", "name": "a", "down": true }
{ "type": "gesture","name": "swing" }
```

A `room` field is appended when connected. See `layer-2-transport.md` for delivery.

## Build & run

1. Serve the folder: `npx serve -l 8080 .`
2. Expose over HTTPS (sensors require it): `npx localtunnel --port 8080` (or ngrok/cloudflared).
3. Open the `https://` URL on the phone → tap power → **Allow** motion → tilt/swing.
4. Tap **Calibrate** in a neutral pose; tap **Debug** to see live values.
5. Install: browser menu → **Add to Home Screen**.
6. Optional: run `test-server.mjs`, tunnel port 8081, tap **Connect** and stream frames.

Desktop iteration: open `http://localhost:8080`, DevTools → **Sensors** to emulate orientation.

## Gotchas

- **HTTPS is mandatory** for sensors (localhost is exempt).
- **iOS** blocks sensors unless `requestPermission()` runs inside a real tap handler.
- **Coordinate frames differ across browsers** — always calibrate, and test on both iOS and Android
  before locking thresholds.
- `deviceorientation` doesn't fire in a cross-origin iframe on some browsers — serve top-level.

## Extends into

Layer 2 consumes the output contract. For Model B, this module reads directly into the Layer 3 engine
instead of a NetClient.
