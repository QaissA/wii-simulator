# Implementation Plan

**Status legend:** ✅ done · 🔄 in progress · ⬜ not started · 👤 human-in-the-loop required

| Phase | Layer | Status |
|---|---|---|
| 0 | Foundation + shared protocol | ✅ done |
| 1 | Controller (phone PWA) | ✅ done · **proven on a real phone** |
| 2 | Transport (WebSocket) | ✅ done |
| 3a | Display engine logic (T3.2/T3.3/T3.5) | ✅ done |
| 3b | Rendering + vertical slice (T3.0/T3.1/T3.4) | ✅ done · **phone → screen working end to end** |
| — | **T1.7 quaternion orientation** | ✅ done · **verified on hardware — and it failed** |
| — | **T1.8 directional gestures** | ✅ code · ⏳ tuning 👤 |
| 3c | Games — T3.6 ✅ · T3.7 Flappy ✅ · T3.8 Fruit slash ✅ · T3.11 Star fighter ✅ · T3.12 Audio ✅ · T3.9 ⬜ | 🔄 👤 |
| 4 | Backend (authoritative rooms) | ⬜ |
| 5 | Data & persistence | ⬜ |
| 6 | Infrastructure & delivery | ⬜ |
| 2b | Transport (WebRTC, T2.5) | ⬜ deferred to the end by design |

**153 unit tests + 62 browser assertions green.** Layers 1–3 are joined and working on hardware,
orientation is a quaternion end to end, and the seam now carries **four** games — which, as of T3.12,
make a sound.

T1.7's owed device session happened, and it found a real defect — see §The second device session.
T1.8 is now written, so **T3.9 is unblocked**. What remains before it is the thing the plan has
said all along: **record the gesture traces**, because directional classification has four outcomes
to confuse instead of two and tuning it by re-swinging a phone is the expensive path.

`docs/running.md` is the runbook — how to start everything, and the three ways to test it.

---

## Where the project stands

**The milestone that mattered is done.** §Overall verification called it: *"a phone tilt moves a dot on
a separate screen, over HTTPS, end-to-end."* That works, on a real iPhone, with frame age inside the
50–80 ms budget.

### What exists

| | |
|---|---|
| `packages/protocol` | the wire contract — types, codec, clock sync, every tuning constant |
| `packages/transport` | `ChannelRouter` + WebSocket backend, shared by phone and screen |
| `packages/engine` | `InputAdapter`, `GameLoop`, `SceneManager`, prediction, `AudioDirector` — renderer-agnostic |
| `apps/controller` | the phone PWA — sensors, gestures, buttons, pairing |
| `apps/server` | the relay — rooms, fan-out, ping/pong, TLS |
| `apps/display` | the screen — Three.js, pairing/lobby/play scenes, debug cursor |
| `tools/fake-controller` | a phone-shaped thing without the phone |
| `tools/display-check` | headless browser acceptance checks, 62 assertions across four scripts |
| `tools/dev-cert` | local CA + certificate, so the LAN can serve HTTPS for sensors |

Two files the device session added, both small and both load-bearing:

| | |
|---|---|
| `packages/protocol/src/grip.ts` | resolves which device axis is aimed at the screen, from the calibration pose |
| `apps/display/src/render/decor.ts` | gradients, star fields, ridges — depth from colour, since the games are unlit |
| `apps/display/src/audio/` | `AudioContext` lifecycle, three synthesised voices, and the cue table (T3.12) |

### What the first device session actually found

Four real defects. None was reachable by a unit test, because each needed a real refresh rate, a real
clock, or a real hand:

1. **`StateFrame.t` was stamped on the wrong clock** — the rAF timestamp, while both `ClockSync`
   instances synced against the relay's `Date.now()`. Frame age was measuring clock skew, and it
   looked plausible. Fixed by expressing `t` in relay time; **which clock a timestamp uses is now part
   of the wire contract**, stated in `types.ts`.
2. **The controller sent at 30 Hz, not 50.** The send deadline reset to `now` rather than accumulating,
   so at a 60 Hz capture rate every other frame was skipped — and `SEND_HZ = 50` was unreachable at any
   refresh rate. A third of the latency budget was going to a scheduling mistake.
3. **`SensorFusion` integrated angular velocity into Euler angles**, treating `rotationRate.beta` as
   `beta`'s derivative. It is not: the relation depends on attitude and degenerates near `beta` ±90°,
   which is exactly where a phone sits when held upright. The gyro fought the reading instead of
   predicting it — one axis reversed and sluggish, the other fine. Replaced with an angle-aware
   smoother over the platform's own (already fused) estimate.
4. **The scene machine could strand itself.** Presence was handled as an event, but `play → lobby`
   happens *because* presence went false, so the edge was always already gone by the time the next
   scene subscribed. Scenes now re-check it as a guard condition, which cannot miss an edge.

Two process lessons worth keeping. **A synthetic controller plus a scripted browser check moved the
"needs a human" line a long way** — everything except the sensors is now provable unattended, and the
device session was spent on sensor reality rather than on discovering plumbing faults. And **a
timeout-shaped bug cannot be found by looking**: defect 4 was invisible to any screenshot and only
surfaced once something asserted on it.

### The second device session — what shipping T1.7 unverified cost

T1.7 was written, tested, and marked "⏳ feel 👤". The device session found it **did not work at
all** in one of the two grips it was built to support, and the reason is worth keeping:

1. **The grip knob shipped, and nobody turned it.** `AxisBinding.forward` existed exactly as
   designed; §T1.7 even states the rule — *"a phone held flat and aimed away like a Wii remote
   points along its own `+y`, so that grip is `forward: [0, 1, 0]` in a mapping literal."*
   **No mapping ever set it.** Every game took the `-z` default, which is right only for a phone
   held upright with its screen toward the player.

   Held flat, `-z` points at the floor — the same axis a player yaws about. So aiming left and
   right rotated the pointing vector about itself and the horizontal axis read a flat zero, while
   **wrist roll** swung it through the horizontal and drove the cursor backwards. The vertical axis
   worked throughout, which is what made it read as "half the tracking is broken" rather than as a
   grip assumption.

2. **The fix is that the grip is now *resolved*, not assumed.** `packages/protocol/src/grip.ts`
   reads it off the calibration pose: `q_neutral` maps device → earth, so rotating earth-up back
   through its conjugate says where "up" lies in device coordinates, and the device axis most nearly
   perpendicular to that is the one aimed at the screen. `Calibrator` then conjugates every frame by
   that basis, putting the wire into one **canonical pointing frame** where `-z` really is forward.

   No mapping changed, no protocol change, no game touched. `DEFAULT_FORWARD` stopped being an
   assumption about the player and became a fact about the frame.

3. **A second bug fell out for free.** `right`/`up` are now built from **world up at the neutral
   pose** rather than from the device's own `+x`/`+y`, so a phone calibrated in landscape no longer
   delivers its axes swapped.

4. **The pointing *sign* is a convention, not a fact.** Gravity fixes which device axis is
   horizontal but never which **end** of it faces the screen, and no amount of quaternion work can
   know. `DEFAULT_GRIP.x` is therefore `true` now, with `X` still flipping it live. This is the
   one place the old hand-patch keys earn their keep.

5. **"Laggy" and "jittery" reported together are a *shape* complaint, not a tuning one.** A single
   fixed `FUSION_HALF_LIFE_MS` forces a trade: raise it and a held cursor stops shimmering but the
   hand outruns it; lower it and it is immediate and never settles. Smoothing is now speed-adaptive
   (120 ms at rest → 12 ms above 90 °/s), which is standard one-euro-filter reasoning and the same
   diagnosis `FUSION_ALPHA` got before it was deleted.

**The lesson generalises, and it is the sharpest one in this file.** The existing tests asserted
that both grips read **dead centre at their own calibration pose** — true, and true throughout,
because a bug in the forward axis cannot move a vector that has not been rotated yet. What no test
asserted was **which physical motion moves which axis**. A test suite can be green, thorough, and
aimed one inch to the left of the defect.

> Two of the new tests failed against *correct* code before they were right, both times because they
> wrote motions as **Euler deltas**: `gamma + 25` is a wrist roll when the phone is flat and a *yaw*
> when it is upright. The tests now express motions as world-frame rotations. Even a test written to
> pin the quaternion work reached for angles first.

### Euler angles: fixed (T1.7)

The problem was representational rather than a tuning error, and it is now gone. `StateFrame` carries
`q: [x, y, z, w]`; `Calibrator` composes `q_neutral⁻¹ · q_current` instead of subtracting angles;
`SensorFusion` slerps; and `InputAdapter` gained `point.x`/`point.y` sources that rotate a forward
vector and read the axes off where it lands.

`o` stays on the wire, **derived from `q`** in `InputSerializer` so the two cannot disagree. It feeds
the debug HUD and any binding that still names an angle. `PROTOCOL_VERSION` is 2: a version-1
controller now fails `validate` outright, which is the loud failure rather than a phone that connects
and points nowhere.

