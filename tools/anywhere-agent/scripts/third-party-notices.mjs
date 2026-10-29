#!/usr/bin/env node
/**
 * Third-party notices for the embedded engine.
 *
 * The shipped app contains a Go binary with 96 modules linked into it, and their
 * licences must travel with it. The list is not maintained by hand: the helper
 * reports the modules it was actually built from (`version`), and each module's
 * licence text is read from the Go module cache that the build used. A hand-written
 * list would drift the first time a dependency changed.
 *
 * Usage:
 *   node scripts/third-party-notices.mjs [--out <file>] [--helper <path>]
 *
 * When the module cache is unavailable the notices still list every module, and say
 * which of them could not be resolved, rather than pretending the list is complete.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

// The engine is the NetBird userspace client. It is BSD-3-Clause while the
// NetBird management, signal, relay and combined directories are AGPL-3.0; this
// build links only the userspace client, so the BSD-3 notice is the one that
// must travel with the binary.
const NETBIRD_LICENSE = `This BSD-3-Clause license applies to all parts of the repository except for the directories management/, signal/, relay/ and combined/.
Those directories are licensed under the GNU Affero General Public License version 3.0 (AGPLv3). See the respective LICENSE files inside each directory.

BSD 3-Clause License

Copyright (c) 2022-2026 NetBird GmbH & AUTHORS

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;

function parseArgs(argv) {
  const args = {
    helper: join(homedir(), '.cache/anywhere-agent/bin/anywhere-tunnel'),
    out: join(HERE, '..', 'THIRD_PARTY_NOTICES.md'),
    tree: process.env.NETBIRD_TREE || join(homedir(), 'nb-build/netbird'),
  };
  const values = ['--helper', '--out', '--tree'];
  for (let i = 0; i < argv.length; i += 1) {
    if (values.includes(argv[i])) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(args.helper)) {
  process.stderr.write(`helper not found: ${args.helper}\n`);
  process.exit(1);
}

/** Asks the binary what it was built from. */
function readVersion() {
  const result = spawnSync(args.helper, [], { input: '{"id":1,"cmd":"version"}\n', encoding: 'utf8', timeout: 30_000 });
  const line = String(result.stdout ?? '').split('\n').find((entry) => entry.trim() !== '');
  if (!line) {
    throw new Error('the helper did not answer');
  }
  const parsed = JSON.parse(line);
  if (!parsed.ok) {
    throw new Error(String(parsed.error ?? 'the helper refused to report its version'));
  }
  return parsed.result;
}

/**
 * Go escapes upper-case letters in module cache paths as `!` plus the lower-case
 * letter, so `github.com/BurntSushi/toml` lives at `github.com/!burnt!sushi/toml`.
 * Getting this wrong silently reports every mixed-case module as unlicensed.
 */
function escapeModulePath(path) {
  return path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

/** Reads the licence text a module shipped, if the cache still has it. */
function readLicence(modcache, module) {
  if (!modcache) {
    return null;
  }
  const dir = join(modcache, `${escapeModulePath(module.path)}@${module.version}`);
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md', 'LICENSE-MIT', 'NOTICE']) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) {
      const text = readFileSync(candidate, 'utf8').trim();
      return { file: name, text, firstLine: firstMeaningfulLine(text) };
    }
  }
  return null;
}

/** The first line that is not blank and not an obvious title. */
function firstMeaningfulLine(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || /^[=\-#*]+$/.test(trimmed)) {
      continue;
    }
    if (/^the mit license/i.test(trimmed) || /^apache license/i.test(trimmed)) {
      return trimmed;
    }
    if (/copyright/i.test(trimmed) || /license/i.test(trimmed)) {
      return trimmed.slice(0, 140);
    }
  }
  return text.split('\n')[0].trim().slice(0, 140);
}

let modcache = '';
try {
  modcache = execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8', timeout: 20_000 }).trim();
} catch {
  // Go may simply not be installed where the notices are generated.
  modcache = '';
}

/**
 * Fetches a module's source when the cache does not have it.
 *
 * A licence that cannot be read is a licence that cannot be shipped, and the cache
 * only holds what some build happened to need. `go mod download` is the supported
 * way to get the rest, and it is skipped silently when Go is not installed.
 */
