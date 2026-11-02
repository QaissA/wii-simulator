/**
 * Generate a local development certificate so the phone can reach the dev
 * servers over HTTPS on the LAN.
 *
 * Why this exists rather than a tunnel: sensors need a secure context, and a
 * LAN address is not one — but a tunnel routes every frame through the public
 * internet, which on a phone hotspot means the phone talks to itself via a cell
 * tower. The latency that produces has nothing to do with the 50–80 ms budget
 * the project is actually trying to hit. A trusted cert on the LAN keeps the
 * phone one hop from the laptop.
 *
 * It issues a **CA plus a leaf**, not a bare self-signed certificate. The extra
 * step buys one thing that matters here: a hotspot hands out a new IP whenever
 * it feels like it, and the certificate has to name the IP. With a CA, a new IP
 * means regenerating the leaf and restarting the servers — the phone keeps
 * trusting the CA it already has. With a bare self-signed cert, every address
 * change means walking through the iOS trust screens again.
 *
 *   node tools/dev-cert/generate.mjs
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import forge from 'node-forge';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CERT_DIR = resolve(HERE, 'certs');

const CA_CERT = join(CERT_DIR, 'dev-ca.crt');
const CA_KEY = join(CERT_DIR, 'dev-ca.key');
const LEAF_CERT = join(CERT_DIR, 'dev.crt');
const LEAF_KEY = join(CERT_DIR, 'dev.key');

/** Every address the phone might use to reach this machine. */
function localAddresses() {
  const ips = new Set(['127.0.0.1']);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      // Skip APIPA (169.254.x) — those are unconfigured adapters, never a route
      // a phone will take, and they only bloat the SAN list.
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        ips.add(a.address);
      }
    }
  }
  return [...ips];
}

function makeCa() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  // Long-lived on purpose: this is the certificate a human installs on a phone,
  // and having it expire mid-project means repeating that by hand.
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 5);

  const attrs = [
    { name: 'commonName', value: 'Wii Simulator Dev CA' },
    { name: 'organizationName', value: 'Wii Simulator (local development only)' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

function makeLeaf(ca, addresses) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  // 825 days is the longest Apple platforms accept for a server certificate.
  // Anything longer is rejected outright, which presents as an opaque TLS
  // failure rather than an expiry message.
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + 820);

  cert.setSubject([{ name: 'commonName', value: addresses[1] ?? addresses[0] ?? 'localhost' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      // Modern browsers ignore commonName entirely — the SAN list is the whole
      // contract. An address missing from here fails as a name mismatch.
      altNames: [
        { type: 2, value: 'localhost' },
        ...addresses.map((ip) => ({ type: 7, ip })),
      ],
    },
  ]);
  cert.sign(ca.key, forge.md.sha256.create());
  return { cert, key: keys.privateKey };
}

function loadCa() {
  if (!existsSync(CA_CERT) || !existsSync(CA_KEY)) return null;
  return {
    cert: forge.pki.certificateFromPem(readFileSync(CA_CERT, 'utf8')),
    key: forge.pki.privateKeyFromPem(readFileSync(CA_KEY, 'utf8')),
  };
}

const addresses = localAddresses();
mkdirSync(CERT_DIR, { recursive: true });

// Reuse an existing CA if there is one. Regenerating it would silently
// invalidate the trust already installed on the phone — the servers would come
// up fine and the phone would refuse them, which reads as a broken cert rather
// than a replaced one.
const existing = loadCa();
const ca = existing ?? makeCa();

if (existing) {
  console.log('reusing existing CA (the phone keeps its trust)');
} else {
  writeFileSync(CA_CERT, forge.pki.certificateToPem(ca.cert));
  writeFileSync(CA_KEY, forge.pki.privateKeyToPem(ca.key));
  console.log('created a new CA — this one has to be installed on the phone');
}

const leaf = makeLeaf(ca, addresses);
writeFileSync(LEAF_CERT, forge.pki.certificateToPem(leaf.cert));
writeFileSync(LEAF_KEY, forge.pki.privateKeyToPem(leaf.key));

console.log('');
console.log('certificate covers:');
for (const ip of addresses) console.log(`  ${ip}`);
console.log('  localhost');
console.log('');
console.log(`written to ${CERT_DIR}`);
console.log('');
console.log('next:');
console.log('  1. node tools/dev-cert/serve-ca.mjs      # then install the CA on the phone');
console.log('  2. restart the three dev servers          # they pick the cert up automatically');