The display's `S` key is deleted along with the stored `xSource` — with pointing axes there is nothing
left to swap. `X`/`Y` remain as a genuine preference, not a repair, and neither default is inverted
any more: the old `invert: true` on both debug axes was compensating for the representation.

**A grip is now data.** A phone held flat and aimed away like a Wii remote points along its own `+y`,
so that grip is `forward: [0, 1, 0]` in a mapping literal. The screen frame is derived from `forward`
rather than hardcoded, which is what makes that true — an earlier draft measured deflection against
fixed device axes and a custom `forward` then read a constant ±1 at its own calibration pose. The test
that caught it is the one asserting both grips read dead centre where they were calibrated.

**Still owed: the on-device session.** Everything above is proven in tests and in the browser
harnesses against synthetic sensors. What no test can answer is whether it *feels* right in a hand —
see §⏳ Outstanding below for the verification script.

---

## Context

This repo began as `docs/` alone — seven spec files describing a six-layer Wii-style motion gaming
platform (phone = controller, separate screen = game, backend = authority). No code existed.
`layer-1-controller.md` refers to `../index.html` as "done" and to a `test-server.mjs`; **neither file
ever existed**, so Layer 1 is greenfield like everything else. Treat those two references as spec, not
as a description of reality.

The other six docs are the source of truth for *what* to build. This file is the source of truth for
*in what order*, *with how much context loaded*, and *at what cost*.

Three decisions override the docs where they differ:

| Decision | Choice | Rationale |
|---|---|---|
| Layer 3 engine | **TypeScript + Three.js**, not Godot 4.6 | Godot needs a binary editor and a manual export step that cannot be driven or verified from a coding session. The doc's real requirement is the `InputAdapter` seam, which is engine-agnostic — keeping it intact means a Godot port later touches Layer 3 only. |
| Scope | **All six layers, phased** | Vertical slice (L1→L3) first, then depth. |
| Layout | **pnpm monorepo with a shared `protocol` package** | Directly satisfies `layer-2-transport.md`'s rule: "Keep control and input codecs in one shared package so the phone and screen never drift." |

Intended outcome: a phone streams motion at 50 Hz to a browser on another screen with **end-to-end
latency under 50–80 ms** (the one number `00-overview.md` calls non-negotiable), scaling up to
authoritative multiplayer rooms, durable leaderboards, and a regional deploy.

---

## Repo layout

```
wii-simulator/
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ docs/                          # the spec — source of truth for WHAT
│  └─ implementation-plan.md      # this file — source of truth for ORDER and COST
├─ packages/
│  └─ protocol/                   # THE shared contract. L1, L2, L3, L4 all import it.
│     ├─ src/types.ts             #   StateFrame | ButtonEvent | GestureEvent | JoinMessage
│     │                           #   + PingMessage | PongMessage, + channelFor()
│     ├─ src/codec.ts             #   encode/decode/tryDecode/validate, MessagePack seam
│     ├─ src/constants.ts         #   SEND_HZ, SWING_THRESHOLD, GESTURE_COOLDOWN, room codes
│     └─ src/clock.ts             #   ClockSync — RTT estimation, recvTs stamping
├─ apps/
│  ├─ controller/                 # Layer 1 — Vite vanilla-TS PWA
│  ├─ display/                    # Layer 3 — Vite + Three.js
│  └─ server/                     # Layer 2 relay → Layer 4 Colyseus → Layer 5 repos
└─ infra/                         # Layer 6 — Dockerfile, fly.toml, coturn, GH Actions
```

`packages/protocol` is the load-bearing piece: small, stable, and the **only** file set that needs to
be in context when working on any other layer. Building it first is what keeps every later task cheap.

---

## How to read the task tables

**Context** — the minimum that must be loaded to do the task well. Load nothing else; extra docs are
pure token cost with no accuracy gain.

**Cx** — complexity: `S` mechanical · `M` design decisions but a known shape · `L` real engineering,
several interacting pieces · `XL` hard, expect to be wrong once.

**Tok** — expected token consumption *including iteration*:
`low` <15k · `med` 15–40k · `high` 40–90k · `v.high` 90k+.
The driver is almost never file size — it is **iteration count**. Tasks needing a human holding a
phone, empirical threshold tuning, or a cloud account are the expensive ones regardless of how few
lines they produce.

**👤** — cannot be completed unattended.

---

## Phase 0 — Foundation ✅

| ID | Task | Context | Cx | Tok | Status |
|---|---|---|---|---|---|
| T0.1 | pnpm workspace, `tsconfig.base.json`, shared config | `00-overview.md` §Recommended stack | S | low | ✅ |
| T0.2 | **`packages/protocol`** — types, codec, constants, clock | `00-overview.md` §Shared input contract + §Latency budget; `layer-1-controller.md` §Output contract + §Tuning knobs; `layer-2-transport.md` §MessageCodec | M | low | ✅ |

> T0.2 was the highest-leverage task in the plan. Every later phase gets cheaper by the amount of
> contract detail living here instead of being re-derived.

**Verification:** `pnpm -r build`, `pnpm -r typecheck`, `pnpm -r test` — all clean, 11/11 tests pass.

### What Phase 0 actually produced

- **`types.ts`** — the doc's four message types, plus `ping`/`pong`. Those two are not in
  `00-overview.md`, but `ClockSync` (T2.3) and `Heartbeat` (T2.4) both require them, so they are part
  of the wire contract and belong here rather than being bolted on later.
  `channelFor()` is the single source of truth for reliable-vs-unreliable, so the WebSocket path
  (T2.2) and the WebRTC path (T2.5) cannot drift on the one rule `layer-2-transport.md` §Gotchas
  warns about.
- **`constants.ts`** — every tuning knob in one file. This is the cost rule made concrete: the
  expensive T1.2/T1.3 tuning sessions edit exactly one file. Room-code alphabet excludes I/O/0/1
  because codes get read aloud across a room and typed on a phone keyboard.
- **`codec.ts`** — `encode` / `decode` / `tryDecode` / `validate` with real shape checking.
  `tryDecode` returns `null` instead of throwing, because Layer 4's server-side validation
  (`layer-4-backend.md` §Responsibilities) must never crash on a malformed or hostile frame.
  MessagePack swaps in at `setWireFormat()` and nowhere else.
- **`clock.ts`** — `ClockSync` with **min-RTT selection** rather than averaging, so a single
  bufferbloat spike cannot poison the clock estimate for seconds.

**Lesson worth keeping:** the round-trip test caught a sign inversion in `ClockSync`. NTP's standard
offset formula yields *local→remote*; `toLocal()` needs the negation. Fixed in
`packages/protocol/src/clock.ts` with a comment naming the trap, and the test now pins the direction
with a worked example. This is the argument for writing Phase 0's tests before any layer depends on
the package.

---

## Phase 1 — Layer 1: Controller (phone PWA) ✅ · T1.7 ✅ · T1.8 code ✅, tuning owed

Module names mirror `docs/layer-1-controller.md` §Modules exactly. Everything lives in
`apps/controller/src/modules/`.

| ID | Task | Context | Cx | Tok | Status |
|---|---|---|---|---|---|
| T1.1 | `PWAShell` + `PermissionGate` — service worker, manifest, wake lock, secure-context check, iOS `requestPermission()` inside a real tap handler | `layer-1-controller.md` §Modules, §Gotchas | M | med | ✅ |
| T1.2 | `SensorReader` + `Calibrator` + `SensorFusion` — `devicemotion`/`deviceorientation`, null-field fallback (`accelerationIncludingGravity`-only devices), neutral-pose offset, complementary filter | `layer-1-controller.md` (full) | L | high | ✅ code · ⏳ tuning 👤 |
| T1.3 | `GestureRecognizer` — swing/shake via accel-magnitude threshold + cooldown | `layer-1-controller.md` §Modules, §Tuning knobs | M | high | ✅ code · ⏳ tuning 👤 |
| T1.4 | Buttons + `Haptics` (Vibration API) + on-screen debug readout | `layer-1-controller.md` §Modules | S | low | ✅ |
| T1.5 | `InputSerializer` + `NetClient` — 50 Hz throttled loop for `state`, immediate send for `button`/`gesture`; no-op in local demo mode | `packages/protocol` + `layer-1-controller.md` §Architecture | S | low | ✅ |
| T1.6 | `PairingUI` — room-code entry, QR scan target, connection status | `layer-1-controller.md` §Modules | S | low | ✅ |

### New Layer 1 work, found by using it

| ID | Task | Context | Cx | Tok | Status |
|---|---|---|---|---|---|
| T1.7 | **Quaternion orientation** — carry a quaternion on the wire, compose calibration instead of subtracting angles, derive axes from a pointing vector | `packages/protocol` §types; `sensor-fusion.ts`; `input-adapter.ts` | L | high | ✅ code · ⏳ feel 👤 |
| T1.8 | **Directional gestures** — classify a flick as up/down/left/right, resolved in the calibrated screen frame | `gesture-recognizer.ts`; `layer-1-controller.md` §Tuning knobs | M | med | ✅ code · ⏳ tuning 👤 |

