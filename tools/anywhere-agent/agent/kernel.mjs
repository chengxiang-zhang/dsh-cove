/**
 * Kernel detection: what this machine's DSH host is, and whether it answers.
 *
 * The app installs nothing. It reads the machine - where `dsh` is, which Node that
 * runtime is, and whether the port answers - and when something is missing it hands
 * over the command the fleet's one-line installer
 * (tools/dsh-netbird/client/install.sh) runs, for the person's own terminal to
 * execute. Downloading a runtime, `npm install -g`, and writing a resident service
 * unit all belong to that installer, not to a window the user opened to see their
 * workspace.
 *
 * Every read goes through an injected primitive (`run`, `probe`), which is what makes
 * this testable: the tests assert the commands, and running them touches nothing. That
 * matters more than usual here, because the machine this is developed on is *serving
 * this session*.
 */

import { posix, win32 } from 'node:path';

/** The port the workspace is served on, loopback only. */
export const KERNEL_PORT = 3080;
/** The oldest Node the harness supports, matching the fleet installer's rule. */
export const NODE_MIN_MAJOR = 22;
/**
 * The path our plugin serves, and the fleet audit reads, as proof that a running host
 * carries it. A profile row says the plugin was added; this says the host serves it.
 */
export const PLUGIN_CONTRACT_PATH = '/web-all/remote-access/boot.js';

/**
 * Where a usable Node can be, in the order this app should consider it.
 *
 * `command -v node` alone is not that answer: an app launched from Finder inherits
 * launchd's minimal PATH, so a Node installed through nvm, Volta, fnm, asdf or
 * Homebrew - and the private runtime the fleet's installer put under
 * `$DSH_HOME/node` - are all invisible to it. Reading only PATH made the app fetch
 * its own 40 MB archive on every start on a machine that already had three Node
 * installs, none of which it could see.
 *
 * Patterns rather than concrete paths: the version managers decide their own version
 * directories, so the layouts are globbed and the best runtime among them is picked.
 */
export function nodeCandidatePatterns(home, dshHome, platform = 'darwin') {
  if (platform === 'win32') {
    // Windows keeps none of the POSIX layouts: the version managers and the
    // installer each own a different directory, and Program Files carries the
    // symlink an nvm-windows install points at the active version.
    return [
      `${dshHome}\\node\\*\\node.exe`,
      `${home}\\AppData\\Roaming\\npm\\node.exe`,
      `${home}\\AppData\\Roaming\\nvm\\*\\node.exe`,
      `${home}\\AppData\\Local\\Volta\\bin\\node.exe`,
      `${home}\\AppData\\Roaming\\fnm\\node-versions\\*\\installation\\node.exe`,
      `${home}\\AppData\\Local\\fnm\\node-versions\\*\\installation\\node.exe`,
      'C:\\Program Files\\nodejs\\node.exe',
      `${home}\\AppData\\Local\\Programs\\nodejs\\node.exe`,
    ];
  }
  return [
    `${dshHome}/node/*/bin/node`,
    `${home}/.nvm/versions/node/*/bin/node`,
    `${home}/.volta/bin/node`,
    `${home}/.local/share/fnm/aliases/default/bin/node`,
    `${home}/.local/share/fnm/node-versions/*/installation/bin/node`,
    `${home}/.asdf/shims/node`,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
}

/** The same layouts, for the host binary a global install puts next to such a runtime. */
export function binaryCandidatePatterns(home, dshHome, platform = 'darwin') {
  if (platform === 'win32') {
    // A global npm install writes command shims, not extensionless scripts.
    return [
      `${dshHome}\\node\\*\\dsh.cmd`,
      `${home}\\AppData\\Roaming\\npm\\dsh.cmd`,
      `${home}\\AppData\\Roaming\\nvm\\*\\dsh.cmd`,
      `${home}\\AppData\\Local\\Volta\\bin\\dsh.exe`,
    ];
  }
  return [
    `${dshHome}/node/*/bin/dsh`,
    `${home}/.nvm/versions/node/*/bin/dsh`,
    `${home}/.volta/bin/dsh`,
    `${home}/.local/share/fnm/aliases/default/bin/dsh`,
    `${home}/.local/share/fnm/node-versions/*/installation/bin/dsh`,
    '/opt/homebrew/bin/dsh',
    '/usr/local/bin/dsh',
  ];
}

/**
 * Which of two usable runtimes to use: the fleet's own major first (22 - the runtime
 * its installer ships and the harness is verified against), then the highest version,
 * then whichever was found first.
 */
export function preferNode(candidate, best) {
  const candidateIsFleet = candidate.major === NODE_MIN_MAJOR;
  const bestIsFleet = best.major === NODE_MIN_MAJOR;
  if (candidateIsFleet !== bestIsFleet) {
    return candidateIsFleet;
  }
  const rank = (entry) => entry.version.major * 1e6 + entry.version.minor * 1e3 + entry.version.patch;
  return rank(candidate) > rank(best);
}

/**
 * The machine label used in the canonical authority.
 *
 * The fleet's rule: the first label of this machine's private-network FQDN, lower
 * cased, everything outside `[a-z0-9-]` folded to `-`, trailing dashes dropped, and
 * `localhost` when nothing survives. Without a logged-in client the local host name
 * is the best available guess, and the entry answers remotely only once an
 * administrator publishes the record.
 *
 * @param {string} value an FQDN, a host name, or nothing
 * @returns {string}
 */
export function machineLabel(value) {
  const first = String(value ?? '')
    .trim()
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+$/, '');
  return first === '' ? 'localhost' : first;
}

