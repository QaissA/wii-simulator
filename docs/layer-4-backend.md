# Layer 4 — Backend (authoritative game server)

**Purpose:** run authoritative game sessions, pair phones to screens, match players, and synchronize
state. It also hosts the WebRTC signaling endpoint and the WebSocket relay fallback for Layer 2.

## Responsibilities

- Create and manage rooms (one per match/session).
- Pair a controller to a display by short room code (encoded in the QR).
- Hold authoritative game state and sync deltas to clients.
- Validate input server-side (anti-cheat).
- Scale horizontally; support reconnection.

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | Node.js + TypeScript | — |
| Framework | **Colyseus 0.17** | Authoritative rooms, matchmaking, delta binary state sync, auto-reconnect |
| Transport | `uWebSockets.js` | High-throughput WS |
| State | `@colyseus/schema` | Delta-compressed, binary-encoded sync |
| Scale | Redis + load balancer | Presence + horizontal scale (10 → 10,000+ CCU) |
| Signaling | Colyseus WebRTC signaling server | Doubles as Layer 2 signaling |
| Non-realtime API | REST or tRPC | Login, profiles, config |

**Why Colyseus:** room-based architecture with matchmaking, filtering, queuing, and reconnection out of
the box; authoritative server model runs game logic on the server, not the client (cheat-resistant).
Version 0.17 (Apr 2026) adds automatic reconnection and full-stack TypeScript safety.

## Architecture

```
client join(roomCode) ─▶ Matchmaker ─▶ GameRoom instance
                                          │  authoritative SyncSchema state
                                          │  validates input, runs rules
                                          ▼
                              @colyseus/schema delta ──▶ all clients in room
Redis presence  ◀── rooms register ──┘        (screen + phones)
```

- Each session is a **Room instance** holding authoritative state defined with `@colyseus/schema`,
  auto-synced to clients as binary deltas.
- **Matchmaking** assigns the phone and screen to the same room via the code shown on the screen.
- **Horizontal scale** via Redis presence + a load balancer; rooms can live on any node.
- The same process serves **signaling** (WebRTC) and a **relay** path (WebSocket) for Layer 2.

## Modules

- **GameRoom** — per-match authoritative logic + input validation (anti-cheat).
- **Matchmaker** — room codes, QR payloads, join-by-code, queuing/filtering.
- **SyncSchema** — synchronized state definitions (`@colyseus/schema`).
- **SignalingService** — WebRTC SDP/ICE relay.
- **RelayService** — WebSocket input passthrough for non-P2P clients.
- **PresenceService** — Redis-backed room/player presence.
- **AuthMiddleware** — validates session tokens on join.
- **ApiGateway** — REST/tRPC for non-realtime calls.

## Interfaces

- **With Layer 2:** hosts signaling + relay; issues room codes.
- **With Layer 3:** the display joins as a client; in server-authoritative mode it sends intents and
  receives synced state.
- **With Layer 5:** reads user/session data on join; writes match results and scores at end.

## Scale & ops

- Start on a single node; add Redis + a second node when you exceed one box.
- Deploy **regionally** (Layer 6) so relayed traffic has a nearby endpoint.
- Room state lives in memory during play; persist to Layer 5 at checkpoints and match-end.

## Gotchas

- Keep authoritative rules on the server for anything competitive — never trust client-reported
  outcomes.
- Set sane room lifecycles (empty-room timeout, reconnection window) to avoid leaked instances.
- Version your schema; mismatched client/server schema versions break sync silently.
