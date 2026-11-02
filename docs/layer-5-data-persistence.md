# Layer 5 — Data & persistence

**Purpose:** durable storage for everything that outlives a match — users, profiles, match history,
leaderboards, replays, and game assets — plus the hot ephemeral store the realtime layer leans on.

## Responsibilities

- Authenticate users and store profiles.
- Persist match history and (optionally) replays.
- Maintain leaderboards.
- Serve game assets/config.
- Provide the fast ephemeral store for presence and rate limiting.

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Relational | Postgres (via Supabase) | Users, profiles, match history, leaderboards |
| Ephemeral / hot | Redis | Presence, rate limiting, live leaderboard ZSETs |
| Object storage | Cloudflare R2 / S3 | Assets, avatars, replay blobs |
| Auth | Supabase Auth / Clerk / Auth0 | Session tokens validated by Layer 4 |
| Analytics | PostHog | Product + gameplay telemetry |

## Architecture

Separate the **hot path** from **durable storage**:

```
in-memory room state (Layer 4)
        │  checkpoints + match-end
        ▼
Redis (presence, live leaderboards)  ──periodic flush──▶  Postgres (durable)
                                                              │
                                       Object storage ◀── replays, assets, avatars
```

- Room state lives in memory during a match; only checkpoints and final results hit Postgres.
- **Leaderboards** run as Redis sorted sets (fast top-N and rank queries), periodically flushed to
  Postgres for durability and history.
- Assets are served from object storage behind the CDN (Layer 6), not the app server.

## Modules

- **UserRepository / AuthService** — accounts, session tokens.
- **ProfileService** — display name, avatar, stats.
- **LeaderboardService** — Redis ZSET fronting Postgres; supports global/room/seasonal boards.
- **MatchHistory / ReplayStore** — match records; replay blobs in object storage.
- **AssetService** — CDN-backed asset + config delivery.
- **Telemetry** — analytics events.

## Data model sketch

```
users(id, handle, created_at)
profiles(user_id, display_name, avatar_url, stats_json)
matches(id, game, started_at, ended_at, room_code)
match_players(match_id, user_id, score, placement)
leaderboard_entries(board, user_id, score, updated_at)   # mirror of Redis ZSET
```

## Interfaces

- **With Layer 4:** read user/session on room join; write results at match-end.
- **With Layer 3:** serves game config and assets (via CDN).
- **With Layer 6:** object storage sits behind the CDN; Redis/Postgres are managed or self-hosted.

## Gotchas

- Never block the game loop on a durable write — write async at checkpoints only.
- Treat Redis as volatile: it's the cache/hot store, Postgres is the source of truth.
- Rate-limit score submissions and validate them against server-authoritative results (Layer 4) to keep
  leaderboards clean.
