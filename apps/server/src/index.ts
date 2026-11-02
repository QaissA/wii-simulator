/**
 * Relay entry point.
 *
 * Run with `pnpm --filter @wii/server dev`. The controller defaults to port 8081
 * on the page's own host (see `apps/controller/src/modules/pairing-ui.ts`), so
 * the two line up for LAN testing without configuration.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RelayServer } from './relay.js';

/**
 * Serve wss:// when a dev certificate exists.
 *
 * Auto-detected rather than configured, so the relay always matches whatever
 * scheme the Vite apps picked up from the same certificate. Having one of the
 * three on a different scheme is the failure this avoids: the pages load, the
 * socket is blocked as mixed content, and it presents as the relay being down.
 */
function devTls(): { key: Buffer; cert: Buffer } | undefined {
  const dir = fileURLToPath(new URL('../../../tools/dev-cert/certs/', import.meta.url));
  const key = dir + 'dev.key';
  const cert = dir + 'dev.crt';
  if (!existsSync(key) || !existsSync(cert)) return undefined;
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const port = Number(process.env['PORT'] ?? 8081);
const host = process.env['HOST'] ?? '0.0.0.0';

const tls = devTls();

const relay = new RelayServer({
  port,
  host,
  ...(tls ? { tls } : {}),
  log: (event, detail) => {
    // One line per event, structured. The latency dashboard (T6.5) will want to
    // parse these rather than a prose format.
    console.log(JSON.stringify({ t: new Date().toISOString(), event, ...detail }));
  },
});

try {
  await relay.listening();
} catch (err) {
  // The two failures worth naming, because both are hit constantly while
  // testing and neither is obvious from a raw stack trace. Everything else
  // rethrows untouched — a generic handler that swallowed real errors would be
  // worse than none.
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use — a relay is probably still running.`);
    console.error('Stop it, or start this one on another port:  PORT=8090 pnpm dev:relay');
    process.exit(1);
  }
  if (code === 'EACCES') {
    console.error(`Not allowed to bind port ${port}. Ports below 1024 need elevated privileges.`);
    process.exit(1);
  }
  throw err;
}

console.log(
  JSON.stringify({
    t: new Date().toISOString(),
    event: 'listening',
    port: relay.port,
    host,
    scheme: tls ? 'wss' : 'ws',
  }),
);

const shutdown = async (signal: string): Promise<void> => {
  console.log(JSON.stringify({ t: new Date().toISOString(), event: 'shutdown', signal }));
  await relay.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
