import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

/**
 * Use the local dev certificate when one has been generated.
 *
 * Sensors need a secure context and a LAN address is not one, so device testing
 * requires HTTPS on the LAN — see `tools/dev-cert`. Absent a certificate this
 * stays on plain HTTP, which is correct for `localhost` and for the automated
 * browser checks.
 */
function devHttps() {
  const dir = fileURLToPath(new URL('../../tools/dev-cert/certs/', import.meta.url));
  const key = dir + 'dev.key';
  const cert = dir + 'dev.crt';
  if (!existsSync(key) || !existsSync(cert)) return undefined;
  return { key: readFileSync(key), cert: readFileSync(cert) };
}


const https = devHttps();

export default defineConfig({
  // Relative base so the PWA works from any path on the CDN (Layer 6, T6.1).
  base: './',
  server: {
    // Bind all interfaces: the phone loads this over the LAN or an HTTPS tunnel,
    // never over localhost. Sensors require a secure context either way.
    host: true,
    port: 8080,
    // Fail loudly on a collision instead of silently moving to the next free
    // port. Vite's default is to increment, which produces a controller on a
    // port nobody expects — the QR still advertises 8080, the phone opens
    // whatever is actually there, and the failure looks like a network problem
    // rather than a port one.
    strictPort: true,
    // Spread rather than `https: devHttps()`: `exactOptionalPropertyTypes`
    // distinguishes an absent property from one explicitly set to `undefined`,
    // and Vite's type only permits the former. Omitting the key entirely is also
    // the honest expression of "no certificate, stay on plain HTTP".
    ...(https ? { https } : {}),
  },
  preview: { host: true, port: 8080 },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