/** The canonical authority of this machine's entry: `dsh.<machine>.netbird`. */
export function trustedHost(fqdnOrHost) {
  return `dsh.${machineLabel(fqdnOrHost)}.netbird`;
}

/** Parses the reported DSH version out of whatever `dsh --version` prints. */
export function parseVersion(output) {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(String(output ?? ''));
  return match ? match[1] : '';
}

/**
 * The major version out of whatever `node -v` prints.
 *
 * A version that cannot be read is zero rather than an error: the caller's only
 * question is "is this Node new enough", and an unreadable answer is not.
 *
 * @param {unknown} output the command's stdout
 * @returns {number}
 */
export function parseNodeMajor(output) {
  return parseNodeVersion(output).major;
}

/**
 * The numeric parts of a Node version.
 *
 * Two runtimes of the same major are not interchangeable in practice - a machine can
 * carry v22.11.0 and v22.22.0 - so ordering them needs the minor and patch too.
 */
export function parseNodeVersion(output) {
  const match = /v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(output ?? ''));
  if (!match) {
    return { major: 0, minor: 0, patch: 0 };
  }
  return { major: Number(match[1]), minor: Number(match[2] ?? 0), patch: Number(match[3] ?? 0) };
}

/** POSIX-quotes one argument, so a path with a space cannot become two words. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * PowerShell-quotes one argument: single quotes, with an embedded quote doubled.
 *
 * Windows has no `sh`, so every probe on that platform is a PowerShell command and
 * needs its own escaping - reusing the POSIX form would hand PowerShell a string
 * whose quoting rules differ (`\` is not an escape there, `'` is doubled).
 */
export function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** True on the platform whose paths and shells are Windows'. */
export function isWindows(platform) {
  return platform === 'win32';
}

/**
 * The shell commands this reader needs, phrased for one platform.
 *
 * A GUI launch on Windows inherits the same impoverished environment a Finder
 * launch does on macOS, and `sh` does not exist there at all - so the probes are
 * not "the same commands with different paths" but a different command set:
 * `Get-Command` instead of `command -v`, `Get-Item` for the layouts the version
 * managers own, `Test-Path` instead of `test -x`, and `;` instead of `:` when a
 * runtime's directory is prepended to PATH. Each method returns a
 * `[command, args]` pair for the injected runner, which is what keeps this
 * testable without running any of it.
 *
 * @param {string} platform `process.platform`
 * @returns {{
 *   platform: string, nodeName: string, npmName: string, dshName: string,
 *   which: (name: string) => [string, string[]],
 *   glob: (pattern: string) => [string, string[]],
 *   isExecutable: (target: string) => [string, string[]],
 *   withPath: (dir: string, binary: string, args: string[]) => [string, string[]],
 *   join: (...parts: string[]) => string,
 *   dirOf: (target: string) => string,
 * }}
 */
