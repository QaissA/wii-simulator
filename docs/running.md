# Running and testing

Four things run: a **relay**, a **controller** (the phone), a **display** (the screen), and — when no
phone is at hand — a **synthetic controller**. They are independent processes; nothing auto-starts
anything else.

| Layer | What | Port | Command |
|---|---|---|---|
| 2 | Relay (WebSocket) | `8081` | `pnpm dev:relay` |
| 1 | Controller (phone PWA) | `8080` | `pnpm dev:controller` |
| 3 | Display (screen) | `8082` | `pnpm dev:display` |

First time only:

```bash
pnpm install
pnpm build          # the apps import built output from packages/*
```

---

## 1. No phone: verify everything automatically

The fastest way to know the stack works. Start the three servers in three terminals, then:

```bash
pnpm check           # 21 checks — the display against a synthetic controller
pnpm check:e2e       # 18 checks — the REAL controller, end to end
pnpm check:fruit     # 11 checks — a pointer stroke actually slices a fruit
pnpm check:shooter   # 12 checks — the guns hit something
```

They all drive headless Chrome and print `PASS`/`FAIL` per check, leaving screenshots next to
`tools/display-check/`. `check:e2e` is the one that proves the vertical slice: it reads the controller
URL off the display's own pairing screen, taps the permission gate, drives the controller with
synthetic motion events, and asserts the link, the scene transitions, frame age, send rate, cursor
sweep, a swing, and the drop back to pairing.

`check:fruit` is the only one that exercises a **pointing game**. Fruit slash has no gesture binding
at all — it cuts when the pointer crosses a fruit above its own speed threshold — so none of that path
is touched by the swing the other two checks fire. It runs the synthetic controller with
`--slash-every`, which sweeps orientation fast enough to cut; the idle sweep deliberately cannot,
because a slow re-aim must not slice.

`pnpm check` also covers the audio path, by asserting on the mixer's own counters — a screenshot
cannot show that a sound happened. It runs headless Chrome with
`--autoplay-policy=no-user-gesture-required` so the real code path runs rather than the blocked one,
and `--mute-audio` because there is no speaker to play into.

**What they do not cover:** the sensors, and how any of it actually *sounds*. Motion events are
synthesised, so nothing below the event listener is exercised, and the audio graph runs into silence.
Both still need a human — see §3 and §Sound.

---

## 2. No phone, by hand: watch it move

Same three servers, then drive the display with the synthetic controller and watch in a browser.

```bash
pnpm dev:relay
pnpm dev:controller     # not needed for this path, but harmless
pnpm dev:display
```

Open **http://localhost:8082/?room=T4ST**. Pinning `?room=` is worth doing — without it the display
mints a fresh code on every reload, and a reload is constant while developing.

`T4ST` is deliberately not `W9XD` or `K7RM`: those are the rooms the two automated checks use, and a
fake controller left running in one of them will make the next `pnpm check` fail for reasons that have
nothing to do with the code.

Then, in a fourth terminal:

```bash
pnpm fake-controller --room T4ST
```

The display should go **pairing → lobby → play** and a blue dot should trace a slow figure across the
grid. Add `--swing-every 0` to stop it pressing buttons, which parks it in the lobby.

To watch **fruit slash** instead, add `--slash-every 0.4`: the idle sweep is deliberately too slow to
cut, so without it the blade never slices and the round quietly runs out of lives.

```bash
pnpm fake-controller --room T4ST --swing-every 0 --slash-every 0.4
```

> On Windows the synthetic controller reads ~32 Hz rather than 50. That is the OS timer granularity
> (~15.6 ms) in the tool, not the app — a real controller drives its send loop from
> `requestAnimationFrame` and has no such floor.

---

## 3. With a phone: the real thing

Sensors require a **secure context**, and a LAN address is not one. There are two ways past that, and
which one is right depends on your network.

| | Latency | Setup | Use when |
|---|---|---|---|
| **LAN over HTTPS** | real (one hop) | cert once | almost always |
| Tunnel | meaningless | none | you cannot get both devices on one network |

**Prefer the LAN.** A tunnel routes every frame through the public internet, and if the laptop is
tethered to the phone's hotspot the phone ends up talking to itself via a cell tower. `age` then reads
hundreds of milliseconds and tells you nothing about the 50–80 ms budget the project exists to hit.

### 3a. LAN over HTTPS — recommended

Get both devices on one network (a hotspot from the phone is fine), then:

```bash
pnpm cert          # generate a local CA + certificate for this machine's IPs
pnpm cert:serve    # tiny HTTP server on :8083 that hands the CA to the phone
```

On the **phone**, open `http://<laptop-ip>:8083` — the page tells you the address — and install the
certificate. On iOS that is two steps, and the second is the one everybody misses:

1. Settings → **Profile Downloaded** → Install.
2. Settings → General → About → **Certificate Trust Settings** → switch on *Wii Simulator Dev CA*.

Without step 2 the profile is installed but not trusted, and every connection still fails.

Then start the three servers. They detect the certificate and come up on HTTPS automatically:

```bash
pnpm dev:relay          # wss://…:8081
pnpm dev:controller     # https://…:8080
pnpm dev:display        # https://…:8082
```

Open the display **on its LAN address**, not localhost:

```
https://<laptop-ip>:8082
```

No query parameters. The display derives the controller and relay URLs from its own origin, so opening
it on the LAN address makes the QR point at the LAN address too. Opening it on `localhost` would
encode a QR telling the phone to connect to *itself*.

Scan, tap power, **Allow** the motion prompt, and tilt.

> **Windows firewall.** Inbound Node connections are blocked by default on a "Public" network, which
> is what a hotspot is. If the phone cannot reach the laptop at all, allow the four dev ports from an
> elevated PowerShell:
>
> ```powershell
> New-NetFirewallRule -DisplayName 'wii-simulator dev' -Direction Inbound -Action Allow `
>   -Protocol TCP -LocalPort 8080,8081,8082,8083 -Profile Any
> ```
>
> Also check for *Block* rules on `node.exe` — clicking Cancel on a firewall prompt creates one, and a
> Block rule beats any Allow rule you add later.

> **The hotspot IP changes.** The certificate names specific IPs, so after a reconnect re-run
> `pnpm cert` and restart the servers. The CA is reused, so the phone keeps its trust — no re-install.

### 3b. Tunnel — only when one network is impossible

```bash
npx localtunnel --port 8080     # → https://xxxx.loca.lt   controller
npx localtunnel --port 8081     # → https://yyyy.loca.lt   relay
```

Keep both running; if either exits, the phone gets **503 Tunnel Unavailable** and the display sits on
"connecting to relay". Then open the display with both overrides:

```
https://localhost:8082/?controller=https://xxxx.loca.lt&relay=wss://yyyy.loca.lt
```

Note `wss://` for the relay, not `https://`. The display copies `?relay=` into the QR — without that
the phone would derive the relay from its own hostname, which behind a tunnel is the *controller's*
host, not the relay's. It would load fine and never connect.

### What to look at

The display's HUD, top right:

| Row | Healthy | Meaning |
|---|---|---|
| `link` | `online` | the socket to the relay |
| `age` | green, ≤ 50 ms | phone capture → this frame. **The number that matters.** Amber past 50, red past 80. |
| `hz` | ~50 | frames arriving. A dip means the phone's capture loop stalled. |
| `aim.x` / `aim.y` | moving | tilt reaching the cursor |
| `action` | `swing (triggered)` | the gesture path |

Tap **Debug** on the phone for the controller-side readout: live `|accel|` against `SWING_THRESHOLD`,
a running peak, the measured send rate, and whether the platform gave gravity-free acceleration
(`linear`) or it had to be estimated (`derived`).

---

## The cursor moves the wrong way

Which way a tilt *should* move the cursor is not a fact about the code — it depends on how the phone
is held, and the two natural grips are opposite on **both** axes:

| Grip | Tilt right | Nose up |
|---|---|---|
| Flat, pointing away (a Wii remote) — the default | cursor right | cursor up |
| Upright, screen facing you (a phone) | cursor **left** | cursor **down** |

Near-vertical makes it worse rather than being a simple sign change: `beta` approaches 90°, where the
Euler representation is degenerate, and `gamma`'s sign meaning flips as the device passes vertical.
Calibration cannot rescue that, because subtracting Euler angles is not composing rotations — it is
only valid near the pose you calibrated in.

### Why the vertical axis behaved differently from the horizontal one

Fixed in `SensorFusion`, and worth recording because the symptom did not look like its cause.

The old complementary filter predicted forward with `state + rotationRate * dt` — integrating angular
velocity **into Euler angles**, as if `rotationRate.beta` were `beta`'s derivative. It is not. Euler
rates and body angular velocity are related by a transform that depends on the current attitude and
degenerates as `beta` approaches ±90° — exactly where a phone sits when held upright.

