# Layer 3 — Display + game engine (the screen)

**Purpose:** the game itself. It receives input frames, maps them to game actions, runs physics and
rules, and renders — on a laptop/TV browser (Model A) or on the phone (Model B).

## Responsibilities

- Consume input frames and translate gestures/tilt/buttons into abstract game actions.
- Run a deterministic game loop (fixed-step simulation, interpolated render).
- Manage scenes/states (menu → pairing → lobby → play → results).
- Render, animate, play audio.
- For multiplayer, sync with the authoritative server (Layer 4).

## Tech stack

| Concern | Primary | Alternatives |
|---|---|---|
| Engine | **Godot 4.6** (web export, single-threaded) | Phaser (2D), PlayCanvas (web-native 3D), Unity 6 (mobile-first) |
| Rendering | WebGL2 / WebGPU | — |
| Physics | Engine built-in | Rapier / Matter.js (JS engines) |
| Multiplayer client | Colyseus client SDK | — |

**Why Godot 4.6:** MIT-licensed, no royalties; its **single-threaded web export (since 4.3)** drops the
SharedArrayBuffer / cross-origin-isolation requirement and fixes iOS/Safari playback — a big hosting
simplification. Web builds are lean (~15–25 MB vs Unity WebGL's 30–50 MB).

**When to pick differently:**
- Pure 2D and smallest footprint → **Phaser**.
- Web-native 3D with a tiny runtime → **PlayCanvas**.
- Mobile-first with mature ad/IAP SDKs → **Unity 6** — but note **Unity WebGL is desktop-browser-only**,
  so it can't be your phone-browser display.

## Architecture

```
network frames → InputAdapter → GameLoop(fixed update) → Renderer(interpolated)
                     │                    │
                     │              PhysicsWorld + GameplayLogic
                     ▼
              client prediction / smoothing
```

- **Fixed-timestep simulation** with interpolated rendering for smooth motion under variable frame rate.
- The **InputAdapter is the key seam**: it converts `state`/`gesture`/`button` messages into engine
  actions ("swing" → tennis swing or bowling release) so the same controller drives any game.
- **Authority:** single-screen games can be display-authoritative; competitive multiplayer moves
  authority to the server (Layer 4) and this layer becomes a predicting client.

## Modules

- **InputAdapter** — network frames → engine input actions (abstract, per-game mapping table).
- **GameLoop** — fixed update + interpolated render.
- **SceneManager** — menu / pairing / lobby / in-game / results state machine.
- **PhysicsWorld** + **CollisionSystem**.
- **GameplayLogic** — one module per game (tennis, bowling, …).
- **AnimationController** + **AudioManager** + **HUD**.
- **RoomClient** — Colyseus client for authoritative multiplayer state.
- **AssetLoader** — streamed/lazy assets to keep the initial web download small.

## Interfaces

- **In (from Layer 2):** input contract with delivery timestamps.
- **With Layer 4:** joins a room, sends intents (in server-authoritative mode), receives synced state.
- **With Layer 5:** reads game config/assets; writes scores at match end (via backend).

## Latency & feel

- Apply **client-side prediction** and interpolation so tilt/aim feels instant despite network jitter.
- Show pairing state clearly (this screen renders the QR the phone scans).
- Keep the first meaningful frame fast — lazy-load heavy assets after the menu.

## Gotchas

- Test web builds on **real devices early** — that's where they break first.
- If you ever target phone browsers as the display, avoid Unity WebGL.
- Keep the InputAdapter's mapping data-driven so new games don't require netcode changes.