function ensureModuleSource(modcacheDir, module) {
  if (modcacheDir === '') {
    return false;
  }
  try {
    execFileSync('go', ['mod', 'download', `${module.path}@${module.version}`], { timeout: 120_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The replacements the build applied.
 *
 * A `replace` shows up in the binary's build info as a zero pseudo-version
 * (`v4.0.0-00010101000000-000000000000`), which cannot be downloaded and whose
 * licence is not in the module cache - the licence that actually ships belongs to
 * the replacement target. Reading `go.mod` is the only way to know what that is.
 */
function readReplacements(tree) {
  const replacements = new Map();
  const file = join(tree, 'go.mod');
  if (!existsSync(file)) {
    return replacements;
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^replace\s+(\S+)\s+=>\s+(\S+)(?:\s+(\S+))?/.exec(line.trim());
    if (match) {
      replacements.set(match[1], { target: match[2], version: match[3] ?? '' });
    }
  }
  return replacements;
}

const version = readVersion();
const modules = Array.isArray(version.modules) ? [...version.modules].sort((a, b) => a.path.localeCompare(b.path)) : [];
const resolved = [];
const unresolved = [];
const replacements = readReplacements(args.tree);
for (const module of modules) {
  const direct = readLicence(modcache, module);
  if (direct) {
    resolved.push({ ...module, licence: direct });
    continue;
  }
  const replacement = replacements.get(module.path);
  if (replacement) {
    // The licence that ships is the replacement's. A local path is read where it
    // is; a module target is fetched like any other.
    const local = replacement.version === '' ? replacement.target : '';
    const resolvedModule = local
      ? { path: local.replace(/^\.\//, ''), version: 'local' }
      : { path: replacement.target, version: replacement.version };
    if (!local && ensureModuleSource(modcache, resolvedModule)) {
      const licence = readLicence(modcache, resolvedModule);
      if (licence) {
        resolved.push({ ...module, licence, replacedBy: `${replacement.target} ${replacement.version}`.trim() });
        continue;
      }
    }
    if (local) {
      const licence = readLicence(join(args.tree, ''), { path: replacement.target, version: '' });
      if (licence) {
        resolved.push({ ...module, licence, replacedBy: replacement.target });
        continue;
      }
    }
  }
  // Not in the cache: fetch the source once, then look again.
  if (ensureModuleSource(modcache, module)) {
    const fetched = readLicence(modcache, module);
    if (fetched) {
      resolved.push({ ...module, licence: fetched });
      continue;
    }
  }
  unresolved.push(module);
}

const lines = [];
lines.push('# Third-party notices');
lines.push('');
lines.push('The desktop application embeds a NetBird userspace engine compiled into a single');
lines.push('Go binary. This file lists every module linked into that binary and the licence');
lines.push('each one shipped. It is generated from the binary itself:');
lines.push('');
lines.push('```sh');
lines.push('node tools/anywhere-agent/scripts/third-party-notices.mjs');
lines.push('```');
lines.push('');
lines.push('## Embedded engine');
lines.push('');
lines.push(`- NetBird: ${version.netbird ?? 'unknown'} (revision ${version.revision ?? 'unknown'})`);
lines.push(`- Go: ${version.go ?? 'unknown'}`);
lines.push(`- Modules: ${modules.length}`);
lines.push('');
lines.push('## Engine licence');
lines.push('');
lines.push('The engine is the NetBird userspace client (BSD-3-Clause). The AGPL-3.0');
lines.push('directories of the NetBird repository (management/, signal/, relay/,');
lines.push('combined/) are not linked into this binary.');
lines.push('');
lines.push('```text');
lines.push(NETBIRD_LICENSE);
lines.push('```');
lines.push('');
if (modcache === '') {
  lines.push('The Go module cache was not available while generating this file, so licence');
  lines.push('texts could not be read. The module list is still complete.');
  lines.push('');
}
lines.push('## Modules');
lines.push('');
lines.push('| Module | Version | Licence |');
lines.push('| --- | --- | --- |');
for (const module of resolved) {
  const note = module.replacedBy ? ` (replaced by ${module.replacedBy})` : '';
  lines.push(`| ${module.path} | ${module.version}${note} | ${module.licence.firstLine.replace(/\|/g, '\\|')} |`);
}
for (const module of unresolved) {
  lines.push(`| ${module.path} | ${module.version} | not readable from the module cache |`);
}
lines.push('');
lines.push('## Licence texts');
lines.push('');
for (const module of resolved) {
  lines.push(`### ${module.path} ${module.version}`);
  lines.push('');
  lines.push('```text');
  lines.push(module.licence.text);
  lines.push('```');
  lines.push('');
}

// Trailing whitespace is not part of a licence, and the repository's hygiene check
// rejects it: trimming it keeps the text intact and the diff clean.
const text = lines
  .join('\n')
  // Per line of the finished document, not per array element: a licence arrives as
  // one multi-line string, so its inner lines have to be trimmed too.
  .split('\n')
  .map((line) => line.replace(/[ \t]+$/, ''))
  .join('\n')
  .replace(/\n+$/, '');
writeFileSync(args.out, `${text}\n`);
process.stdout.write(
  `wrote ${args.out}\n  modules: ${modules.length}\n  with licence text: ${resolved.length}\n  unresolved: ${unresolved.length}\n`,
);
if (unresolved.length > 0) {
  process.stdout.write(`  unresolved:\n${unresolved.map((module) => `    ${module.path}`).join('\n')}\n`);
}