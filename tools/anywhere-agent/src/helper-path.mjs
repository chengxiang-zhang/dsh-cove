/**
 * Where the embedded engine binary lives.
 *
 * The engine is one binary built from one Go source tree for every desktop
 * platform, and the only thing that differs between them is its name: Windows
 * needs the `.exe` suffix or the shell looks for a file that cannot exist, misses
 * the copy shipped inside the app, and silently falls back to a developer cache.
 *
 * Resolution is by existence, not by a heuristic. `app.isPackaged` reports false
 * when the executable keeps the stock Electron name, so a packaged app that
 * trusted it pointed at the developer cache instead of the binary beside it. The
 * caller therefore passes an existence predicate and gets back both the choice
 * and whether anything was actually found, so a miss can be reported instead of
 * degrading into a launch that cannot reach the private network.
 */

import { posix, win32 } from 'node:path';

/** The path rules of the platform being described, not of the host running this. */
function pathFor(platform) {
  return platform === 'win32' ? win32 : posix;
}

/** The engine binary's file name on this platform. */
export function helperBinaryName(platform = process.platform) {
  return platform === 'win32' ? 'anywhere-tunnel.exe' : 'anywhere-tunnel';
}

/**
 * The candidate paths for the engine binary, most explicit first.
 *
 * @param {{
 *   platform?: string,
 *   override?: string,
 *   resourcesPath?: string,
 *   home?: string,
 * }} options
 * @returns {string[]}
 */
export function helperCandidates({ platform = process.platform, override, resourcesPath, home } = {}) {
  const name = helperBinaryName(platform);
  const join = pathFor(platform).join;
  const candidates = [];
  if (typeof override === 'string' && override !== '') {
    candidates.push(override);
  }
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    candidates.push(join(resourcesPath, 'bin', name));
  }
  if (typeof home === 'string' && home !== '') {
    // The developer cache `scripts/build-tunnel.sh` writes to. It is the last
    // resort: a packaged app must never prefer it over the copy it carries.
    candidates.push(join(home, '.cache', 'anywhere-agent', 'bin', name));
    if (platform === 'win32') {
      // A Windows checkout has no POSIX home cache; the same script run under Git
      // Bash writes here, and a native PowerShell build writes beside it.
      candidates.push(join(home, 'AppData', 'Local', 'anywhere-agent', 'bin', name));
    }
  }
  return candidates;
}

/**
 * Resolves the engine binary.
 *
 * @param {{
 *   platform?: string,
 *   override?: string,
 *   resourcesPath?: string,
 *   home?: string,
 *   exists: (candidate: string) => boolean,
 * }} options `exists` is required: resolution without a filesystem check is the
 *   bug this function exists to prevent.
 * @returns {{ path: string, found: boolean, candidates: string[] }}
 */
export function resolveHelper({ exists, ...options }) {
  if (typeof exists !== 'function') {
    throw new TypeError('resolveHelper needs an existence predicate');
  }
  const candidates = helperCandidates(options);
  const found = candidates.find((candidate) => exists(candidate));
  return { path: found ?? candidates[0] ?? '', found: Boolean(found), candidates };
}