#### T1.7 — what landed, and what it cost

Built as specified. `packages/protocol/src/quat.ts` is the new module — layout `[x, y, z, w]` to match
Three.js, W3C device and earth frames, `quatFromEuler` composed from `Rz · Rx · Ry` rather than
transcribed as a closed form so it can be read and checked.

Three things worth keeping:

1. **The pointing frame must be derived from `forward`, not hardcoded.** Measuring azimuth and
   elevation against fixed device axes works perfectly for the default grip and silently breaks any
   other: with `forward: [0, 1, 0]` the elevation read `asin(1)` — a constant `+1` — at the pose it had
   just been calibrated in. Building `right`/`up` from `forward` fixes it and is what makes the
   "a grip is a mapping literal" claim actually true.
2. **Azimuth/elevation is not an isometric decomposition.** Like longitude and latitude, a fixed
   angular step covers more azimuth further from centre — 20° of true deflection reads as 20.05°
   after a 70° roll. Bounded, under 0.25% inside a ±40° binding, and documented at
   `pointingDeg` so the next person does not read it as drift.
3. **`o` is derived from `q` in one place.** Any caller able to supply both would eventually supply a
   mismatched pair, and a HUD contradicting the cursor reads as a rendering fault rather than a
   plumbing one.

#### Why it was a rewrite and not a patch

Euler angles are the wrong representation for the job, and every axis problem seen on hardware is a
symptom of that one choice:

- **Calibration is wrong in principle.** `Calibrator` does `o - offset` per angle. Subtracting Euler
  angles is not composing rotations, so it is only valid near the calibration pose.
- **`alpha` and `gamma` couple** as `beta` approaches ±90°. Held upright, a phone sits there, and
  leaning left/right registers in `alpha` while a `gamma`-driven axis reads a flat zero.
- **The bindings cannot compensate.** `X`/`Y`/`S` on the display exist to hand-patch this and cannot
  fix it — a degenerate representation stays degenerate whichever angle you read.

The shape of the fix:

- `StateFrame` carries `q: [x, y, z, w]` alongside `o` (keep `o` briefly so nothing breaks mid-change,
  then drop it and bump `PROTOCOL_VERSION`).
- `Calibrator` stores a neutral quaternion and applies `q_neutral⁻¹ · q_current` — an actual rotation
  composition, correct at any attitude.
- `SensorFusion` slerps between quaternions instead of lerping angles.
- `InputAdapter` gains a **pointing** source: rotate a forward vector by the calibrated quaternion and
  read the axes off where it points. The mapping table stays data-driven; only the source type is new.

That last piece is what makes the games work: "where is the phone pointing" is one stable question at
any grip, where "what is `gamma` doing" is three different questions depending on how you hold it.

**Verify on hardware:** calibrate, then point at each corner of the screen and back to centre. The
cursor should return to centre every time, and the same wrist motion should move it the same distance
whether the phone is held flat or upright. `X`/`Y`/`S` should become unnecessary and can be deleted.

#### T1.8 — what landed

Built, and it cost less than budgeted because two earlier decisions paid out.

**Direction rides in the gesture *name*, so there is no protocol change.** `GestureEvent.name` was
already a plain `string` and `InputMapping.gestures` was already keyed by it, so a directional flick
is simply `"swing:left"`. `InputAdapter` tries the specific name and falls back to the part before
the colon — which is what lets Flappy keep mapping `swing` and keep flapping, while an endless
runner maps `swing:left` and gets a lane change. Both read the same wire event, and a controller
predating T1.8 still works. **`PROTOCOL_VERSION` stays at 2.**

**Direction is sampled on the way *up*, not at the peak.** A flick is two phases — the hand
accelerates into the motion, then decelerates to stop it — and the deceleration is frequently the
*larger*, because stopping a wrist is more abrupt than starting it. Classifying at the peak reports
the direction backwards on exactly the crispest gestures. `GESTURE_ONSET_FRACTION` catches the
acceleration phase while it is still unambiguous.

**A diagonal reports no direction rather than guessing.** Below `GESTURE_MIN_DOMINANCE` the gesture
still fires, as a plain `swing`. A game told "left" on a 45° flick commits a lane change the player
did not ask for, and that is indistinguishable from a bug.

**It is classified in the calibrated screen frame**, which is what T1.8 always required —
*"otherwise 'swipe left' means something different every time the wrist rolls."* `Calibrator` gained
`toScreenFrame`, which is deliberately **not** `apply`: `apply` returns an *orientation* in canonical
coordinates (`conj(B) · R · B`), while rotating a *vector* needs the plain change of frame with no
trailing `B`. Using `apply` there would be wrong by exactly one basis rotation — the kind of error
that surfaces as "left sometimes means up".

**Still owed: the tuning, and it is the expensive half.** Three constants are guesses
(`GESTURE_ONSET_FRACTION`, `GESTURE_MIN_DOMINANCE`, and the existing `SWING_THRESHOLD`), and the
plan has said from the start that this is the task that wants recorded traces first.

#### T1.8 — the original argument, kept because it still holds

`GestureRecognizer` classifies by acceleration *magnitude* only: past the threshold it fires `swing`,
and several peaks in a row become `shake`. It cannot say **which way** the phone moved, and two of the
three games below need exactly that.

Direction has to be resolved in the device frame and then rotated into the world by the calibrated
orientation — otherwise "swipe left" means something different every time the wrist rolls. This is
cheap to write and expensive to tune, so it is the one that wants a recorded-trace fixture set (see
§Overall verification) before the thresholds are touched.

### Correction to the original session split

The plan first said "reserve a separate session for T1.2 + T1.3." That conflated two different
things. The **code** for sensor fusion and gesture recognition needs no phone; only **tuning the
thresholds and verifying cross-device behaviour** does. Splitting on the task boundary would have
loaded Layer 1 context twice. All Layer 1 code was therefore written in one pass, leaving only the
genuinely human part outstanding — which now costs one cheap round-trip per adjustment instead of a
full session.

The rule generalises: **split sessions on "needs a human" vs "does not", never on task ID.**

### Design decisions worth not relitigating

- **`SensorFusion` fuses the browser's already-fused `deviceorientation`, not the raw gravity vector.**
  Re-deriving tilt from raw gravity needs per-platform axis sign conventions, and §Gotchas warns those
  differ across browsers. Fusing the platform's own estimate inherits whatever convention it chose,
  and the `Calibrator` normalizes the remainder.
- **`GestureRecognizer` re-arms on the way down** (below 60% of threshold), not on the cooldown alone.
  A long swing can stay above threshold for longer than `GESTURE_COOLDOWN`, which would fire it twice.
- **`SensorReader` estimates and subtracts gravity** when a device exposes only
  `accelerationIncludingGravity`. Without it, a phone lying still on a table carries a constant
  ~9.81 m/s² bias — enough to trip the swing threshold permanently.
- **`TraceRecorder` stores raw, pre-calibration samples.** A trace has to stay replayable against a
  *changed* calibration, so it records what the sensor said, not what we made of it.
- **The service worker is network-first, not cache-first.** A silently stale controller running
  against an updated protocol produces exactly the invisible schema-mismatch failure
  `layer-4-backend.md` §Gotchas warns about.

### ⏳ Outstanding — needs a real phone

Confirmed on an iPhone during the first device session, and no longer open:

- **iOS permission flow.** The gate clears and motion access is granted. The no-`await`-before-
  `requestPermission()` rule holds.
- **Send rate.** Reads ~50 Hz on hardware, once the deadline bug was fixed. The old `send hz = 0`
  reading was the suspended-`rAF` explanation, now positively confirmed rather than merely plausible.
- **Sensor source.** The device reports `linear` — the platform supplies gravity-free acceleration, so
  the noisier `derived` fallback is not being exercised there.
- **End-to-end pairing over HTTPS.** QR scan → room join → live frames, on a LAN certificate.

Still open. Every item is also flagged **in the code** at the line it affects:

```
rg "TODO\(on-device\)" apps/controller packages/protocol
```

1. **Threshold tuning (T1.3).** `SWING_THRESHOLD = 16 m/s²` and `GESTURE_COOLDOWN = 280 ms` remain the
   doc's starting guesses. Gestures do fire end to end, but nobody has yet checked that a deliberate
   swing always registers and a gentle wave never does. Edit `packages/protocol/src/constants.ts` only.
2. **Record gesture traces.** Use **Export trace** for three clean swings, three gentle waves that must
   *not* fire, and one shake. These are the offline fixtures that stop T1.3 being re-paid every time
   the recognizer changes — and **T1.8 needs them more than T1.3 did**, because directional
   classification has four outcomes to confuse instead of two.
3. **Cross-device check (T1.2).** Android has not been tried at all. Watch the HUD's `source` row: a
   device on the `derived` path estimates gravity itself and is the noisier case.