So in that grip the gyro term stopped predicting `beta` and started fighting it, while `gamma` (near 0)
stayed fine. That is why one axis was reversed *and* sluggish and the other was neither: the estimate
could only converge through the filter's slow pull toward the absolute reading, a ~0.8 s time constant.

Measured, feeding a constant orientation with a constant rotation rate:

| | `beta` 45° / `gamma` 20° in | fused out |
|---|---|---|
| before | rate 22 / 33 deg/s | `b 59.9  g 44.7` — 15–25° adrift |
| after | rate 22 / 33 deg/s | `b 45.0  g 20.0` — exact |

The deeper mistake was fusing twice. `deviceorientation` is *already* the platform's accelerometer +
gyroscope + magnetometer fusion, so integrating the gyro on top added a second, wrong fusion rather
than new information. `SensorFusion` is now an exponential smoother over the platform estimate,
carrying no attitude assumptions — it behaves the same upright as flat. Since T1.7 it slerps
quaternions rather than interpolating three angles separately, so it follows the shortest arc between
two orientations instead of taking the long way round wherever the Euler view jumps. Prediction still
happens, in Layer 3's `PredictiveAxis`, where it can be tuned against what the player sees.

### Calibrate first — an uncalibrated axis can be completely dead

Before judging direction, **hold the phone the way you intend to hold it and press Calibrate on the
phone.** This is not a nicety, and T1.7 did not remove the need for it. `applyBinding` clamps to ±1,
so a pose outside the binding's range produces a constant ±1 that never moves. Calibration is what
makes the current pose the centre of that range: held upright and uncalibrated, the phone is already
pointing ~90° away from the frame's forward direction against a 40° range, so the vertical axis is
pinned before the player has tilted anything:

| | `aim.y` across a 40° sweep |
|---|---|
| Uncalibrated, upright | `-1.00` at every angle — dead |
| After Calibrate | tracks linearly through zero |

It reads as "up and down doesn't work" rather than as "calibrate first", which is why the display now
says so: a pinned axis turns its HUD row red and the status line reads *"an axis is pinned — hold the
phone how you want it and press Calibrate"*.

### Grip no longer needs a knob (T1.7)

The axes used to be driven by named Euler angles, and named angles mean different things in different
grips. Held upright a phone sits at `beta` ≈ 90°, where the Euler representation couples `alpha` and
`gamma`: leaning left and right registered in `alpha` while a `gamma`-driven axis read a flat zero.

| horizontal source | alpha | gamma | `aim.x` |
|---|---|---|---|
| `gamma` | 25.0 | 0.0 | **0.00 — dead** |
| `alpha` | 25.0 | 0.0 | −0.61 |

A third key (<kbd>S</kbd>) existed to swap which angle drove left/right. It is **gone**, along with the
defect it was patching. `aim.x`/`aim.y` now read `point.x`/`point.y`: the calibrated quaternion
rotates a forward vector and the axes are read off where it lands. Right is positive and up is
positive at any grip, so neither axis carries an inversion by default, and rolling the wrist does not
drag the cursor sideways.

Two keys remain, and they are a preference rather than a repair:

| Key | Effect |
|---|---|
| <kbd>X</kbd> | flip the horizontal axis |
| <kbd>Y</kbd> | flip the vertical axis |
| <kbd>R</kbd> | back to defaults |

(<kbd>M</kbd> mutes, and is unrelated to grip — see §Sound.)

The HUD still shows `alpha`, `beta` and `gamma`. Nothing reads them for input any more, but they are
the quickest way to confirm orientation is arriving at all — and to recognise the near-vertical pose
where the Euler view goes degenerate while the cursor carries on working, which is the change made
visible.

A grip other than the default is now a **mapping literal**, not a keypress: a phone held flat and
aimed away like a Wii remote points along its own `+y`, so that binding gets
`forward: [0, 1, 0]` in `apps/display/src/input/mappings.ts`. Nothing else changes.

---

## Sound

Four games, and they make noise as of T3.12.

**Expect the display to be silent at first, and that is not a bug.** A browser will not let a page
make a sound until it has seen a user gesture *on that page*, and this screen is the one thing nobody
touches: the player scans a QR and every input after that arrives from the phone over a socket, which
grants no activation whatever. So the pairing screen says **"click this screen once to enable sound"**
until you do. One click anywhere, and it is unlocked for the session.

| Key | Effect |
|---|---|
| <kbd>M</kbd> | mute / unmute. Persists across reloads, so a display muted last night stays muted |

