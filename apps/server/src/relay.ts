/**
 * RelayServer — the WebSocket relay (T2.1).
 *
 * `docs/layer-2-transport.md` §Architecture: "Remote / restrictive networks:
 * relay frames through the backend over WebSocket."
 *
 * Responsibilities, and nothing beyond them:
 *   - place clients in rooms by code,
 *   - fan frames out to the rest of the room,
 *   - answer `ping` so clients can estimate latency,
 *   - notice dead sockets and reap them.
 *
 * It is deliberately not authoritative. Layer 4 replaces it (T4.1); logic added
 * here would only have to be removed then.
 */

import { createServer as createHttpsServer } from 'node:https';
import type { Server as HttpsServer } from 'node:https';

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { ClockSync, encode, isValidRoomCode, tryDecode } from '@wii/protocol';
import type { Message } from '@wii/protocol';

import { Room } from './room.js';
import type { Peer } from './room.js';

export interface RelayOptions {
  port?: number;
  host?: string;
  /** Sockets silent for this long are terminated, ms. */
  idleTimeoutMs?: number;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  /**
   * PEM key and certificate. Supplying these serves `wss://` instead of `ws://`.
   *
   * Needed whenever the pages are served over HTTPS, which on-device testing
   * requires: a secure page may not open an insecure socket, so a plain `ws://`
   * relay is blocked as mixed content. That block presents to the user as the
   * relay being unreachable, which is why it is worth having a first-class
   * option rather than a separate proxy.
   */
  tls?: { key: string | Buffer; cert: string | Buffer };
}

interface Client {
  peer: Peer;
  socket: WebSocket;
  room: Room | null;
  lastSeen: number;
}

