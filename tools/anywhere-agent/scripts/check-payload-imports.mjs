#!/usr/bin/env node
/**
 * Packaging gate: every relative import inside a payload must resolve to a file
 * that was actually shipped.
 *
 * This exists because the shell imported the brand generator with a
 * repository-relative path (`../../../scripts/…`). In the checkout that resolves;
 * inside the bundle it pointed at `Contents/scripts/…`, which is not shipped, and
 * the only thing that noticed was a crash dialog on launch. A build step can check
 * it in milliseconds.
 *
 * Usage:
 *   node scripts/check-payload-imports.mjs <payload-dir>
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Matches `from '...'`, a bare `import '...'` and a dynamic `import('...')`. */
const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path, out);
    } else if (/\.(mjs|js|cjs)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

const payload = process.argv[2];
if (!payload) {
  process.stderr.write('usage: check-payload-imports.mjs <payload-dir>\n');
  process.exit(2);
}
if (!existsSync(payload)) {
  process.stderr.write(`payload does not exist: ${payload}\n`);
  process.exit(1);
}

const problems = [];
for (const source of walk(payload)) {
  // A scanner cannot meaningfully scan itself: the pattern literals below look
  // exactly like the imports it is looking for.
  if (resolve(source) === resolve(fileURLToPath(import.meta.url))) {
    continue;
  }
  const text = readFileSync(source, 'utf8');
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const target = resolve(dirname(source), match[1]);
    // A directory import resolves through its package.json; anything else must be a
    // file that exists.
    if (existsSync(target) || existsSync(join(target, 'package.json'))) {
      continue;
    }
    problems.push(`${relative(payload, source)} -> ${match[1]}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`unresolved imports inside ${payload}:\n`);
  for (const problem of problems) {
    process.stderr.write(`  ${problem}\n`);
  }
  process.exit(1);
}
process.stdout.write(`every relative import inside ${payload} resolves\n`);