The pairing screen also says so when muted — otherwise a preference set days ago reads as broken audio.

**Every sound is synthesised.** There are no audio files in the repo, and no asset pipeline to serve
them: a cue is an oscillator or a filtered noise burst described as data. That is why the whole audio
layer costs a few kilobytes and has no loading state.

Tuning the sound is editing **one file**, `apps/display/src/audio/cues.ts` — gains, durations,
frequencies and the throttle for each cue. The rules *about* sound are somewhere else and are tested:
`AudioDirector` in `packages/engine` owns the polyphony cap, per-cue throttling and priority
eviction, so "four slices in one stroke sound like one" is a `minIntervalMs` change in the cue table,
never a change to a game.

| Symptom | Turn this |
|---|---|
| A star fighter round is exhausting by wave two | `shoot`'s `gain` — it fires ~4×/second and is deliberately the quietest cue |
| A bomb clicks or pumps instead of booming | `maxVoices` in `AudioManager`, or the limiter threshold beside it |
| A flurry of slices sounds like one smeared slice | `slice`'s `minIntervalMs` |
| The menu machine-guns while tilting | `ui.move`'s `minIntervalMs` |

---

## Tuning

Every threshold lives in **`packages/protocol/src/constants.ts`** and nowhere else. Tuning is editing
one file:

| Constant | Change it when |
|---|---|
| `SWING_THRESHOLD` | swings do not register, or gentle waves do |
| `GESTURE_COOLDOWN` | one swing fires twice |
| `FUSION_HALF_LIFE_MS` | the cursor jitters while held still (raise it), or feels sluggish (lower it) |

Prediction feel is separate — `maxExtrapolationMs` and the smoothing half-lives in
`packages/engine/src/prediction.ts`. Too much prediction overshoots on a direction change; too little
feels laggy. Press **B** on the phone to reset the filters mid-motion, which separates "prediction is
overshooting" from "the filter is still carrying state from the last violent motion".

---

## When something does not work

| Symptom | Cause |
|---|---|
| `503 Tunnel Unavailable` | The tunnel process died. Tunnels do not survive a closed terminal — restart it, or switch to 3a. |
| Certificate installed but still refused | On iOS, Settings → General → About → Certificate Trust Settings, and switch the CA on. Installing the profile is not enough. |
| Worked yesterday, fails today | The hotspot handed out a new IP. Re-run `pnpm cert` and restart the servers. |
| Phone loads, never connects | The `?relay=` override did not reach it. Check the URL under the QR actually contains `relay=wss://…`. A mixed-content block looks identical to the relay being down — check the phone's console. |
| "Needs HTTPS" on the phone | The origin is not secure. Either finish the certificate setup (3a) or use a tunnel (3b). |
| Tapping power does nothing on iOS | Motion permission was denied. Fully close the tab and reopen — iOS will not re-prompt otherwise. |
| Display stuck on "waiting for a controller" | The phone is in a different room code, or is connected to a different relay. Both must match. |
| `age` red, `hz` fine | Real latency — the tunnel is routing through a distant region. Try the same Wi-Fi, or accept it as a tunnel artifact rather than an app one. |
| `hz` reads 0 or ~30 | The capture loop is throttled. A backgrounded tab suspends `requestAnimationFrame` entirely; a 30 Hz power-saving refresh rate caps capture below `SEND_HZ`. |
| A check fails right after manual testing | A fake controller is still running in the check's room. `pnpm check` uses `W9XD`, `pnpm check:e2e` uses `K7RM` — stop any stray one before running them. |
| `Port 8081 is already in use` | An earlier relay is still running. Stop it, or use `PORT=8090 pnpm dev:relay` — and pass the same port to the display via `?relay=`. |
| No sound at all | The browser has not seen a gesture on the *display* page, and playing from the phone never gives it one. Click the display once — the pairing screen says so. Or it is muted: press <kbd>M</kbd>. |
| `check:e2e` fails at "controller origin is secure enough", then "click target not found" | Observed only when a check is started while the previous one's headless Chrome is still exiting — the controller tab comes up without a secure context and the gate never renders. Leave a moment between checks and re-run. Both symptoms are the same one failure, and neither has reproduced when `check:e2e` is run on its own. |

---

## Everything else

```bash
pnpm test           # 153 unit tests across protocol, transport, engine, server
pnpm typecheck
pnpm build
```

The unit tests need no browser and no network. The two browser checks in §1 need the three servers
running.
