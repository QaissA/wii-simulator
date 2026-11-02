# Motion Game Platform — Architecture Overview

A cross-platform (web + mobile) platform for motion-controlled games in the spirit of the Wii: the
**phone is the controller**, a **separate screen runs the game**, and a **backend** keeps sessions
authoritative and lets multiple players share a room.

## The two models

- **Model A — "Couch Wii" (this spec):** the game runs on a laptop/TV browser; the phone pairs by QR
  code and becomes a motion controller. Requires the transport layer (Layer 2).
- **Model B — "Standalone":** the game runs on the phone itself using its own sensors. Delete Layer 2
  and fold the controller (Layer 1) into the display (Layer 3).

Everything below describes Model A. Collapsing to Model B is noted where relevant.

## The six layers

| # | Layer | Runs on | Core job | Doc |
|---|-------|---------|----------|-----|
| 1 | Controller | Phone (PWA) | Read motion, detect gestures, stream input | `layer-1-controller.md` |
| 2 | Transport | Phone ↔ Screen | Move input frames with low latency | `layer-2-transport.md` |
| 3 | Display + engine | Laptop/TV browser | Render, run physics + game rules | `layer-3-display-engine.md` |
| 4 | Backend | Server (Node) | Rooms, matchmaking, authoritative state | `layer-4-backend.md` |
| 5 | Data + persistence | Server | Users, profiles, leaderboards, replays | `layer-5-data-persistence.md` |
| 6 | Infrastructure | Cloud/edge | Hosting, TURN/STUN, TLS, native packaging | `layer-6-infrastructure.md` |

## End-to-end flow

```
Phone (Layer 1)                 Transport (Layer 2)            Screen (Layer 3)
  read sensors  ──serialize──▶  WebRTC / WebSocket  ──────▶  InputAdapter → game loop → render
  detect gesture                     ▲     │                        │
  press buttons                      │     │                        │
                                     │     ▼                        ▼
                              Backend (Layer 4): rooms, pairing, authoritative state
                                     │                              │
                              Data (Layer 5): profiles, leaderboards, replays
                                     │
                              Infra (Layer 6): edge hosting, TURN/STUN, TLS, autoscaling
```

## Shared input contract

All layers agree on one message format so the seams stay clean. Messages are JSON in the reference
build (switch to binary/MessagePack for production):

```jsonc
// high-frequency state (≈50 Hz)
{ "type": "state",  "t": 12345, "o": {"a":0,"b":0,"g":0}, "acc": {"x":0,"y":0,"z":0}, "rot": {"a":0,"b":0,"g":0}, "btn": ["a"], "room": "7QK2" }
// discrete, reliable events
{ "type": "button", "name": "a", "down": true, "room": "7QK2" }
{ "type": "gesture","name": "swing", "room": "7QK2" }
{ "type": "join",   "room": "7QK2" }
```

`o` = orientation (alpha/beta/gamma, degrees, calibrated), `acc` = linear acceleration (m/s²),
`rot` = rotation rate (deg/s), `btn` = names of currently-held buttons.

## Recommended stack at a glance

- **Controller:** vanilla TS PWA, DeviceMotion/DeviceOrientation APIs
- **Transport:** WebSocket (default) or WebRTC DataChannel (lowest latency)
- **Engine:** Godot 4.6 (web export, single-threaded) — alternatives: Phaser (2D), PlayCanvas, Unity 6
- **Backend:** Node.js + TypeScript + Colyseus 0.17
- **Data:** Postgres (Supabase) + Redis + object storage (R2/S3)
- **Infra:** edge static hosting + container game servers + coturn (TURN/STUN)

## Latency budget

Keep phone-capture → transport → render under **~50–80 ms** or motion feels laggy. This budget is the
single most important number and is shared across Layers 1, 2, and 3.

## Suggested build order

1. Layer 1 controller with an on-screen debug readout (done — see `../index.html`).
2. Layer 2 as a plain WebSocket relay; prove a tilt value moves a dot on a web page.
3. Layer 3 swap the test page for Godot; wire the `InputAdapter`.
4. First real game (tennis swing or bowling flick — one clean gesture).
5. Layer 4 rooms + pairing; Layer 5 leaderboards; Layer 6 deploy.
