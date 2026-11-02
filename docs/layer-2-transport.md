# Layer 2 — Transport (phone ↔ screen link)

**Purpose:** move input frames from the controller to the display with the lowest practical latency,
and carry the reliable control traffic (pairing, lifecycle) alongside the lossy high-frequency stream.

> For **Model B** (game runs on the phone), this layer does not exist — delete it.

## Responsibilities

- Establish a link between phone and screen (via a room code / QR).
- Carry two logical channels: reliable control + unreliable high-frequency input.
- Timestamp frames for latency compensation.
- Reconnect transparently on drop.

## Tech stack

| Concern | Default | Lowest-latency option |
|---|---|---|
| Transport | WebSocket via `uWebSockets.js` (relayed through backend) | WebRTC DataChannel (P2P, same room) |
| Server abstraction | Colyseus room messaging | geckos.io (UDP over WebRTC) |
| Signaling (WebRTC) | WebSocket SDP/ICE exchange | Colyseus WebRTC signaling server |
| Serialization | JSON (dev) → MessagePack / `@colyseus/schema` (prod) | FlatBuffers for max throughput |

**Rule of thumb (2026):** start with **WebSockets + an authoritative server**; reach for WebRTC only
when you truly need peer-to-peer or the tightest latency for fast action. WebTransport is promising but
its browser support is still settling.

## Architecture

Two channels with different guarantees:

```
control  (reliable, ordered)     → join/leave, pause, calibrate ack, chat
input    (unreliable, unordered) → 50 Hz state frames; drop stale over wait
```

- **Same room / LAN:** WebRTC DataChannel P2P — phone streams straight to the screen; backend only
  brokers the handshake.
- **Remote / restrictive networks:** relay frames through the backend over WebSocket; TURN (Layer 6)
  handles NAT traversal for the WebRTC path.

Client-side prediction lives on the display (Layer 3); this layer just guarantees timely delivery and
timestamps.

## Modules

- **SignalingClient / SignalingServer** — SDP + ICE exchange to open the peer link (WebRTC path).
- **PeerConnectionManager** — `RTCPeerConnection` lifecycle, ICE candidates, renegotiation.
- **ChannelRouter** — abstracts "reliable vs unreliable"; same API whether backed by WS or WebRTC.
- **MessageCodec** — shared encode/decode with the controller (single source of truth for the frame
  format).
- **ClockSync** — round-trip time estimation; stamps frames so the display can compensate.
- **Heartbeat** — liveness ping + exponential-backoff reconnect.

## Interfaces

- **In (from Layer 1):** the input contract (`state` / `button` / `gesture` / `join`).
- **Out (to Layer 3):** same messages, delivered with a `recvTs` and estimated one-way latency.
- **With Layer 4:** the backend hosts signaling and the relay fallback; room codes come from
  matchmaking.

## Latency budget

This layer owns the middle of the ~50–80 ms end-to-end budget. Targets:

- WebRTC P2P same-room: typically 5–20 ms.
- WebSocket relay: add the round-trip to your nearest game-server region (Layer 6 regional deploys keep
  this small).

## Gotchas

- WebRTC needs STUN (and often TURN) to cross NATs — budget for TURN relay cost (Layer 6).
- Don't send continuous state on a reliable/ordered channel — head-of-line blocking will stack stale
  frames. Keep state on the unreliable channel.
- Keep control and input codecs in one shared package so the phone and screen never drift.
