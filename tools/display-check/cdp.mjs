/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Shared by the two browser checks in this directory. Deliberately dependency-
 * free apart from `ws`: a browser-automation library would be a large tree to
 * carry for what amounts to "open a tab, evaluate some JavaScript, take a
 * screenshot".
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CHROME_CANDIDATES = [
  process.env['CHROME_PATH'],
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

/**
 * The scheme the dev servers are currently on.
 *
 * They switch to HTTPS the moment a dev certificate exists (see
 * `tools/dev-cert`), so the checks have to follow rather than hard-code a
 * scheme — otherwise they fail against a perfectly healthy stack the moment
 * someone sets up device testing.
 */
export function devScheme() {
  const cert = fileURLToPath(new URL('../dev-cert/certs/dev.crt', import.meta.url));
  return existsSync(cert) ? { http: 'https', ws: 'wss', secure: true } : { http: 'http', ws: 'ws', secure: false };
}

export function findChrome() {
  const path = CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!path) {
    console.error('no Chrome found. Set CHROME_PATH. Looked in:');
    for (const c of CHROME_CANDIDATES) console.error(`  ${c}`);
    process.exit(1);
  }
  return path;
}

export function launchChrome({ port, profileDir }) {
  return spawn(
    findChrome(),
    [
      '--headless=new',
      '--disable-gpu',
      // SwiftShader: a headless box has no GPU, and a display that cannot get a
      // WebGL context is a failure worth reporting rather than working around.
      '--enable-unsafe-swiftshader',
      // Both pages run real-time loops, and only one tab can be foreground at a
      // time. Without these, Chrome throttles the background tab's timers and
      // suspends its requestAnimationFrame — which would look exactly like the
      // controller's send loop being broken. This is the same effect that made
      // `send hz` read 0 during the Phase 1 desktop check.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      // Audio. A headless browser is never clicked, and `AudioManager` explains
      // at length why nothing else on this display grants user activation — so
      // without this flag the AudioContext stays suspended, every cue is dropped
      // before it reaches the mixer, and a check asserting on the audio path
      // would be asserting on the blocked branch rather than the real one.
      // `--mute-audio` because there is no sound device to play into and we only
      // care that the graph ran; the two together are "run the audio code, make
      // no noise".
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--window-size=1440,900',
      // The dev certificate is signed by a local CA that this throwaway profile
      // has no reason to trust. Scoped to a headless profile pointed at
      // localhost, ignoring that is the pragmatic call; the certificate itself
      // is verified properly by the device that matters, which is the phone.
      ...(devScheme().secure ? ['--ignore-certificate-errors'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
}

export class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  logs = [];
  label;

  constructor(label = 'page') {
    this.label = label;
  }

  /** Attach to the first existing page target. */
  static async attach(port, label) {
    const targets = await pollTargets(port);
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target — is Chrome up with --remote-debugging-port?');
    return Cdp.#open(page.webSocketDebuggerUrl, label);
  }

  /** Open a NEW tab and attach to it. Used to run two pages side by side. */
  static async openTab(port, url, label) {
    const version = await (await fetch(`http://localhost:${port}/json/version`)).json();
    const browser = new Cdp('browser');
    await browser.#connect(version.webSocketDebuggerUrl, { enableDomains: false });
    // `newWindow` matters. Two tabs in one window means one of them is always
    // the background tab, and Chrome throttles a background tab's
    // requestAnimationFrame to about 1 fps — the display would appear frozen
    // while the controller drove it. Separate windows model the real deployment,
    // where the screen and the phone are two devices that are both in front of
    // somebody.
    const { targetId } = await browser.send('Target.createTarget', { url, newWindow: true });
    browser.close();
    return Cdp.#open(`ws://localhost:${port}/devtools/page/${targetId}`, label);
  }

  /**
   * Shut the browser down the way closing the window would.
   *
   * `chrome.kill()` on its own terminates the process and leaves the profile
   * flagged as having crashed. The next launch then spends its startup
   * recovering that profile and restoring the previous run's windows, and the
   * tab this harness opens can sit at `readyState === 'loading'` indefinitely —
   * which reads as a hung dev server and is really the *previous* run's exit.
   *
   * The symptom is the tell: it alternates. A clean run leaves a clean profile,
   * a killed run leaves a dirty one, and the failure lands on every other pass.
   */
  static async shutdown(port) {
    const version = await (await fetch(`http://localhost:${port}/json/version`)).json();
    const browser = new Cdp('browser');
    await browser.#connect(version.webSocketDebuggerUrl, { enableDomains: false });
    // The browser tears this socket down as it exits, so a late error on a
    // socket whose peer has gone is the expected outcome, not a fault.
    browser.#ws.on('error', () => {});
    await browser.send('Browser.close').catch(() => {});

    // Let the socket finish closing on its own. Closing it here as well, or
    // reaching `process.exit` while it is still mid-close, trips a libuv
    // assertion on Windows and aborts the run *after* every check has passed —
    // a green report with a non-zero exit code, which is the worst of both.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  static async #open(wsUrl, label) {
    const cdp = new Cdp(label);
    await cdp.#connect(wsUrl, { enableDomains: true });
    // Make the page believe it is focused. Chrome suspends rendering work in
    // pages it considers hidden, and with two tabs open one of them always is.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    return cdp;
  }

  async #connect(url, { enableDomains }) {
    const { WebSocket } = await import('ws');
    this.#ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    this.#ws.on('message', (raw) => this.#onMessage(JSON.parse(raw.toString())));
    await new Promise((ok, no) => {
      this.#ws.once('open', ok);
      this.#ws.once('error', no);
    });
    if (!enableDomains) return;
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Page.enable');
  }

  #onMessage(msg) {
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve: ok, reject: no } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      return msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
    }
    const p = msg.params;
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails;
      this.logs.push(`[${this.label}] EXCEPTION ${d.exception?.description ?? d.text}`);
    } else if (msg.method === 'Log.entryAdded' && p.entry.level === 'error') {
      this.logs.push(`[${this.label}] ERROR ${p.entry.text}`);
    }
  }

  send(method, params = {}) {
    return new Promise((ok, no) => {
      const id = ++this.#id;
      this.#pending.set(id, { resolve: ok, reject: no });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const out = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    }
    return out.result.value;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
  }

  async setViewport(width = 1440, height = 900) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /**
   * Click an element through Chrome's real input pipeline.
   *
   * NOT `element.click()`. A scripted click carries no **user activation**, and
   * the controller is built entirely around that distinction — the permission
   * gate exists to satisfy iOS's requirement that `requestPermission()` run
   * inside a genuine tap, and the Vibration API refuses to fire without one. A
   * scripted click leaves the gate closed and looks exactly like the user
   * declining, which is the failure `permission-gate.ts` warns about.
   */
  async click(selector, { holdMs = 0 } = {}) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`);
    if (!box) throw new Error(`click target not found: ${selector}`);
    const { x, y } = JSON.parse(box);

    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
    });
    if (holdMs > 0) await sleep(holdMs);
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0,
    });
  }

  /**
   * Press a key on the display.
   *
   * The display's keyboard is a real input surface — the lobby binds arrows and
   * Enter to game selection — so driving it is testing shipping behaviour, not
   * reaching around the app. Windows virtual key codes are included because
   * Chrome ignores arrow keys dispatched without one.
   */
  async key(name) {
    const KEYS = {
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      Enter: 13,
    };
    const code = KEYS[name];
    if (!code) throw new Error(`unmapped key: ${name}`);

    for (const type of ['rawKeyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key: name,
        code: name,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
      });
    }
  }

  async screenshot(path) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path, Buffer.from(shot.data, 'base64'));
  }

  close() {
    try {
      this.#ws?.close();
    } catch {
      /* already gone */
    }
  }
}

async function pollTargets(port) {
  for (let i = 0; i < 40; i++) {
    try {
      return await (await fetch(`http://localhost:${port}/json`)).json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Chrome never opened the debugging port ${port}`);
}

/* -------------------------------- assertions ------------------------------ */

export function createReporter() {
  const failures = [];

  const check = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures.push(label);
  };

  /**
   * Poll until `predicate` holds.
   *
   * Scene changes are driven by network events and by timeouts, so a fixed sleep
   * either flakes or wastes seconds. This does neither, and on timeout it reports
   * the last state it saw rather than a bare "false".
   */
  const waitFor = async (read, label, predicate, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await read();
      if (predicate(last)) return last;
      await sleep(200);
    }
    check(label, false, `timed out after ${timeoutMs} ms; last state ${JSON.stringify(last)}`);
    return last ?? {};
  };

  const finish = () => {
    console.log(
      failures.length
        ? `\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`
        : '\nall checks passed',
    );
    return failures.length;
  };

  return { check, waitFor, finish, failures };
}

