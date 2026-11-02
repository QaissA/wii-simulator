# Layer 6 — Infrastructure & delivery

**Purpose:** get the clients to users fast, keep the game servers close and scalable, make WebRTC work
across real-world networks, and package for app stores.

## Responsibilities

- Serve the display and controller PWA from the edge.
- Run game servers regionally with autoscaling.
- Provide STUN/TURN for WebRTC NAT traversal.
- Enforce TLS everywhere (sensors require HTTPS).
- Package native app-store builds.
- Observe latency and health.

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Static hosting / CDN | Cloudflare Pages / Vercel / Netlify | Display + controller PWA at the edge |
| Game server host | Fly.io / Railway / Colyseus Cloud / AWS/GCP | Container autoscaling, regional |
| NAT traversal | coturn (self-host) or managed (Twilio/Cloudflare) | STUN + TURN relay |
| TLS | Managed certs (host-provided) | **Mandatory** — sensors won't run without HTTPS |
| Native packaging | Capacitor (wrap PWA) or Godot iOS/Android export | App-store presence |
| CI/CD | GitHub Actions (or similar) | Build web + native, deploy |
| Observability | Logs + metrics + latency dashboard | The latency graph is the one you live by |

## Architecture

```
        ┌─────────────── edge CDN ───────────────┐
users ─▶│  display (Godot web)  controller PWA     │
        └──────────────────────────────────────────┘
                     │ wss / WebRTC
        ┌──────────── regional clusters ───────────┐
        │  game servers (Layer 4) + Redis           │
        │  TURN/STUN relay                           │
        └────────────────────────────────────────────┘
                     │
        Postgres / object storage (Layer 5, managed)
```

- **Edge-serve** static clients (near-instant load, global).
- **Region game servers** near players to keep relayed latency low.
- **TURN** relays traffic for clients behind restrictive NATs/firewalls when P2P fails.
- The **single-threaded Godot web export** means you don't need COOP/COEP headers, so any static host
  works without special configuration.

## Modules

- **StaticDeployPipeline** — build + publish display and controller to the CDN.
- **ServerAutoscaleGroup** + **LoadBalancer** — regional game-server capacity.
- **TurnStunCluster** — coturn or managed; credential rotation.
- **TlsCertManager** — certificates for all origins.
- **NativeWrappers** — Capacitor config + store build scripts (or engine export).
- **Observability** — logs, metrics, latency dashboards, alerts.
- **CI/CD** — pipelines for web and native builds.

## Interfaces

- **With Layers 1 & 3:** serves the PWA and the game web build; enforces HTTPS.
- **With Layer 2:** TURN/STUN enables the WebRTC path; regional endpoints keep the relay path fast.
- **With Layers 4 & 5:** hosts/scales the game servers and connects to managed data stores.

## Deployment checklist

- [ ] HTTPS on every origin (controller, display, sockets).
- [ ] TURN reachable and credentialed (test on cellular, not just Wi-Fi).
- [ ] Game servers in at least one region near your users; add regions as you grow.
- [ ] Static clients cached at the edge; cache-bust on deploy.
- [ ] Latency dashboard live before launch.
- [ ] Native builds signed and store-ready (if shipping to app stores).

## Gotchas

- TURN is where WebRTC projects quietly fail — always test from a mobile network behind carrier NAT.
- Regional latency dominates the relay path; a single far-away region makes motion feel laggy.
- Keep the web build small; edge caching helps, but the first download still gates time-to-play.