4. **Wake lock.** Confirm the screen survives being held still for 30 s mid-game.
5. **Haptics.** Absent on iOS Safari by design; confirm they fire on Android.
6. **~~`FUSION_HALF_LIFE_MS = 45`~~ — superseded.** The device session reported *both* complaints at
   once, which is the tell that one fixed half-life is the wrong shape rather than the wrong number.
   Smoothing is now speed-adaptive, and the three constants that replaced it are the new guesses:
   `FUSION_HALF_LIFE_REST_MS = 120`, `FUSION_HALF_LIFE_FAST_MS = 12`, `FUSION_FAST_DEG_PER_S = 90`.
   Turn the crossover down if aiming feels sticky, up if a held cursor still shimmers.

> Items 1, 2 and 6 were gated on T1.7, which is now not merely written but **verified on hardware**.
> Item 2 — recording the traces — is the single highest-value thing left in Layer 1, and it now
> gates the *tuning* of T1.8 rather than its code. See §What to do next.

7. **~~T1.7's own verification~~ — done, and it failed.** See §The second device session. The cursor
   now tracks in both grips and the axes survive a landscape calibration. `X`/`Y` were *not*
   deleted: the session proved they are load-bearing, because the pointing sign is a convention the
   sensors cannot resolve.
8. **Directional gesture tuning (T1.8).** `GESTURE_ONSET_FRACTION = 0.45` and
   `GESTURE_MIN_DOMINANCE = 1.35` are guesses. Judge them by whether a deliberate flick left is
   *always* called left, and whether a diagonal declines to pick one. The HUD now prints the wire
   name and the dominance ratio — `swing:left @ 18.2 x2.4` — so this is reading two numbers rather
   than guessing. **Do the traces first**; four outcomes is too many to tune by re-swinging.

9. **`CUT_SPEED` (T3.8).** Fruit slash's only threshold, and it lives in the game rather than in
   `constants.ts` because nothing else uses it. Judge it by whether a deliberate stroke always cuts
   and a slow re-aim never does. It is a *pointer* speed, so unlike `SWING_THRESHOLD` it should mean
   the same thing at any grip — worth confirming, since that is the T1.7 claim applied to a game.
10. **Does the slice land where you aimed?** §Phase 3c's own question, and the one no harness can
   answer. Watch for the blade lagging the wrist under fast strokes: that is `maxExtrapolationMs`
   (T3.5), not the collision test.

11. **The mix (T3.12).** `pnpm check` proves cues *fire*; nothing proves they sound good together, and
   a headless browser runs the audio graph with `--mute-audio` into no speaker at all. Every gain and
   duration in `apps/display/src/audio/cues.ts` is a first guess made on one pair of laptop speakers.
   Three specific things to listen for, because they are the ones the design bet on:
   - **`shoot` is deliberately the quietest cue in the table.** It fires ~4×/second for a whole round.
     If it is tiring by wave two it is still too loud, not too quiet.
   - **A star fighter bomb.** Thirty aliens die in one step. It should sound like one big event; if it
     clicks or pumps, `maxVoices` or the limiter threshold in `AudioManager` is wrong.
   - **A fruit slash flurry.** Four fruit in one stroke should read as several slices, not one flangey
     one. That is `slice`'s `minIntervalMs`, and it is the cue most likely to be mistuned.

   Unlike the sensor items above this needs no phone — only a room and a real speaker — so it does not
   have to wait for a device session.

**Verify:** see `docs/running.md` §3a — generate a LAN certificate, install it on the phone, open the
display on its LAN address. On the phone: tap power → Allow → tilt moves the debug numbers; Calibrate
zeroes them in a neutral pose; a swing fires exactly one gesture and a gentle wave fires none.

---

## Phase 2 — Layer 2: Transport (WebSocket first) ✅

`layer-2-transport.md` §Rule of thumb is explicit: **start with WebSockets**, reach for WebRTC only
when measurement proves you need it. WebRTC is T2.5, deliberately last.

| ID | Task | Context | Cx | Tok | Status |
|---|---|---|---|---|---|
| T2.1 | Bare `ws` relay in `apps/server` — join by room code, fan out frames to the room | `layer-2-transport.md` §Architecture; `packages/protocol` | S | low | ✅ |
| T2.2 | `ChannelRouter` — one API over reliable vs unreliable; WS backend now, WebRTC backend later with no caller changes | `layer-2-transport.md` §Modules, §Gotchas | M | med | ✅ |
| T2.3 | `ClockSync` wiring — stamp `recvTs` + estimated one-way latency onto every delivered frame (the class already exists from T0.2) | `layer-2-transport.md` §Interfaces, §Latency budget | M | med | ✅ |
| T2.4 | `Heartbeat` — liveness ping, exponential-backoff transparent reconnect | `layer-2-transport.md` §Modules | M | med | ✅ |
| T2.5 | **WebRTC path** — `SignalingClient`/`SignalingServer`, `PeerConnectionManager`, DataChannel with `ordered:false, maxRetransmits:0` for state | `layer-2-transport.md` (full); `layer-4-backend.md` §SignalingService; `layer-6-infrastructure.md` §TurnStunCluster | **XL** | **v.high** 👤 | ⬜ deferred |

### What Phase 2 produced

- **`packages/transport`** — a second shared package. `ChannelRouter` lives here, not in the
  controller, for the same reason the codec does: the phone and the screen must not drift. Layer 3
  will import the same router.
- **`apps/server`** — the relay: rooms by code, fan-out excluding the sender, `ping`→`pong` as the
  clock reference, idle-socket reaping, immediate deletion of empty rooms.
- **`tools/test-display/index.html`** — the doc's step-2 milestone ("prove a tilt value moves a dot").
  Deliberately throwaway and build-free; **it must not grow into `apps/display`**, which is T3.1.
- **`NetClient` is now a thin adapter** over `WebSocketChannelRouter`. Its API is unchanged, so
  `main.ts` was untouched — which is the evidence that the T2.5 swap will also be invisible upward.

### The one decision that matters here

**A WebSocket is reliable and ordered, so the drop policy has to be enforced by hand.** §Gotchas
warns against putting continuous state on a reliable channel because head-of-line blocking stacks
stale frames — but calling `send()` at 50 Hz over one congested socket *builds exactly that queue*.
So both ends check `bufferedAmount` before sending `state` and discard rather than queue: a frame
delayed behind a backlog describes a pose the hand left long ago. Reliable traffic never takes that
path, because a dropped button-up leaves a player holding a button they released.

This is why `channelFor()` lives in the protocol package and callers never choose a channel.

### Verification — 29 tests, no hardware needed

Unlike Phase 1, Layer 2 is fully testable unattended, and is tested end-to-end over real sockets
with the real client router:

- a frame reaches the other peer and **never echoes to its sender**;
- **rooms are isolated** — a frame does not cross room boundaries;
- ping/pong yields a sane latency estimate, and pongs are consumed by `ClockSync` rather than
  surfacing to callers;
- an existing peer is told when someone joins (so a display can show "controller connected");
- **malformed and hostile input is ignored, never fatal, never forwarded** — and the relay still
  routes valid traffic afterwards;
- **a dropped socket reconnects, rejoins its room, and resumes routing**;
- empty rooms are deleted rather than leaked;
- `state` is dropped for a backed-up peer while `button` still gets through;
- one broken peer does not break fan-out to the others.

> **The relay`s `dev` script was broken** and has been fixed. `--experimental-strip-types` does not
> rewrite a `./relay.js` specifier to `./relay.ts`, so the entry point failed to resolve its very
> first relative import on Node 24. It now builds and runs `dist/index.js` under `--watch`. Worth
> noting because the command above is what Phase 2`s own verification steps tell you to run.

**Defer T2.5 until after Phase 4 and T6.3.** It depends on the backend hosting signaling and on TURN
existing, and `layer-6-infrastructure.md` §Gotchas names it as the thing that "quietly fails" — it only
proves out when tested from a real cellular connection behind carrier NAT. Doing it early means doing
it twice.

### ⏳ Outstanding — needs a real phone

The relay is proven; what is unproven is the **phone-to-screen path over a tunnel**. Run:

```
pnpm --filter @wii/server dev          # relay on :8081 (see note below)
pnpm --filter @wii/controller dev      # controller on :8080
npx serve -l 8082 tools/test-display   # test display
```

Then tunnel both `8080` and `8081` (sensors need HTTPS, and a `wss://` relay), open the controller on
the phone with `?relay=wss://<tunnel>`, and the test display with the same room code.

1. **Tilt moves the dot**, and it feels immediate. This is the Layer 2 milestone.
2. **Frame age stays under 80 ms** — the test display turns it red past the budget.
3. **`wss://` through the tunnel actually connects.** A mixed-content block fails in a way that looks
   identical to the relay being down, which is why this is called out separately.
4. **Kill the relay mid-stream** — the phone reconnects with no reload, and the dot resumes.

---

## Phase 3 — Layer 3: Display + engine — 3a ✅ · 3b ✅ · 3c ⬜