export function commandSet(platform = 'darwin') {
  if (isWindows(platform)) {
    const ps = (script) => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]];
    return {
      platform,
      nodeName: 'node.exe',
      npmName: 'npm.cmd',
      dshName: 'dsh.cmd',
      which: (name) => ps(`(Get-Command ${name} -ErrorAction SilentlyContinue).Source`),
      glob: (pattern) =>
        ps(
          `Get-Item -Path ${powerShellQuote(pattern)} -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }`,
        ),
      // Explicit exit codes: Test-Path prints True or False and succeeds either way,
      // so the caller's `code === 0` test would call a missing file executable.
      isExecutable: (target) =>
        ps(
          `if (Test-Path -LiteralPath ${powerShellQuote(target)} -PathType Leaf) { exit 0 } else { exit 1 }`,
        ),
      // PowerShell can start a `.cmd` shim, which is what a global npm install of
      // the host actually writes on Windows.
      withPath: (dir, binary, args) =>
        ps(
          `$env:PATH = ${powerShellQuote(dir)} + ';' + $env:PATH; & ${powerShellQuote(binary)} ${args.join(' ')}; exit $LASTEXITCODE`,
        ),
      join: (...parts) => win32.join(...parts),
      dirOf: (target) => win32.dirname(target),
    };
  }
  return {
    platform,
    nodeName: 'node',
    npmName: 'npm',
    dshName: 'dsh',
    which: (name) => ['sh', ['-lc', `command -v ${name}`]],
    glob: (pattern) => ['sh', ['-lc', globCommand(pattern)]],
    isExecutable: (target) => ['sh', ['-c', `test -x ${shellQuote(target)}`]],
    withPath: (dir, binary, args) => [
      'sh',
      ['-lc', `PATH=${shellQuote(dir)}:$PATH ${shellQuote(binary)} ${args.join(' ')}`],
    ],
    join: (...parts) => posix.join(...parts),
    dirOf: (target) => posix.dirname(target),
  };
}

/**
 * One `ls` command per pattern, with the fixed prefix quoted.
 *
 * The quoting matters: quoting the whole pattern hands `ls` a literal asterisk and
 * matches nothing - the bug that made every probe fail on a machine with four Node
 * installs - while quoting only the fixed prefix expands the wildcard and still
 * survives a home directory with a space in it.
 */
function globCommand(pattern) {
  const star = pattern.indexOf('*');
  const target =
    star === -1 ? shellQuote(pattern) : `${shellQuote(pattern.slice(0, star))}${pattern.slice(star)}`;
  return `ls -1d ${target} 2>/dev/null`;
}

/** True when an HTTP status means the port is served, whatever the status is. */
export function portAnswers(statusCode) {
  const code = Number(statusCode);
  return Number.isInteger(code) && code >= 100 && code <= 599;
}

/**
 * Creates the kernel reader.
 *
 * @param {{
 *   run: (command: string, args: string[], options?: object) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   probe: (url: string) => Promise<number>,
 *   platform: string,
 *   paths: { home?: string, dshHome: string },
 *   resolveBinary?: () => Promise<string>,
 *   installCommand?: string,
 *   log?: (line: string) => void,
 * }} options
 */
