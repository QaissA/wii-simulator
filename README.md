# Wii Simulator

Your phone is the motion controller and any screen is the console. The phone streams its motion sensors over a WebSocket relay to the display, which runs the games.

## Play it now

| | URL |
|---|---|
| **Display**: open on a TV or computer | https://wii-display.pages.dev |
| **Controller**: the phone opens this via the QR code | https://wii-controller.pages.dev |
| Relay | `wss://wii-relay-qaiss.fly.dev` |

1. Open **https://wii-display.pages.dev** on the big screen.
2. Scan the QR code with your phone. It opens the controller already paired to that room.
3. Allow motion-sensor access when the phone asks (iOS needs a tap first).
4. Point and swing to pick a game: Flappy, Fruit Slash or Star Fighter.

Lost the QR code? Open https://wii-controller.pages.dev on the phone and type the room code shown on the display.

## How it fits together

```
phone (controller PWA) ──wss──▶ relay (apps/server, Fly.io) ──wss──▶ display (apps/display)
```

| Path | What |
|---|---|
| `apps/controller` | Phone PWA: sensor fusion, calibration, gestures |
| `apps/display` | Big-screen app: scenes, games, rendering, audio |
| `apps/server` | WebSocket relay that pairs phones and displays by room code |
| `packages/*` | Shared protocol, transport and engine code |

## Run locally

Requires Node 20+ and pnpm.

```sh
pnpm install
pnpm cert            # HTTPS dev cert, needed because phone sensors require HTTPS
pnpm dev:relay
pnpm dev:controller
pnpm dev:display
```

See [docs/running.md](docs/running.md) for LAN and phone testing.

## Deploy

**Relay** (Fly.io, configured by `fly.toml` and `Dockerfile`):

```sh
fly deploy --remote-only
```

**Display and controller** (Cloudflare Pages). The relay and controller URLs are compiled into the build:

```sh
export VITE_RELAY_URL=wss://wii-relay-qaiss.fly.dev
export VITE_CONTROLLER_URL=https://wii-controller.pages.dev
pnpm --filter @wii/display... build
pnpm --filter @wii/controller... build
npx wrangler pages deploy apps/display/dist    --project-name wii-display    --branch main
npx wrangler pages deploy apps/controller/dist --project-name wii-controller --branch main
```