**Split by testability, not by task order** — the rule Phase 1 established. Layer 3's logic is pure
and deterministic; its rendering is not verifiable without a browser. Building them together would
have meant shipping the expensive-to-get-wrong parts unverified alongside the parts that genuinely
cannot be checked.

### Phase 3a — logic ✅ (`packages/engine`, renderer-agnostic, 43 tests)

| ID | Task | Context | Cx | Tok | Status |
|---|---|---|---|---|---|
| T3.2 | **`InputAdapter`** — network frames → abstract game actions via a **data-driven mapping table**, so a new game needs no netcode change | `layer-3-display-engine.md` §Architecture, §Modules, §Gotchas; `packages/protocol` | M | med | ✅ |
| T3.3 | `GameLoop` (fixed-step sim + interpolated render) + `SceneManager` (menu → pairing → lobby → play → results) | `layer-3-display-engine.md` §Architecture, §Modules | M | med | ✅ |
| T3.5 | Client-side prediction + smoothing so aim feels instant under jitter | `layer-3-display-engine.md` §Latency & feel | L | high | ✅ logic · ⏳ feel 👤 |

### Phase 3b — rendering ✅ (**Three.js**)

| ID | Task | Context | Cx | Tok | Status |
|---|---|---|---|---|---|
| T3.0 | `apps/display` scaffold — Vite + TS + Three.js, mirroring the controller | `apps/controller` build config | S | low | ✅ |
| T3.1 | Display app shell + pairing scene rendering the QR the phone scans | `layer-3-display-engine.md` §Responsibilities, §Latency & feel | M | med | ✅ |
| T3.4 | Debug scene — tilt drives a 3D cursor. **The vertical-slice proof.** | `packages/engine` | S | low | ✅ |

### Phase 3c — games ⬜

The point of T3.2 was that a new game is a self-contained module and a mapping literal, never a change
to the netcode. These four are where that claim gets tested. If adding the second game means opening
the transport, the seam failed and it is worth stopping to fix it rather than pushing through.

| ID | Task | Needs | Cx | Tok | Status |
|---|---|---|---|---|---|
| T3.6 | **`GameModule` seam + menu** — one interface every game implements, a registry, a game-select scene, `HUD` | — | M | med | ✅ |
| T3.7 | **Flappy** — one input, side-on scroller | — | S | med | ✅ code · ⏳ feel 👤 |
| T3.8 | **Fruit slash** — throw, point, slice along the stroke | **T1.7** ✅ | L | high | ✅ code · ⏳ feel 👤 |
| T3.9 | **Endless runner** — three lanes, jump, duck | T1.8 ✅ | L | high | ⬜ 👤 · **unblocked** |
| T3.10 | *(deferred)* **Tennis** — the doc's original first game | T1.7 | L | high | ⬜ |
| T3.11 | **Star fighter** — shoot-'em-up: point to fly, waves, weapon pickups | T1.7 ✅ | L | high | ✅ code · ⏳ feel 👤 |
| T3.12 | **Audio** — `AudioDirector` mixing policy, synthesised voices, one cue table, cues in all four games | T3.6 ✅ | M | med | ✅ |

#### Build them in this order, and the order is the point

**T3.6 first, and keep it small.** A `GameModule` is: a name, an `InputMapping`, a `Scene`, and assets.
The registry is a `Map`. Resisting the urge to build a framework here matters — the second and third
games are what reveal what actually wants to be shared, and anything abstracted before then is a guess.

**T3.7 Flappy is the right first game**, not because it is the most fun but because of what it does not
need. One binary input, no pointing, no direction, no orientation at all — so it is the only game that
**does not depend on T1.7**, and it can be built and played while the quaternion work is still open. It
proves the whole chain carries a *game* rather than a debug cursor: fixed-step physics, collision,
scoring, results, restart. Its input is a flick or a button press, both of which already work.

Its real value is as a latency instrument. Flappy is unforgiving about input lag in a way a cursor is
not — if the tap-to-flap feels late, something in the 50–80 ms budget has regressed, and you will feel
it before any dashboard shows it.

**T3.8 Fruit slash needs T1.7 and is the reason T1.7 comes first.** Slicing is a stroke through 2D
screen space: where the phone points, sampled over time, forming a path that is tested against fruit
colliders. On Euler angles that path distorts as the wrist rolls and breaks entirely near vertical. On
a pointing vector it is just a polyline. The gesture layer barely features — it is `aim` plus a
velocity threshold on the pointer, not a `swing` event.

#### T3.8 — what landed, and what the third game revealed

**The seam held.** Adding fruit slash touched a mapping literal, one scene file, and one line of the
registry. No change to the transport, the protocol, `InputAdapter`, or any other game. That was the
claim T3.2 was built on and §Phase 3c said would be tested here — *"if adding the second game means
opening the transport, the seam failed"* — and it survived the third.

**It has no gesture binding at all.** `FRUIT_MAPPING` is two pointing axes plus `b` for backing out.
No `swing`, no `shake`. A slice is where the phone points, sampled at the simulation rate, plus a
speed threshold on the pointer — which is the clearest possible statement of what T1.7 bought, and
means `SWING_THRESHOLD` has no influence on this game whatsoever.

**One thing was worth sharing, and only the third game revealed it:** collision against a *path*
rather than a position. At 60 Hz a flick crosses several fruit-widths between samples, so testing the
sample points misses exactly the fastest strokes. `packages/engine/src/geometry.ts` now holds the
swept segment/circle test, with 8 tests. Tennis (T3.10) and bowling ask the same question, and the
plan's rule — *"the second and third games are what reveal what actually wants to be shared"* — is
what says it belongs there now rather than earlier.

Gameplay lives entirely in the fixed-step `update`, blade sampling included; `render` only
interpolates. That is what keeps "did that slice land" independent of the display's refresh rate. The
cursor ring is the one exception, drawn from render-time prediction so aiming stays immediate.

#### T3.11 — Star fighter, and the fourth confirmation

A shoot-'em-up: point to fly, auto-firing lasers, descending alien waves, weapon pickups. Not in the
original plan — asked for during the session — which makes it the cleanest test of the seam so far,
because nothing about it was designed for.

**It needed nothing new.** A mapping literal, one file, one line of the registry. No engine
capability, no protocol change, no gesture work. Notably it does **not** need T1.8: a shmup wants
continuous aim, not directional flicks, so it was buildable the moment T1.7 landed.

**It is the first real reuse of `segmentIntersectsCircle`**, which T3.8 contributed. Bullets travel
14 world units per second — over a third of an alien's diameter per fixed step — so testing bullet
*positions* would drop exactly the fastest shots. The plan's rule about the second and third games
revealing what wants sharing paid out on the fourth.

**Auto-fire, and the button is a bomb.** Holding a fire button while aiming a phone is genuinely
awkward: the thumb holding it is on the hand doing the aiming, and the tremor lands in the cursor.
So `a` is a limited-charge screen clear — a decision, not a key you hold. It clears incoming
*bullets* too, or a bomb would kill the player it was spent to save.

**T3.9 Endless runner needs T1.8.** Lane changes are discrete directional flicks (left/right), jump and
duck are up/down. Continuous tilt is the tempting alternative and is worse: a player leaning to steer
cannot also hold the phone still enough to read the screen. Discrete, committed inputs suit a game
where the world comes at you at a fixed rate.

**T3.10 Tennis is deferred, not dropped.** `00-overview.md` §Suggested build order proposes it, and it
remains the best showcase of a full swing. It is displaced because it needs both T1.7 *and* good swing
timing, which makes it the most expensive of the four to get feeling right — a poor choice for the
first game and a good one for the fourth.

#### T3.12 — Audio, and the correction it forced

**T3.6 was recorded as having delivered an `AudioManager`. It had not.** Nothing in the display
touched WebAudio, and four finished games ran silent — which is the exact failure this file warns
about elsewhere, a status line that says a thing exists when only the intention did. T3.6's row is
amended above; the audio is T3.12 and it is now real.

**The policy is in `packages/engine`, the noise is in `apps/display`.** §Why `packages/engine` says
the expensive-to-get-wrong parts belong where they can be tested without a browser, and the decisions
here qualify: `AudioDirector` owns throttling, the polyphony cap, priority eviction, mute and gain,
with **17 unit tests** and no WebAudio anywhere in it. `apps/display/src/audio/` holds the part that
genuinely needs a browser — an `AudioContext`, three synthesised voice shapes, and the cue table.

**Every sound is synthesised; there are no audio assets.** The same argument the renderer already
made with primitives instead of models: nothing to fetch, nothing to decode, no silent first minute
while a sprite sheet of sound effects loads, and the repo stays self-contained. The cost is that a
recorded voice or a licensed music bed is out of reach without changing `cues.ts`, which is where that
decision is written down.

**The cue table is `input/mappings.ts` for output.** A game says `audio.play('slice')` and never what
a slice sounds like, which is the T3.6 seam rule pointed the other way. `CueName` is derived from the
table, so a game naming a cue that does not exist fails to compile rather than failing to make a noise
on a TV two weeks later.

