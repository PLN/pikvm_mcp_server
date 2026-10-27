// Modified 2026-10 by PLN: Docker image (GPL-3.0; see NOTICE).

/**
 * Prints THIRD-PARTY-NOTICES.txt for the npm packages in ./node_modules.
 * Run after `npm prune --omit=dev`, so only production packages are listed.
 * Each package gives its name, version, declared licence, and the text of
 * its licence and notice files. The files also stay in node_modules.
 * Debian packages keep their copyright files under /usr/share/doc.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const LICENCE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

function packageDirs(modulesDir) {
  const dirs = [];
  if (!existsSync(modulesDir)) return dirs;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const full = path.join(modulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(full, { withFileTypes: true })) {
        if (scoped.isDirectory()) dirs.push(path.join(full, scoped.name));
      }
    } else {
      dirs.push(full);
    }
  }
  return dirs;
}

function collect(modulesDir, out) {
  for (const dir of packageDirs(modulesDir)) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const key = `${pkg.name}@${pkg.version}`;
      if (!out.has(key)) {
        const files = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
          .map((entry) => entry.name)
          .sort();
        const licence = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'UNKNOWN');
        out.set(key, {
          licence,
          texts: files.map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8').trimEnd() })),
        });
      }
    }
    collect(path.join(dir, 'node_modules'), out);
  }
}

const packages = new Map();
collect(path.resolve('node_modules'), packages);

const lines = [
  'Third-party notices for the pikvm-mcp-server container image',
  '',
  'The npm packages below ship in /app/node_modules. Each entry gives the',
  'declared licence and the licence and notice files the package carries.',
  'Debian packages in the image keep their copyright files under',
  '/usr/share/doc/<package>/copyright. Their source is in the Debian archive.',
  `Packages: ${packages.size}`,
];
for (const key of [...packages.keys()].sort()) {
  const { licence, texts } = packages.get(key);
  lines.push('', '='.repeat(72), `${key}`, `License: ${licence}`);
  if (texts.length === 0) lines.push('(no licence file in the package)');
  for (const { name, text } of texts) {
    lines.push('', `--- ${name} ---`, text);
  }
}
process.stdout.write(`${lines.join('\n')}\n`);
