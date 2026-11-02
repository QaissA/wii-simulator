/**
 * Hand the CA certificate to the phone.
 *
 * There is a chicken-and-egg problem here: the phone cannot trust the dev
 * servers until it has the CA, and it cannot fetch the CA *from* those servers
 * because it does not trust them yet. So this is a deliberately tiny plain-HTTP
 * server whose only job is to give out one file.
 *
 * It serves on 8083 rather than reusing a dev port, so it stays HTTP while
 * everything else moves to HTTPS.
 *
 *   node tools/dev-cert/serve-ca.mjs
 */

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CA_CERT = resolve(join(HERE, 'certs', 'dev-ca.crt'));
const PORT = Number(process.env['PORT'] ?? 8083);

if (!existsSync(CA_CERT)) {
  console.error('No CA found. Run this first:\n  node tools/dev-cert/generate.mjs');
  process.exit(1);
}

const ca = readFileSync(CA_CERT);

const lanIp = (() => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
    }
  }
  return 'localhost';
})();

const page = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install the dev certificate</title>
<style>
  body { margin:0; padding:2rem 1.25rem; background:#0b0f16; color:#e8edf7;
         font:16px/1.6 -apple-system, system-ui, sans-serif; }
  main { max-width: 32rem; margin: 0 auto; }
  h1 { font-size:1.4rem; margin:0 0 .5rem; }
  p  { color:#8a97ad; }
  a.btn { display:block; text-align:center; margin:1.5rem 0; padding:1rem;
          background:#2f6fed; color:#fff; text-decoration:none; border-radius:12px;
          font-weight:600; }
  ol { padding-left:1.2rem; } li { margin:.5rem 0; }
  code { background:#161d2b; padding:.1em .35em; border-radius:4px; font-size:.9em; }
</style>
<main>
  <h1>Wii Simulator dev certificate</h1>
  <p>This lets your phone talk to the laptop over HTTPS on the local network, so
     motion sensors work without routing through the internet.</p>

  <a class="btn" href="/dev-ca.crt">Download the certificate</a>

  <h2 style="font-size:1rem">Then, on iPhone</h2>
  <ol>
    <li>Settings &rarr; <b>Profile Downloaded</b> &rarr; Install (top right).</li>
    <li>Enter your passcode, then Install again.</li>
    <li>This step is easy to miss and nothing works without it:<br>
        Settings &rarr; General &rarr; About &rarr; <b>Certificate Trust Settings</b>,
        and switch on <code>Wii Simulator Dev CA</code>.</li>
  </ol>

  <h2 style="font-size:1rem">On Android</h2>
  <ol>
    <li>Settings &rarr; Security &rarr; Encryption &amp; credentials &rarr;
        <b>Install a certificate</b> &rarr; CA certificate.</li>
    <li>Pick the downloaded file.</li>
  </ol>

  <p style="margin-top:2rem;font-size:.85rem">
    This certificate only signs <code>${lanIp}</code> and <code>localhost</code>.
    Remove it any time from the same settings screen.
  </p>
</main>`;

const server = createServer((req, res) => {
  if (req.url === '/dev-ca.crt') {
    res.writeHead(200, {
      // iOS only offers a certificate as an installable profile when it arrives
      // with this exact type. Served as octet-stream it silently downloads to
      // Files instead, and the Install prompt never appears.
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="wii-dev-ca.crt"',
      'Content-Length': ca.length,
    });
    res.end(ca);
    console.log(`served CA to ${req.socket.remoteAddress}`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop what is on it, or: PORT=8084 node tools/dev-cert/serve-ca.mjs`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  On the phone, open:');
  console.log(`      http://${lanIp}:${PORT}`);
  console.log('');
  console.log('  Install the certificate, then — on iPhone — turn it on under');
  console.log('  Settings > General > About > Certificate Trust Settings.');
  console.log('');
  console.log('  Ctrl-C when done.');
});