##### The autoplay problem, which this display has worse than most

Browsers keep an `AudioContext` suspended until the page sees a user gesture, and normally that
resolves itself the first time a player clicks something.

**Not here — nobody ever touches this screen.** A player scans a QR and every input afterwards is a
WebSocket frame, and a WebSocket frame grants no user activation however deliberate the gesture behind
it was. Tilt, press A, finish a round: the display sees network messages, the context stays suspended,
and the failure is not an error anywhere. It is a laptop that is simply silent forever, which reads as
the audio work not functioning.

So the pairing screen asks for one click, and it asks there specifically: it is the last moment a
player is looking at the display with nothing else to do. `pnpm check` asserts both halves of that —
that cues actually reach the mixer, and that the hint is **absent** when sound already works, because
a nag that is always on trains people to ignore the one case where it matters.

The headless checks pass `--autoplay-policy=no-user-gesture-required`, or they would be asserting on
the blocked branch rather than the real one.

##### What the games needed

Almost nothing, which is the seam holding again: a `ctx.audio.play(...)` at points that already
existed. Two were worth a comment at the call site — star fighter plays `shoot` once per *volley*
rather than once per bullet, and both fruit slash's flurries and a bomb's thirty simultaneous
explosions are left entirely to the director's throttle and cap rather than being second-guessed in
the game. A second ad-hoc limiter in a game would only hide the tested one.

`GameResult` gained `record?: boolean` on the way through. A game is the only thing that can know it
beat its own stored best, and the results screen is the only thing that should decide how to celebrate
it — one fanfare, in one place, instead of four.

#### What all four share, and what they must not

Shared, in `packages/engine` or `apps/display/src/game/`: the module interface, the registry and menu,
the audio director and cue table, `HUD` primitives (score, lives, timer), a results scene.

**Not shared:** anything about how input reaches the game. Every game reads abstract actions and axes
from `InputAdapter`. If a game ever needs to know that a `swing` came from an accelerometer, the seam
has been breached — that is the failure mode T3.2 exists to prevent, and it is worth catching the first
time rather than the fourth.

#### Cost note

The three new games are marked 👤 for the same reason T3.6 always was: **they are expensive for feel,
not for code.** "Does the slice land where I aimed", "is the flap responsive", "did that lane change
register" are human judgements made many times in a row. Flappy is the cheapest by a wide margin
because it has exactly one input to tune; the runner is the most expensive because a mis-tuned
directional threshold is indistinguishable from a mis-timed input, and both feel like the game is
broken.

### Why `packages/engine` and not `apps/display`

Nothing in it touches the DOM, WebGL or Three.js. That keeps the expensive-to-get-wrong parts
testable without a browser, keeps the renderer swappable (a later Godot port touches only Layer 3's
top), and makes the logic reusable for **Model B** — `00-overview.md` describes folding Layer 1 into
Layer 3 so the game runs on the phone itself, which needs exactly this code without a separate
display app.

### Two bugs the tests caught

- **`maxFrameMs` was set to 83 ms** — near the frame budget, which is the tempting and wrong choice.
  An ordinary GC pause or asset decode blows past it, and the loop then discards real time, which a
  player sees as the game briefly running slow. Raised to the conventional **250 ms**: the clamp is a
  circuit breaker for catastrophic stalls (backgrounded tab, closed lid), not a jitter smoother.
  Anything short enough to trip on a normal hitch is doing the wrong job.
- **A test asserted on an exact float boundary.** 100 ms looks like exactly 6 steps at 60 Hz, but six
  steps sum to 100.00000000000001, so it yields 5. Durations in loop tests now sit deliberately
  between step boundaries.

### Design decisions worth not relitigating

- **`InputAdapter` reconciles held buttons from the 50 Hz `btn` list**, not just from button events.
  Button events are reliable, so this looks redundant — but a client that reconnects mid-press never
  saw the `down`, and an `up` sent while the link was down is gone (Layer 2 queues reliable traffic
  while *connecting*, not across a disconnect). The state frame carries the truth and wins. Without
  it, a reconnect can leave a player permanently holding, or unable to hold, a button.
- **Swapping a mapping releases held actions first.** Otherwise an action held under the old mapping
  stays stuck forever, because its `ended` event arrives addressed to a binding that no longer exists.
- **Axis deadzones rescale the remaining travel** so the axis still reaches ±1 at full range, rather
  than losing the deadzone's worth off the top.
- **Axes use `deltaDeg`, not subtraction**, so an alpha-driven axis stays continuous across ±180 —
  otherwise it is discontinuous exactly where a player turns around.
- **Smoothing is expressed as a half-life, not a coefficient.** A fixed alpha silently smooths twice
  as hard at 100 Hz as at 50 Hz.
- **`PredictiveAxis` smooths *before* predicting.** Differentiating a noisy signal amplifies the
  noise; prediction then multiplies it into a visible lurch.

**T3.2 is the seam that decides whether this project stays cheap.** Get the mapping table right —
`"swing"` maps to an abstract action, never a hardcoded tennis call — and every future game is a
self-contained module. Get it wrong and every new game re-opens the network layer. Spend the design
effort here.

**The games are expensive for feel, not code.** "Does the slice land where I aimed", "is the flap
responsive" — human judgements made many times in a row. See §Phase 3c.

### What 3b produced

- **`apps/display`** — Vite + Three.js, same build shape as the controller. `Stage` is the only
  file that touches WebGL; every decision above it already lived in `packages/engine`, which is what
  makes the "renderer is swappable" claim in §Why `packages/engine` testable rather than aspirational.
- **`DisplayClient`** — the screen's half of Layer 2, and the task T3.1 hid. The plan named
  `NetClient` explicitly for the controller (T1.5) but never for the display, so it arrived as
  unbudgeted work inside T3.1. It adds the two things only a receiver needs: **presence** (a healthy
  socket does not mean a phone is still sending) and **frame age**.
- **The scene machine, wired to real scenes** — pairing → lobby → play, with the reverse edges the
  engine already declared legal.
- **`tools/fake-controller`** — a phone-shaped thing without the phone. Same protocol package, same
  50 Hz cadence, same clock discipline. It moves the "needs a human" line: everything except the
  sensors can now be proven unattended.
- **`tools/display-check`** — the browser verification the plan said was missing, scripted. Drives
  headless Chrome over the DevTools protocol with no automation dependency, and asserts the full
  round trip including the drop-and-recover path.

### The clock bug this phase exposed

Layer 3 was the first thing to *read* `StateFrame.t`, and it was wrong at the source. The controller
stamped it with the `requestAnimationFrame` timestamp — page-relative milliseconds — while both
`ClockSync` instances sync against the relay's `Date.now()`. Those clocks have no relationship, so
frame age was subtracting a reading from a stranger's clock.

The fix expresses `t` in **relay time**: the controller converts through its own `ClockSync`
(`toRemote`, new), the display converts back (`toLocal`, already existed). Both ends already ran
`ClockSync` against the same reference — this is what it was for.

Two lessons worth keeping. First, **a timestamp's clock is part of the wire contract** and `types.ts`
did not say which one `t` used; it does now. Second, the failure would have been *silent and
plausible* — a HUD reading "42 ms" that was really clock skew. That is worse than a blank readout,
which is why `frameAgeMs` returns `null` rather than guessing.

### Two more defects the browser check caught

- **The lobby stuck on "Controller connected" with no phone attached.** Presence was handled as an
  *event*, but `play → lobby` happens *because* presence went false — so the edge was always already
  gone by the time `enter` could subscribe. All three scenes now re-check presence as a **guard
  condition** in `update`, which cannot miss an edge. No screenshot at any single moment would have
  shown this; only asserting on a timeout does.
- **The status line jumped to the top of the screen** whenever a scene cleared its centre panel,
  because `.overlay-center:empty` removes itself from the grid and the status was promoted into the
  free row.

### The vertical slice is proven

`tools/display-check/e2e.mjs` runs the **real controller** against the **real display** through the
relay — 17 checks, no stubs on the path between them. It reads the controller URL off the display's
own pairing screen (the way a scanned QR would), taps the permission gate, drives the controller with
synthetic `devicemotion`/`deviceorientation` events, and asserts the whole chain: link, lobby, a
button press, frame age, send rate, cursor sweep, a swing, and the drop back to pairing.

That is §Overall verification's milestone reached — *"a phone tilt moves a dot on a separate screen,
end-to-end"* — with one substitution stated plainly: **the sensor hardware**. Everything downstream of
the event listener is shipping code. Everything upstream of it still needs a phone.

#### The Layer 1 bug it found: the controller sent at 30 Hz, not 50

`InputSerializer` reset its send deadline to `now` on every send. Capture runs off
`requestAnimationFrame` at ~16.7 ms, so "have 20 ms elapsed?" was false on every other frame and true
on the rest — **exactly 30 Hz on any 60 Hz display, with SEND_HZ = 50 unreachable by that algorithm at
any refresh rate**. The deadline now accumulates (`nextSend += interval`, clamped so a stall cannot
trigger catch-up); measured 50 Hz immediately after.