const DEFAULT_PORT = 8081;
/**
 * Generous relative to the client's 6 s heartbeat timeout. The client should
 * always be the one to notice a dead link first and reconnect; the server side
 * is a backstop against sockets that leak, not a second opinion on liveness.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export class RelayServer {
  readonly #wss: WebSocketServer;
  /** Present only on the TLS path; `ws` makes its own plain server otherwise. */
  readonly #https: HttpsServer | null = null;
  readonly #rooms = new Map<string, Room>();
  readonly #clients = new Map<string, Client>();
  readonly #clock = new ClockSync();
  readonly #log: NonNullable<RelayOptions['log']>;
  readonly #idleTimeoutMs: number;
  #reaper: ReturnType<typeof setInterval> | null = null;
  #nextId = 1;

  constructor(options: RelayOptions = {}) {
    this.#idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.#log = options.log ?? (() => {});
    const port = options.port ?? DEFAULT_PORT;
    const host = options.host ?? '0.0.0.0';

    if (options.tls) {
      // Answer non-upgrade requests the same way `ws`'s own server does, so
      // `curl` against the relay reports 426 rather than hanging on a socket
      // that nobody will ever speak HTTP on.
      this.#https = createHttpsServer({ key: options.tls.key, cert: options.tls.cert }, (_req, res) => {
        res.writeHead(426, { 'Content-Type': 'text/plain' });
        res.end('Upgrade Required');
      });
      this.#wss = new WebSocketServer({ server: this.#https });
      this.#https.listen(port, host);
    } else {
      this.#wss = new WebSocketServer({ port, host });
    }
    this.#wss.on('connection', (socket, req) => this.#onConnection(socket, req.url ?? ''));
    this.#reaper = setInterval(() => this.#reap(), Math.max(1000, this.#idleTimeoutMs / 3));
    // Do not hold the process open just to run the reaper.
    this.#reaper.unref?.();
  }

  /** Actual bound port — 0 in the options means "any free port", used by tests. */
  get port(): number {
    const addr = this.#wss.address();
    return typeof addr === 'object' && addr !== null ? addr.port : -1;
  }

  get roomCount(): number {
    return this.#rooms.size;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  roomFor(code: string): Room | undefined {
    return this.#rooms.get(code);
  }

  /**
   * Resolve once the socket is bound — or reject if it cannot be.
   *
   * Listening for `error` is not optional here. Without a listener attached, a
   * failed bind (a port already in use is the everyday case) is an *unhandled*
   * error event, which Node turns into a raw stack trace and an immediate exit —
   * while this promise, waiting only for `listening`, never settles at all. The
   * caller cannot report anything useful about a failure it was never told about.
   */
  async listening(): Promise<void> {
    if (this.#wss.address() !== null) return;

    // On the TLS path the HTTPS server is the thing that binds; `ws` is merely
    // attached to it and never emits `listening` of its own. Waiting on the
    // wrong emitter here hangs forever instead of resolving.
    const source = this.#https ?? this.#wss;

    await new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        source.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        source.off('listening', onListening);
        reject(err);
      };
      source.once('listening', onListening);
      source.once('error', onError);
    });
  }

  async close(): Promise<void> {
    if (this.#reaper) clearInterval(this.#reaper);
    this.#reaper = null;
    for (const { socket } of this.#clients.values()) socket.terminate();
    this.#clients.clear();
    this.#rooms.clear();
    await new Promise<void>((resolve, reject) =>
      this.#wss.close((err) => (err ? reject(err) : resolve())),
    );
    // `wss.close()` leaves an externally-supplied server listening, so the port
    // would stay bound after close() resolved.
    if (this.#https) {
      await new Promise<void>((resolve) => this.#https?.close(() => resolve()));
    }
  }

  #onConnection(socket: WebSocket, url: string): void {
    const id = `c${this.#nextId++}`;
    // Role is a diagnostic label only. The relay treats every peer identically —
    // asymmetry belongs in Layer 4, not here.
    const role = new URLSearchParams(url.split('?')[1] ?? '').get('role') ?? 'peer';

    const peer: Peer = {
      id,
      role,
      send: (data) => socket.send(data),
      close: () => socket.close(),
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
    };

    const client: Client = { peer, socket, room: null, lastSeen: Date.now() };
    this.#clients.set(id, client);
    this.#log('connect', { id, role });

    socket.on('message', (data) => this.#onMessage(client, data.toString()));
    socket.on('close', () => this.#onClose(client));
    socket.on('error', () => this.#onClose(client));
    socket.on('pong', () => {
      client.lastSeen = Date.now();
    });
  }

  #onMessage(client: Client, raw: string): void {
    client.lastSeen = Date.now();

    const msg = tryDecode(raw);
    if (!msg) {
      // Malformed input is expected traffic on a public endpoint, not an
      // exception. Count it and move on — never let it take the relay down.
      this.#log('malformed', { id: client.peer.id });
      return;
    }

    // The relay is the clock reference: it answers pings itself rather than
    // forwarding them, so a client measures RTT to the server it actually
    // routes through.
    if (msg.type === 'ping') {
      client.socket.send(encode(this.#clock.createPong(msg)) as string);
      return;
    }

    if (msg.type === 'join') {
      this.#join(client, msg.room);
      return;
    }

    const room = client.room;
    if (!room) {
      // Frames before a join have nowhere to go. Dropping silently is correct:
      // this is the normal state for the few ms between connect and join.
      return;
    }

    room.broadcast(msg, client.peer.id, raw);
  }

  #join(client: Client, code: string): void {
    if (!isValidRoomCode(code)) {
      this.#log('bad-room-code', { id: client.peer.id, code });
      return;
    }

    if (client.room?.code === code) return; // idempotent: reconnects re-send join

    if (client.room) this.#leave(client);

    let room = this.#rooms.get(code);
    if (!room) {
      room = new Room(code);
      this.#rooms.set(code, room);
    }

    if (!room.add(client.peer)) {
      this.#log('room-full', { id: client.peer.id, code });
      client.socket.close(4001, 'room full');
      return;
    }

    client.room = room;
    this.#log('join', { id: client.peer.id, code, size: room.size });

    // Tell the peers already here that someone arrived, so a display can show
    // "controller connected" without polling.
    const announce: Message = { type: 'join', room: code };
    room.broadcast(announce, client.peer.id, encode(announce) as string);
  }

  #leave(client: Client): void {
    const room = client.room;
    if (!room) return;
    room.remove(client.peer.id);
    client.room = null;
    // Empty rooms are deleted immediately. `docs/layer-4-backend.md` §Gotchas
    // warns about leaked room instances; the relay has no reconnection window to
    // preserve, so there is nothing to keep alive.
    if (room.empty) {
      this.#rooms.delete(room.code);
      this.#log('room-closed', { code: room.code });
    }
  }

  #onClose(client: Client): void {
    if (!this.#clients.delete(client.peer.id)) return; // already handled
    this.#leave(client);
    this.#log('disconnect', { id: client.peer.id });
  }

  #reap(): void {
    const now = Date.now();
    for (const client of [...this.#clients.values()]) {
      if (now - client.lastSeen < this.#idleTimeoutMs) {
        // Probe at the protocol level too — a socket can look open long after
        // its peer has vanished.
        try {
          client.socket.ping();
        } catch {
          /* about to be reaped anyway */
        }
        continue;
      }
      this.#log('reap', { id: client.peer.id });
      client.socket.terminate();
      this.#onClose(client);
    }
  }
}