/** Reads the display's observable state straight from its DOM. */
export const READ_DISPLAY_STATE = `(() => {
  const rows = [...document.querySelectorAll('.hud-row')];
  const hud = Object.fromEntries(rows.map((r) => [
    r.firstElementChild.textContent,
    r.lastElementChild.textContent,
  ]));
  const canvas = document.getElementById('stage');
  return {
    status: document.querySelector('.overlay-status')?.textContent ?? '',
    centre: document.querySelector('.overlay-center')?.textContent ?? '',
    roomCode: document.querySelector('.room-code')?.textContent ?? null,
    games: [...document.querySelectorAll('.game-row')].map((r) => ({
      title: r.querySelector('.game-title')?.textContent ?? '',
      selected: r.dataset.selected === 'true',
    })),
    score: document.querySelector('.score')?.textContent ?? null,
    controllerUrl: document.querySelector('.panel-url')?.textContent ?? null,
    hasQr: !!document.querySelector('canvas.qr'),
    hudKeys: Object.keys(hud),
    hud,
    canvasReady: !!canvas && canvas.width > 0,
    // From the debug hook in the display's main.ts. A screenshot cannot show
    // that a sound happened, so the mixer's own counters are the only evidence
    // available to an automated check.
    audio: window.__audio
      ? { ...window.__audio.stats(), muted: window.__audio.muted(), blocked: window.__audio.blocked() }
      : null,
    audioHint: document.querySelector('.audio-hint')?.textContent ?? null,
  };
})()`;