This mattered more than it looks. 30 Hz puts 33 ms between frames, and the whole budget is 50–80 ms —
a third of it was being spent on a scheduling mistake. It was invisible to every unit test, because
the serializer's behaviour is correct in isolation; it only appears when the caller's cadence is a
real display's refresh rate.

Also settled: the Phase 1 note wondering whether `send hz` reading 0 meant a broken send loop. It did
not — it was the suspended-`rAF` explanation, now positively confirmed against a page where `rAF` is
actually running.

#### Two harness lessons worth keeping

- **A scripted `element.click()` is not a tap.** It carries no user activation, so the permission gate
  stays shut and the Vibration API refuses to fire — indistinguishable from the user tapping Deny.
  Clicks go through `Input.dispatchMouseEvent`. And waiting for `#gate-btn` to *exist* waits for the
  wrong thing: it is in the parsed HTML long before `main.ts` attaches its listener.
- **Two tabs in one browser window cannot both run.** Chrome throttles the background tab's `rAF` to
  ~1 fps, which made a working display look frozen. The controller opens in a separate window, which
  is also the truthful model: a screen and a phone are two devices, both in front of somebody.

### ⏳ Outstanding for 3b

1. **Phase 3c (the games) is what remains in Phase 3**, plus T1.7 ahead of the pointing ones.
2. **Prediction tuning is still a feel judgement (T3.5).** `maxExtrapolationMs = 60` and the smoothing
   half-lives remain guesses. The debug scene now exists to tune against, and `B` on the controller
   resets the filters mid-motion — which separates "prediction is overshooting" from "the filter is
   still carrying state from the last violent motion".
3. **The only unproven layer is the sensors themselves.** Both harnesses synthesise motion events, so
   nothing below the event listener is exercised: whether a device reports `acceleration` or only
   `accelerationIncludingGravity` (the noisier `derived` path is never taken), whether iOS grants
   permission, whether a human swing clears `SWING_THRESHOLD`, and how any of it feels in a hand.
4. **The bundle is 556 kB (146 kB gzipped), nearly all Three.js.** Inside tolerance for a LAN-served
   screen, but `layer-3-display-engine.md` §Latency & feel asks for a fast first meaningful frame.
   Revisit at T6.1, not before.

**Reproduce the verification:**

```
pnpm --filter @wii/server dev        # :8081
pnpm --filter @wii/controller dev    # :8080
pnpm --filter @wii/display dev       # :8082

node tools/display-check/index.mjs         # 14 checks — display vs. a synthetic controller
node tools/display-check/e2e.mjs           # 18 checks — the real controller, end to end
node tools/display-check/fruit-slash.mjs   # 11 checks — a pointer stroke actually slices
node tools/display-check/star-fighter.mjs  # 12 checks — the guns hit something
```

### What T3.8 needed from the harness

The existing checks could not exercise this game at all: every one of them drives motion with the
fake controller's idle Lissajous, whose peak pointer speed sits **just under** `CUT_SPEED`. That is
correct behaviour — a slow re-aim must not slice — but it means a fruit-slash check driven by the
sweep alone tests nothing.

So the fake controller gained `--slash-every`: a fast orientation sweep, cycling through eight
crossing stroke patterns. Deliberately separate from its existing `swing()`, because a swing is an
acceleration event on the reliable channel and a slash is pure orientation on ordinary state frames —
this game reads only the second, and running the check with `--swing-every 0` is what keeps that
honest.

**The first attempt used a single repeated diagonal, and the game reliably ran out of lives having
sliced nothing.** That looked exactly like broken collision. It was a blade that never went near a
fruit: the stroke is at any given x for about one simulation step, so one fixed line covers almost
none of the play area. Cycling crossing strokes fixed it, and is also the better model — nobody
slices the same line twice.

Second lesson, cheaper: the check originally waited 25 s for a score, but three unsliced fruit end
the round in under ten. Most of that timeout was spent watching a results screen. It now stops the
moment the round ends and reports *"round ended having sliced nothing"*, which is the actual finding
rather than a timeout.

`tools/display-check/fruit-slash.mjs` — 11 checks — is a separate script rather than another phase of
`index.mjs`, because the two measure different things: `index.mjs` measures the *link* through the
debug cursor, this measures a *game*.

### Three harness defects T1.7 surfaced

None was caused by the quaternion work; all three were waiting for the next person to run the checks.

- **The menu now sits between the lobby and any game (T3.6), and neither harness knew.** Both pressed
  A blind and started whichever game the highlight had drifted onto — the tilt sweep steers the menu
  too — so `index.mjs` was landing in *Flappy's results screen* and reporting the cursor scene
  missing. Both now select deliberately: `index.mjs` via the display's arrow keys, `e2e.mjs` by
  holding the phone still first (which is what a player does to press a button) and then confirming
  with A on the phone, so the assertion it makes is unchanged.
- **`chrome.kill()` left the profile flagged as crashed**, so the *next* launch spent its startup
  recovering it and the controller tab could sit at `readyState === 'loading'` past any timeout. It
  failed on every other run, which is the tell — a clean run leaves a clean profile. `Cdp.shutdown`
  now closes the browser properly first. Raising the timeout, the obvious move, fixed nothing.
- **The tidy-up then aborted the process.** Racing the browser's own socket teardown trips a libuv
  assertion on Windows, so a fully green run exited 127 — a passing report with a failing exit code,
  which is worse than either alone.

The general lesson: **a check that has drifted out of date fails in the shape of the thing it is
checking**, not in the shape of the drift. A stale harness reported a broken cursor, a dirty profile
reported a hung dev server, and a teardown race reported a failed run.

Both write screenshots next to the script. The first is the faster loop while working on the display;
the second is the one that proves the slice.

**Verify:** T3.4 first — done, the cursor tracks on hardware. Then each game on a real device as it
lands. Confirm on real hardware early, per §Gotchas.

---

## Phase 4 — Layer 4: Backend (authoritative rooms) ⬜

The relay from T2.1 gets **replaced** here, not extended.

| ID | Task | Context | Cx | Tok |
|---|---|---|---|---|
| T4.1 | Migrate relay → **Colyseus 0.17**: `GameRoom` + `SyncSchema` (`@colyseus/schema` delta sync), `uWebSockets.js` transport | `layer-4-backend.md` §Tech stack, §Architecture | L | high |
| T4.2 | `Matchmaker` — room-code generation, QR payload format, join-by-code, queuing/filtering | `layer-4-backend.md` §Modules | M | med |
| T4.3 | Server-authoritative rules + input validation (anti-cheat); display becomes a predicting client | `layer-4-backend.md` §Modules, §Gotchas; `layer-3-display-engine.md` §Architecture (authority) | L | **high** |
| T4.4 | `AuthMiddleware` (validate session tokens on join) + `ApiGateway` (REST/tRPC for non-realtime) | `layer-4-backend.md` §Modules; `layer-5-data-persistence.md` §Auth | M | med |
| T4.5 | `PresenceService` — Redis presence, room lifecycle (empty-room timeout, reconnection window), horizontal scale | `layer-4-backend.md` §Scale & ops, §Gotchas | M | med |
| T4.6 | Schema-version guard — reject mismatched client/server versions loudly (`PROTOCOL_VERSION` already exists from T0.2) | `layer-4-backend.md` §Gotchas | S | low |

**T4.3 is high-cost because it is a rewrite of ownership**, not an addition: rules move off the display
onto the server, and Layer 3 becomes a predicting client. It is the only task in the plan that touches
two layers at once. Do not attempt it in the same session as T4.1.

T4.6 is trivial and prevents a failure the doc explicitly flags as **silent**. Do it alongside T4.1.

**Verify:** two phones + one screen join the same room code. Kill a phone's network for 5 s — it
reconnects into the same room with state intact. Send a hand-crafted illegal input frame; the server
rejects rather than applies it.

---

## Phase 5 — Layer 5: Data & persistence ⬜

| ID | Task | Context | Cx | Tok |
|---|---|---|---|---|
| T5.1 | Postgres schema + migrations — `users`, `profiles`, `matches`, `match_players`, `leaderboard_entries` | `layer-5-data-persistence.md` §Data model sketch | M | low |
| T5.2 | `UserRepository` / `AuthService` (Supabase Auth) + `ProfileService` | `layer-5-data-persistence.md` §Modules | M | med |
| T5.3 | `LeaderboardService` — Redis ZSET hot path, periodic flush to Postgres, global/room/seasonal boards | `layer-5-data-persistence.md` §Architecture, §Modules | M | med |
| T5.4 | `MatchHistory` + `ReplayStore` — records in Postgres, replay blobs in R2/S3 | `layer-5-data-persistence.md` §Modules | M | med |
| T5.5 | Checkpoint / match-end write path from Layer 4 — **async only, never blocking the game loop** | `layer-5-data-persistence.md` §Gotchas; `layer-4-backend.md` §Scale & ops | M | med |
| T5.6 | `Telemetry` (PostHog) + score-submission rate limiting validated against L4 results | `layer-5-data-persistence.md` §Modules, §Gotchas | S | low |