export function createKernelSupervisor(options) {
  const platform = options.platform;
  const port = KERNEL_PORT;

  /** The home the candidate layouts hang off (`$DSH_HOME`'s parent by default). */
  const commands = commandSet(platform);
  const homeDir = () =>
    options.paths.home ??
    options.paths.dshHome.replace(isWindows(platform) ? /[\\/]\.dsh[\\/]?$/ : /\/\.dsh\/?$/, '');

  /** Every existing path a pattern list matches, in the order given. */
  const globPaths = async (patterns) => {
    const found = [];
    for (const pattern of patterns) {
      const [shell, args] = commands.glob(pattern);
      const result = await options.run(shell, args);
      if (result.code !== 0) {
        continue;
      }
      for (const line of result.stdout.split('\n')) {
        const value = line.trim();
        if (value !== '' && !found.includes(value)) {
          found.push(value);
        }
      }
    }
    return found;
  };

  /** True when `path` is an executable file. */
  const isExecutable = async (path) => {
    const [shell, args] = commands.isExecutable(path);
    const result = await options.run(shell, args);
    return result.code === 0;
  };

  /**
   * Where the host binary is, or an empty string when it is not installed.
   *
   * PATH first - the machine's own choice when the app can see it - then the same
   * layouts `resolveNode` reads, because a runtime that is invisible to a GUI launch
   * also keeps its global installs where PATH cannot see them.
   */
  const resolveBinary = async () => {
    if (options.resolveBinary) {
      return options.resolveBinary();
    }
    const [whichShell, whichArgs] = commands.which(commands.dshName);
    const onPath = await options.run(whichShell, whichArgs);
    if (onPath.code === 0 && onPath.stdout.trim() !== '') {
      return onPath.stdout.trim();
    }
    const matches = await globPaths(binaryCandidatePatterns(homeDir(), options.paths.dshHome, platform));
    return matches.length === 0 ? '' : matches[matches.length - 1];
  };

  /**
   * The Node and npm this machine will use, and whether the Node is new enough.
   *
   * Detection only: it downloads nothing and installs nothing. A machine that
   * already has a runtime - wherever it keeps it - must not be asked to fetch
   * another one, and a machine that has none is the caller's decision to make, not
   * this function's (see `ensure`).
   */
  const resolveNode = async () => {
    const candidates = [];
    const [nodeShell, nodeArgs] = commands.which('node');
    const onPath = await options.run(nodeShell, nodeArgs);
    if (onPath.code === 0 && onPath.stdout.trim() !== '') {
      candidates.push({ binary: onPath.stdout.trim(), source: 'PATH' });
    }
    for (const binary of await globPaths(nodeCandidatePatterns(homeDir(), options.paths.dshHome, platform))) {
      candidates.push({ binary, source: binary });
    }
    let best = null;
    for (const candidate of candidates) {
      const version = parseNodeVersion((await options.run(candidate.binary, ['-v'])).stdout);
      if (version.major < NODE_MIN_MAJOR) {
        continue;
      }
      const dir = commands.dirOf(candidate.binary);
      const npmPath = commands.join(dir, commands.npmName);
      let npm = (await isExecutable(npmPath)) ? npmPath : '';
      if (npm === '' && candidate.source === 'PATH') {
        const [npmShell, npmArgs] = commands.which(commands.npmName);
        const onPathNpm = await options.run(npmShell, npmArgs);
        npm = onPathNpm.code === 0 ? onPathNpm.stdout.trim() : '';
      }
      const choice = {
        binary: candidate.binary,
        npm,
        major: version.major,
        version,
        source: candidate.source,
      };
      if (best === null || preferNode(choice, best)) {
        best = choice;
      }
    }
    return best ?? { binary: '', npm: '', major: 0, source: '' };
  };

  /**
   * What this app can say about the machine, or the command that fixes it.
   *
   * `present` means the host is there. Anything else is a hand-off: the app downloads
   * nothing, runs no `npm install`, and writes no service unit - the fleet's installer
   * owns putting things on a machine, and the person owns running it.
   */
  const handOff = async () => {
    const node = await resolveNode();
    const command = String(options.installCommand ?? '');
    const suffix = command === ''
      ? 'install it yourself (or run your fleet\'s installer), then open this window again'
      : 'run your fleet\'s installer in a terminal';
    if (node.major < NODE_MIN_MAJOR) {
      return {
        action: 'needs-runtime',
        command,
        reason: `this machine has no Node ${NODE_MIN_MAJOR} or newer this app can see, and the app installs nothing itself: ${suffix}`,
      };
    }
    return {
      action: 'needs-host',
      command,
      reason: `this machine has Node ${node.major} (${node.binary}) but no DSH host this app can see, and the app installs nothing itself: ${suffix}`,
    };
  };

  /**
   * Reads the machine's state without changing anything.
   *
   * Two probes and one version query: the workspace port, our plugin's contract path -
   * the plugin is what makes this workspace this product, not a bare DSH - and the host
   * version. This is what the shell calls on every start.
   */
  /**
   * `dsh --version`, asked with the runtime this app already found on PATH.
   *
   * `dsh` is a Node script with `#!/usr/bin/env node`, and a window launched from
   * Finder has no node on PATH - asking without the resolved runtime answers nothing on
   * exactly the machines this app exists for.
   */
  const versionOf = async (binary, node) => {
    if (node.binary === '') {
      return options.run(binary, ['--version']);
    }
    const [shell, args] = commands.withPath(commands.dirOf(node.binary), binary, ['--version']);
    return options.run(shell, args);
  };

  const readStatus = async () => {
    const statusCode = await options.probe(`http://127.0.0.1:${port}/`);
    const reachable = portAnswers(statusCode);
    const binary = await resolveBinary();
    const node = binary === '' ? { major: 0, binary: '' } : await resolveNode();
    const version = binary === '' ? '' : parseVersion((await versionOf(binary, node)).stdout);
    const pluginStatusCode = reachable ? await options.probe(`http://127.0.0.1:${port}${PLUGIN_CONTRACT_PATH}`) : 0;
    return {
      installed: binary !== '',
      binary,
      version,
      reachable,
      statusCode,
      plugins: pluginStatusCode >= 200 && pluginStatusCode < 300,
      pluginStatusCode,
    };
  };

  return {
    /** The machine's state, read-only. */
    status: readStatus,

    /**
     * The runtime this app would use, and where it found it. Read-only, so a
     * diagnostic can say "nvm v22.22.0" instead of "a Node".
     */
    async runtime() {
      return resolveNode();
    },

    /**
     * Ready, or the person gets the command that makes the machine ready.
     *
     * Four layers, each named when it is the missing one: the runtime, the host, the
     * running host, and our plugin on top of it. This app installs none of them - it
     * reads, and it hands over the fleet installer's command.
     */
    async ensure(known = null) {
      const state = known ?? (await readStatus());
      if (state.installed === true && state.reachable === true && state.plugins === true) {
        return { action: 'present', binary: state.binary };
      }
      const node = await resolveNode();
      const command = String(options.installCommand ?? '');
      const suffix = command === ''
        ? 'install it yourself (or run your fleet\'s installer), then open this window again'
        : 'run your fleet\'s installer in a terminal';
      if (node.major < NODE_MIN_MAJOR) {
        return {
          action: 'needs-runtime',
          command,
          reason: `this machine has no Node ${NODE_MIN_MAJOR} or newer this app can see, and the app installs nothing itself: ${suffix}`,
        };
      }
      if (state.installed !== true) {
        return {
          action: 'needs-host',
          command,
          reason: `this machine has Node ${node.major} (${node.binary}) but no DSH host this app can see, and the app installs nothing itself: ${suffix}`,
        };
      }
      if (state.reachable !== true) {
        return {
          action: 'needs-service',
          command,
          reason: `DSH is installed at ${state.binary} but nothing answers on 127.0.0.1:${port}, and this window starts no service: ${suffix}`,
        };
      }
      return {
        action: 'needs-plugin',
        command,
        reason: `DSH answers on 127.0.0.1:${port} but is not serving our plugin (${PLUGIN_CONTRACT_PATH} answered HTTP ${state.pluginStatusCode}), and the app installs nothing itself: ${suffix}`,
      };
    },
  };
}
