// Modified 2026-10 by PLN: pikvm-mcp-server pin (GPL-3.0; see NOTICE).
// Modified 2026-10 by PLN: a corrupt pin file does not stop a re-pin (GPL-3.0; see NOTICE).

/**
 * `pikvm-mcp-server pin <device>` prints the leaf certificate and, after
 * confirmation, writes it. Only "default" exists until the device registry.
 *
 * The probe is one TLS handshake with verification disabled for that
 * socket only. It sends no HTTP request and no credential. A pin failure
 * in the server does not call this command.
 *
 * --yes skips the interactive question. It is for a scripted re-pin after
 * the new certificate was checked out of band. A non-TTY without --yes
 * writes nothing.
 *
 * The file this writes is the leaf. Pinning a CA or an intermediate
 * later fails with a pin mismatch, because that key is not the leaf.
 * An existing file that is corrupt or not a certificate is printed as
 * unreadable and does not stop the confirmation.
 */

import { existsSync } from 'node:fs';
import {
  probeLeafCertificate,
  readPinnedCert,
  writeCertAtomic,
  type ProbedCertificate,
} from './tls.js';

function printCertificate(cert: ProbedCertificate): void {
  console.log(`subject: ${cert.subject}`);
  console.log(`issuer: ${cert.issuer}`);
  console.log(`valid from: ${cert.validFrom}`);
  console.log(`valid to: ${cert.validTo}`);
  console.log(`SHA-256 fingerprint: ${cert.certSha256}`);
  console.log(`SPKI sha256: ${cert.spkiSha256}`);
}

function askYes(): Promise<boolean> {
  return new Promise((resolve, reject) => {
    process.stdout.write('Write this certificate? Type yes: ');
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).trim() === 'yes');
    });
    process.stdin.once('error', reject);
  });
}

export async function pinCommand(args: string[]): Promise<void> {
  let device: string | undefined;
  let yes = false;
  let out: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--yes') {
      yes = true;
    } else if (arg === '--out') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--out requires a path');
      }
      out = next;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown argument ${arg}`);
    } else if (device === undefined) {
      device = arg;
    } else {
      throw new Error('usage: pikvm-mcp-server pin <device> [--yes] [--out path]');
    }
  }
  if (device === undefined) {
    throw new Error('usage: pikvm-mcp-server pin <device> [--yes] [--out path]');
  }
  if (device !== 'default') {
    throw new Error('only device "default" is supported until the registry (Phase B item 10)');
  }

  const dest = out ?? (process.env.PIKVM_TLS_CERT_FILE || undefined);
  if (!dest) {
    throw new Error('set PIKVM_TLS_CERT_FILE or pass --out');
  }
  const host = process.env.PIKVM_HOST;
  if (!host) throw new Error('PIKVM_HOST environment variable is required');

  const cert = await probeLeafCertificate(host);
  printCertificate(cert);

  if (existsSync(dest)) {
    let previous = 'unreadable';
    try {
      previous = readPinnedCert(dest).spkiSha256;
    } catch {
      previous = 'unreadable';
    }
    console.log(`old SPKI sha256: ${previous}`);
    console.log(`new SPKI sha256: ${cert.spkiSha256}`);
  }

  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!yes && !tty) {
    throw new Error(
      'refusing to write the certificate without a TTY. --yes is for a scripted re-pin after the certificate was verified out of band',
    );
  }
  if (!yes) {
    const accepted = await askYes();
    if (!accepted) throw new Error('certificate was not written');
  }
  writeCertAtomic(dest, cert.pem);
}