T5.1 is unusually cheap — the doc hands over the schema sketch nearly verbatim. **T5.5 is where the
real risk sits:** a synchronous durable write inside the tick is the classic way to blow the latency
budget after everything else was tuned correctly.

**Verify:** play a match end-to-end; the result lands in `matches` + `match_players`, the score hits the
Redis ZSET immediately and `leaderboard_entries` after a flush. Measure tick time during a match-end
write — it must not spike.

---

## Phase 6 — Layer 6: Infrastructure & delivery ⬜

Every task here needs an account, a credential, or a physical network.

| ID | Task | Context | Cx | Tok |
|---|---|---|---|---|
| T6.1 | `StaticDeployPipeline` — controller + display to Cloudflare Pages, edge-cached, cache-bust on deploy | `layer-6-infrastructure.md` §Tech stack, §Deployment checklist | S | low 👤 |
| T6.2 | Game-server container + regional deploy (Fly.io/Railway/Colyseus Cloud) + autoscale group | `layer-6-infrastructure.md` §Architecture | M | med 👤 |
| T6.3 | **`TurnStunCluster`** — coturn or managed, credential rotation | `layer-6-infrastructure.md` §Modules, §Gotchas | L | **high** 👤 |
| T6.4 | CI/CD (GitHub Actions) — build + deploy web, later native | `layer-6-infrastructure.md` §Modules | M | med |
| T6.5 | `Observability` — logs, metrics, **latency dashboard** ("the one you live by") | `layer-6-infrastructure.md` §Tech stack | M | med |
| T6.6 | `NativeWrappers` — Capacitor wrap of the controller PWA, signed store builds | `layer-6-infrastructure.md` §Modules | L | med 👤 |

**T6.3 is the project's classic silent failure.** Per §Gotchas, TURN must be tested **from a mobile
network behind carrier NAT**, not from office Wi-Fi. That test is a human with a phone on cellular data
— no amount of code review substitutes for it.

TLS is not a task: it is a precondition every origin must satisfy (sensors will not run without HTTPS),
enforced from Phase 1 onward via the dev tunnel and by managed certs in production.

**Verify:** walk `layer-6-infrastructure.md` §Deployment checklist as written — it is already the right
acceptance test. Latency dashboard live *before* launch, not after.

---

## Cost rollup

| Phase | Layer | Cx profile | Token weight | Human-in-loop |
|---|---|---|---|---|
| 0 | Foundation | S–M | **low** ✅ | no |
| 1 | Controller | S–L | **high** | yes — T1.2, T1.3 |
| 2 | Transport (WS) | S–M | med | no |
| 2b | Transport (WebRTC, T2.5) | XL | **v.high** | yes — cellular test |
| 3 | Display + engine | S–L | **high** | yes — game feel (3c) |
| 4 | Backend | M–L | **high** | no |
| 5 | Data | S–M | med | no |
| 6 | Infra | S–L | med | yes — all |

**Where the budget actually goes.** Four items dominate: T1.2/T1.3 (sensor + gesture tuning), T2.5
(WebRTC), Phase 3c (game feel), T4.3 (authority migration). Everything else is comparatively cheap. Three
of the four are expensive because a *human* must judge the result, not because the code is long — so
the way to control cost is to **batch the cheap mechanical tasks together and isolate the expensive
ones into their own sessions**, with the phone or the account already at hand.

### Token discipline rules

1. **One phase per session.** Cross-phase context is the main source of waste.
2. **`packages/protocol` is the only cross-layer context.** If a task needs to know what another layer
   sends, it reads the protocol package — never the other layer's source.
3. **Load only the doc sections named in the Context column.** The docs are short, but seven files of
   architecture prose crowds out the code being edited.
4. **Never re-derive tuning constants.** They live in `packages/protocol/src/constants.ts`; tuning
   sessions edit one file.
5. **Front-load the mechanical work in a phase**, so the expensive human-in-loop task starts with a
   clean, mostly-empty context window.

---

## Sequencing

```
T0.1 → T0.2 ─┬─▶ Phase 1 (L1 controller) ─┐
  ✅ done     └─▶ T2.1 relay ──────────────┴─▶ T3.4 dot moves  ◀── ✅ vertical slice proven
                                               │
                                               ▼
                                    T3.6 GameModule seam + menu
                                               │
                        ┌──────────────────────┼──────────────────────┐
                        ▼                      ▼                      ▼
                  T3.7 Flappy ✅          T1.7 quaternions ✅    T1.8 directional
              (no orientation —          (verified on hardware   gestures ✅ code
               built first)               — grip now resolved)    ⏳ tuning
                        │                      │                     │
                        │                      ▼                     ▼
                        │        T3.8 Fruit slash ✅         T3.9 Endless runner
                        │        T3.11 Star fighter ✅        ◀── next, unblocked
                        │                      │                     │
                        └──────────────────────┴──────────┬──────────┘
                                                          ▼
                                              T3.10 Tennis (deferred)
                                                          │
                                                          ▼
                                            Phase 4 (rooms, authority)
                                                          │
                                    ┌─────────────────────┴──────────┐
                                    ▼                                ▼
                             Phase 5 (data)              T6.1–T6.3 (deploy + TURN)
                                                                     │
                                                                     ▼
                                                          T2.5 WebRTC ──▶ T6.4–T6.6
```

Two things this shape encodes. **T3.7 hangs off the seam directly**, not off T1.7 — Flappy needs no
orientation at all, so it can be built and played while the quaternion work is still open, and it is
the cheapest way to prove the chain carries a real game. And **T1.7 gates both pointing games**,
which is the whole argument for doing it before them rather than after: build fruit slash on Euler
angles and you build it twice.

Still matches `00-overview.md` §Suggested build order in spirit, with three deliberate changes: the
engine is TypeScript rather than Godot, WebRTC moves to the very end where TURN exists to support it,
and tennis is displaced by three games that were asked for — it stays as T3.10 rather than being
dropped.

---

## What to do next

Ranked, and the ordering rule is the one this file has used throughout: **split on "needs a human"
vs "does not".**

1. **Record the gesture traces** (§Outstanding item 2). Ten minutes with the phone, and it is the
   prerequisite that turns T1.8's tuning — four outcomes, three constants — from re-swinging a phone
   per candidate value into an offline test run. Everything else in Layer 1 is cheaper afterwards.
2. **Batch the rest of the on-device list in the same session**, because the setup is the expensive
   part: T1.8's two constants, `SWING_THRESHOLD`, `CUT_SPEED`, the three fusion constants, and
   **Android** — never tried, and the only device class where the noisier `derived` gravity path
   actually runs.
3. **T3.9 endless runner.** Unblocked now. Lane changes are `swing:left`/`swing:right`, jump and duck
   are `swing:up`/`swing:down`, and a diagonal correctly does nothing. It is also the only game with
   **no cues written yet** — worth adding as it is built rather than after, since T3.12 made that a
   one-line-per-event job.
4. **Phase 4.** The real next phase, fully unattended, and large enough to want its own session —
   T4.3 moves rule ownership off the display, which is the only task here that touches two layers.

**Reconcile the `TODO(on-device)` markers while you are in there.** Several now contradict this
file: `permission-gate.ts` still says "THE ENTIRE iOS BRANCH IS UNTESTED" and
`input-serializer.ts` calls the send rate unconfirmed, both of which §Outstanding records as
confirmed on an iPhone. A stale marker is worse than none — it spends a device session re-proving
something already known.

## Overall verification

The milestone that matters is **T3.4**: a phone tilt moves a dot on a separate screen, over HTTPS,
end-to-end. It exercises Layers 1, 2, 3 and the shared protocol at once. Reach it before building
anything in Layers 4–6.

Standing checks at every phase:

- **Latency** — instrument `recvTs` (T2.3) and keep phone-capture → render under **50–80 ms**. Check
  after every phase; regressions compound quietly.
- **Real devices, early** — both iOS and Android before thresholds are locked
  (`layer-1-controller.md` §Gotchas). Desktop DevTools Sensors emulation validates plumbing only.
- **HTTPS everywhere** — sensors will not run otherwise; localhost is the only exemption.
- **Unit tests** — protocol codec round-trip (done), and the gesture recognizer against **recorded
  accel traces**. Record once on a real phone, replay forever: this is what turns T1.3 from repeatedly
  expensive into cheap, and it is the single highest-value thing to build during the T1.3 session.

## Open items to settle when reached

- **Bowling** — the doc's other suggestion. It reuses the swing/flick gesture, so it is cheap once
  T3.10 tennis exists; unclear whether it earns a slot alongside the four already planned.
- **Replays (T5.4)** — whether they ship in v1 at all; the most deferrable item in Layer 5.
- **TURN: managed vs self-hosted** — managed (Twilio/Cloudflare) costs money but removes the project's
  single most common failure mode. Decide at T6.3 with real traffic estimates.
