/**
 * Electron main process for the intranet browser shell.
 *
 * The shell owns no networking of its own. Every window runs on one partition
 * whose proxy is the agent's loopback port, so the only way anything here reaches
 * the private network is through the agent, and the operating system is never told
 * about the overlay. That is the same shape the mobile client ships: the app is a
 * peer, the machine is not.
 *
 * Two modes, same IPC surface:
 *   --engine [--dir <path>]   drive the embedded engine through the supervisor
 *   --proxy <url>             an agent is already running (acceptance runs)
 *
 * Usage:
 *   electron shell --engine
 *   electron shell --proxy http://127.0.0.1:19001
 */

import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, net, powerMonitor, session, shell as electronShell, Tray, WebContentsView, nativeImage } from 'electron';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSupervisor } from '../agent/supervisor.mjs';
import { KERNEL_PORT, createKernelSupervisor, machineLabel, trustedHost } from '../agent/kernel.mjs';
import { buildRegistry } from '../src/discovery.mjs';
import { isCloudZone } from '../src/netbird-names.mjs';
import { DSH_ZONES } from '../src/generated/fleetConfig.mjs';
import { createPeerResolver, parsePeers, parseSelfStatus } from '../src/netbird-status.mjs';
import { TunnelClient } from '../src/tunnel-client.mjs';
import { localEntry, localRowsFrom, mergeEntries, uiState } from '../src/panel-state.mjs';
import { localAddresses } from '../src/local-addresses.mjs';
import { fleetWanted, withFleetIntent } from '../src/fleet-intent.mjs';
import { endpointFromEngineConfig, endpointHostLabel, endpointIsUsable, loadBootstrapEndpoint, normalizeEndpoint, resolveEndpoint, shouldRetryEndpointDiscovery } from '../src/endpoint.mjs';
import { ackIdOf, badgeUrl, clampWatermark, parseWatermarks, readDecision, summarizeFeed } from '../src/notify.mjs';
import { resolveHelper as resolveHelperPath } from '../src/helper-path.mjs';
import { shouldReloadOnRefresh, shouldReloadOnWake, workspacePageAction } from '../src/view-freshness.mjs';
import { SNAPSHOT_HEARTBEAT_MS, shouldClearProxy, shouldReadSnapshotOnHeartbeat, snapshotHeartbeatMs, viewsToPrune } from '../src/snapshot-freshness.mjs';
import { updateCheckDue } from '../src/update.mjs';


const HERE = dirname(fileURLToPath(import.meta.url));
const PARTITION = 'persist:anywhere-shell';
// In a bundle the payload lives at Resources/app and the engine at Resources/bin;
// in a checkout both sit next to this file's parent.
const APP_ROOT = app.isPackaged ? join(process.resourcesPath, 'app') : join(HERE, '..');
const CONTRACT_FILE = join(APP_ROOT, 'packaging', 'version-contract.json');

/**
 * Where the embedded engine is.
 *
 * Resolved by existence rather than by a heuristic: `app.isPackaged` reports false
 * when the executable keeps the stock Electron name, which silently sent a packaged
 * app at the developer cache instead of the binary inside the bundle. A candidate
 * that is on disk is the fact.
 */
function resolveHelper() {
  const resolution = resolveHelperPath({
    platform: process.platform,
    override: args.tunnel,
    resourcesPath: process.resourcesPath ?? '',
    home: homedir(),
    exists: existsSync,
  });
  // A miss is reported rather than ignored: continuing with a path that is not on
  // disk is how the app came up looking ready and then failed to reach anything.
  if (!resolution.found) {
    process.stderr.write(
      `shell: no engine binary on disk (looked for ${resolution.candidates.join(', ')}); the private network cannot start\n`,
    );
  }
  return resolution.path;
}
const FLEET_ZONES = [...DSH_ZONES];
/**
 * The address this install enrolls against, and where it came from.
 *
 * A deployment supplies it in one of four ways, most explicit first: the
 * `--management-url` flag, the `AW_MANAGEMENT_URL` environment variable (the same name
 * the fleet's one-line installer reads), the address a packager baked into the bundle,
 * or the document on the update channel - which is only ever a seed for an install that
 * has none of the others. The address an already-enrolled engine config carries is read
 * too, and outranks the package default: a signed-in machine must not be moved to
 * another account by a newer bundle.
 *
 * The placeholder is not one of the answers. It is what a deployment that supplies
 * nothing would otherwise dial, and dialling it is the failure the resolver exists to
 * prevent: a minute of "connecting" followed by an engine error that never names the
 * server. When nothing usable is found the window asks for the address instead, and the
 * engine is never started.
 *
 * See `src/endpoint.mjs` for the decision itself; this file owns where each source is
 * read from.
 */
let channelEndpoint = '';
/** When the channel document was last read, so a launch-time miss can be retried. */
let channelReadAt = 0;
/** Set while the user has asked for their other machines and no address can be dialled. */
let fleetNeedsServer = false;

/** Where the embedded engine keeps this install's identity. */
function engineConfigPath() {
  return join(args.dir, 'config.json');
}

/** The address a deployment baked into the bundle, when it supplied one. */
function bundledEndpoint() {
  try {
    const document = JSON.parse(readFileSync(join(APP_ROOT, 'endpoint.json'), 'utf8'));
    return typeof document?.managementUrl === 'string' ? document.managementUrl : '';
  } catch {
    return '';
  }
}

/** The address an enrolled engine config carries; one holding the placeholder answers ''. */
function enrolledEndpoint() {
  try {
    return endpointFromEngineConfig(JSON.parse(readFileSync(engineConfigPath(), 'utf8')));
  } catch {
    return '';
  }
}

function currentEndpoint() {
  return resolveEndpoint({
    flag: args.managementUrl,
    env: process.env.AW_MANAGEMENT_URL,
    choice: readSettings().server?.url ?? '',
    bundled: bundledEndpoint(),
    engine: enrolledEndpoint(),
    seed: channelEndpoint,
  });
}

/** The endpoint facts the window shows, so a failure names the server it meant. */
function serverBlock() {
  const resolved = currentEndpoint();
  return { ...resolved, host: endpointHostLabel(resolved.url) };
}

/**
 * Reads the channel document, but only for an install that has nothing to dial.
 *
 * A machine that already has an address must not pay for a fetch it will not use, and
 * must not be re-pointed by one either: the resolver reads the document as a seed, so it
 * is consulted only when every other source is empty.
 */
async function discoverChannelEndpoint() {
  if (currentEndpoint().url !== '') {
    return;
  }
  channelReadAt = Date.now();
  channelEndpoint = await loadBootstrapEndpoint();
}

/**
 * Reads the channel document again while the client still has nothing to dial.
 *
 * The launch read races the network: a first run right after wake, or on a link that is
 * not up yet, leaves the window asking for an address the channel does publish, and
 * nothing ever asked again. Retrying is bounded - only while there is nothing to dial,
 * at most once a minute - and the retry cannot re-point an install that already has an
 * address: that is the resolver's own rule, not this function's.
 */
async function retryChannelEndpoint() {
  channelReadAt = Date.now();
  await discoverChannelEndpoint();
  if (currentEndpoint().url === '') {
    return;
  }
  process.stderr.write('shell: the channel document supplied an address after launch\n');
  await currentSnapshot().catch((error) => {
    process.stderr.write(`shell: the list could not be re-read after the address arrived (${error?.message ?? error})\n`);
  });
}

// A 16x16 disc in the shell's accent colour, inline so the tray needs no asset
// file next to the code that shows it.
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAOElEQVR42mNgoBXw6f3/HxmTrZEkgwhpxmsIsZpxGkKRAaRqxjBkGBgw8LFAlYRElaRMlcxEKgAAND2kXIzddIQAAAAASUVORK5CYII=';

function parseArgs(argv) {
  // Only the flags that take a value consume the next argument. A boolean flag
  // that also advanced the cursor swallowed its neighbour (`--engine --dir X`
  // lost the directory), which is a silent failure: the app keeps working, on the
  // wrong profile.
  const valueFlags = new Set(['--proxy', '--netbird', '--dir', '--tunnel', '--states', '--setup-key', '--management-url']);
  const args = { proxy: '', engine: true, acceptance: false, netbird: '', dir: '', tunnel: '', states: '', setupKey: '', managementUrl: '', fleet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      continue;
    }
    if (valueFlags.has(key)) {
      // `--setup-key` is `args.setupKey`: a flag name with dashes has to become a
      // property name, or the value silently disappears.
      const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      args[name] = argv[i + 1] ?? '';
      i += 1;
    } else if (key === '--engine') {
      args.engine = true;
    } else if (key === '--fleet') {
      // Opt-in, and only for development and acceptance runs: the private network
      // is what the user turns on, never something the app turns on for them.
      args.fleet = true;
    } else if (key === '--acceptance') {
      args.acceptance = true;
    }
  }
  // The embedded engine is the product: an app the user opens manages its own
  // network, its own identity and its own sign-in. Reading the machine's own client
  // instead is a development seam, so it is requested explicitly - by `--acceptance`,
  // or by handing the app a proxy or a system binary, which only the runs do.
  args.engine = !(args.acceptance || args.proxy !== '' || args.netbird !== '');
  return args;
}

// A packaged app receives `[executable, ...args]`, while `electron <dir> ...`
// receives `[electron, <dir>, ...args]`. Electron reports which one this is, so the
// app does not have to guess - guessing dropped the first flag when packaged.
const APP_ARGV = process.defaultApp ? process.argv.slice(2) : process.argv.slice(1);
const args = parseArgs(APP_ARGV);
// Recorded because the two run shapes differ and a wrong guess silently drops the
// first flag: this line is the difference between a packaged app and a checkout.
process.stderr.write(
  `shell: packaged=${app.isPackaged} defaultApp=${process.defaultApp} argv=${JSON.stringify(APP_ARGV)}\n`,
);

let supervisor = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {Tray | null} */
let tray = null;
let schemeChoice = 'system';
/** Snapshots supplied by --states, consumed one read at a time. */
let scriptedStates = null;
let scriptedSelected = '';
/** The sign-in poll, owned by the main process. */
let loginWatcher = null;
/**
 * The acceptance seam: what the main process believes is on screen right now.
 *
 * Showing or hiding a workspace changes the screen without rebuilding the agent
 * snapshot, so the seam is written from both places - a stale seam is how a run
 * reports "never embedded" about a workspace that is in fact rendering.
 */
function writeSeam() {
  const base = globalThis.__awSnapshot ?? {};
  globalThis.__awSnapshot = {
    ...base,
    workspace: activeWorkspace === '' ? null : { host: activeWorkspace },
  };
}

/** The entries the window was last shown: a click acts on what the user saw. */
let offeredEntries = [];
/** The read in flight, so a heartbeat and a click share one probe instead of racing. */
let snapshotRead = null;
/** The last snapshot published, so opening a machine can clear its dot in place. */
let lastSnapshot = null;
/**
 * When the machine list was last read.
 *
 * The list's three answers (reachable, unseen work, engine alive) are not pushed by
 * anything, so the shell re-reads them on a heartbeat; this is the reading it ages.
 */
let lastPublishedAt = 0;
/** The kernel's state, read at most every 30 seconds: the panel is not a monitor. */
let kernelStatus = null;
let kernelReadAt = 0;
/** The one kernel supervisor this process uses; it owns no state of its own. */
let kernelSupervisor = null;

/**
 * The local host's own state, and the fleet link's.
 *
 * They are separate on purpose and are never merged into one flag: this machine's
 * workspace is a fact the client can establish alone, and the private network that
 * reaches the user's *other* machines is a thing the user asks for. `off` is
 * therefore a normal value for the fleet, not a failure.
 */
let localState = 'checking';
let localDetail = '';
/**
 * The command a person runs to install what is missing, when this app knows one.
 *
 * It is never run by the app itself: the app hands it to the platform's terminal.
 */
let localCommand = '';

const runFile = promisify(execFile);

/** Runs a command and reports its outcome; never throws for a non-zero exit. */
async function runCommand(command, args, options = {}) {
  try {
    const result = await runFile(command, args, { timeout: 8_000, ...options });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: Number(error?.code ?? 1), stdout: error?.stdout ?? '', stderr: error?.stderr ?? String(error?.message ?? error) };
  }
}

/** One HTTP status for a URL, or 0 when nothing answers. */
async function probePort(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.status;
  } catch {
    return 0;
  }
}

/**
 * The installer command a person's own terminal would run.
 *
 * The app never downloads a runtime into itself: when this machine has neither Node
 * nor DSH, the fleet's installer is handed to the platform's terminal, where the
 * person can see it and the shell that owns the machine performs the install. The
 * endpoint comes from the environment (`AW_INSTALL_URL`, or `AW_CHANNEL` exactly as
 * the fleet's one-liner reads it), because this repository carries no real endpoint.
 */
function installerCommand() {
  const direct = String(process.env.AW_INSTALL_URL ?? '');
  if (direct !== '') {
    return `curl -fsSL ${direct} | sh`;
  }
  const channel = String(process.env.AW_CHANNEL ?? '');
  if (channel === '') {
    return '';
  }
  return `curl -fsSL ${channel.replace(/\/client\/?$/, '')}/install.sh | sh`;
}

/**
 * The kernel supervisor, built once.
 *
 * Read-only by default: `status()` is the only method the read path calls. The
 * write methods (`ensure`, `start`) belong to the first-run sequence below, which
 * installs the host on a machine that has a runtime but no host. A machine with no
 * runtime at all gets the installer command instead - the app does not download one.
 */
function kernelSupervisorFor() {
  if (kernelSupervisor) {
    return kernelSupervisor;
  }
  kernelSupervisor = createKernelSupervisor({
    run: runCommand,
    probe: probePort,
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, content) => writeFile(path, content, 'utf8'),
    mkdir: (path) => mkdir(path, { recursive: true }),
    installCommand: installerCommand(),
    platform: process.platform,
    paths: {
      home: homedir(),
      dshHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
      launchAgents: join(homedir(), 'Library', 'LaunchAgents'),
      systemdUser: join(homedir(), '.config', 'systemd', 'user'),
    },
    log: (line) => process.stderr.write(`[kernel] ${line}\n`),
  });
  return kernelSupervisor;
}

/**
 * Reads whether this machine can serve a workspace, and whether our own service
 * unit is the thing serving it. Read-only by construction: the kernel supervisor's
 * `status` runs queries, and the only methods that write are never called here.
 */
async function readKernelStatus(force = false) {
  if (!force && kernelStatus && Date.now() - kernelReadAt < 30_000) {
    return kernelStatus;
  }
  try {
    kernelStatus = await kernelSupervisorFor().status();
  } catch (error) {
    kernelStatus = { error: String(error?.message ?? error) };
  }
  kernelReadAt = Date.now();
  return kernelStatus;
}

/** This machine's own workspace URL. Never a fleet address: it is the copy in front of the user. */
function loopbackUrl() {
  return `http://127.0.0.1:${KERNEL_PORT}/`;
}

/**
 * This machine's own row for the frames where no fleet record addresses it.
 *
 * Before anyone signs in the host name is the only name there is, and this row must stay
 * derived from it: identity in a connected fleet comes from the address match, so letting
 * the engine's name leak in here would only make the label flip between refreshes.
 */
function localIdentity() {
  const machine = machineLabel(hostname());
  return { machine, host: trustedHost(machine), url: loopbackUrl() };
}

/** The local block of the snapshot: everything the sidebar and diagnostics need. */
function localBlock(identity = localIdentity()) {
  return { ...identity, state: localState, detail: localDetail, command: localCommand };
}

/**
 * Reads this machine's state, and hands over the installer command when it is not ready.
 *
 * The client installs nothing: it finds the host and the runtime that would run it,
 * reports what it found, and when something is missing it puts the fleet installer's
 * command in front of the person with a way to run it in their own terminal. "You do
 * not install DSH by hand" is the installer's promise, not this window's.
 *
 * The port answering is the verdict, never a command's exit code: a host that is
 * present but not serving is a state the person must see, with the way out next to it.
 */
async function prepareLocal() {
  const kernel = kernelSupervisorFor();
  let status;
  try {
    status = await kernel.status();
  } catch (error) {
    localState = 'error';
    localDetail = String(error?.message ?? error);
    return;
  }
  kernelStatus = status;
  kernelReadAt = Date.now();

  // Four layers make a machine ready: a Node, the host, a host that answers, and our
  // plugin on top of it - the plugin is what makes this workspace this product.
  if (status.installed === true && status.reachable === true && status.plugins === true) {
    localState = 'ready';
    localDetail = '';
    localCommand = '';
    return;
  }

  // One of them is missing. The window installs none of it: it names the layer and puts
  // the fleet installer's command in front of the person.
  const handoff = await kernel.ensure(status);
  if (handoff.action === 'present') {
    localState = 'ready';
    localDetail = '';
    localCommand = '';
    return;
  }
  localState = 'needs-install';
  localDetail = handoff.reason;
  localCommand = handoff.command || installerCommand();
  void currentSnapshot();
}

/**
 * Runs the installer command in the platform's own terminal.
 *
 * The person sees the command and the shell that owns the machine performs the
 * install; the app stays out of it, which is the difference between handing a command
 * over and installing a runtime behind someone's back. Only the command this process
 * built from its own environment is ever run - never text from the renderer.
 */
function runInstallerInTerminal(command) {
  const installer = String(command ?? '');
  if (installer === '') {
    return { ok: false, reason: '没有可运行的安装命令(启动时未提供 AW_CHANNEL 或 AW_INSTALL_URL)' };
  }
  if (process.platform !== 'darwin') {
    return { ok: false, reason: '这个平台暂不支持一键打开终端,请复制上面这行命令自行运行' };
  }
  const quoted = installer.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const result = spawnSync(
    'osascript',
    [
      '-e',
      `tell application "Terminal" to do script "${quoted}"`,
      '-e',
      'tell application "Terminal" to activate',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return { ok: false, reason: (result.stderr || '').trim() || '无法打开终端' };
  }
  return { ok: true };
}

/** The proxy currently applied to the shell's session, so it is set once. */
let appliedProxy = '';

/**
 * Points every window at the agent's loopback proxy the moment the agent offers one.
 *
 * Without this the shell has no way into the private network at all: a workspace
 * window would try the address directly, which either fails or - far worse - quietly
 * leaves the app-scoped path and rides whatever the machine's own network does.
 */
function applyAgentProxy(proxy) {
  if (typeof proxy !== 'string' || proxy === '' || proxy === appliedProxy) {
    return;
  }
  appliedProxy = proxy;
  proxySession()
    // Loopback is bypassed so this machine's own workspace keeps working while the
    // fleet's proxy is installed: it is reached directly, and it is the one entry
    // that must never depend on the private network being up.
    .setProxy({ proxyRules: proxy, proxyBypassRules: '127.0.0.1,localhost,<local>' })
    .then(() => process.stderr.write(`shell: session proxy ${proxy}\n`))
    .catch((error) => process.stderr.write(`shell: session proxy failed (${error?.message ?? error})\n`));
}

/**
 * Clears the session proxy, for when the engine that owned it is gone.
 *
 * Kept separate from {@link applyAgentProxy} because the two directions have different
 * owners: installing waits for a proxy to be offered, clearing happens when the reading
 * stops offering one at all.
 */
function clearAgentProxy() {
  if (appliedProxy === '') {
    return;
  }
  appliedProxy = '';
  proxySession()
    .setProxy({ mode: 'direct' })
    .then(() => process.stderr.write('shell: session proxy cleared; the fleet link is gone\n'))
    .catch((error) => process.stderr.write(`shell: session proxy could not be cleared (${error?.message ?? error})\n`));
}

/**
 * The versions this build was written against. Missing or unreadable means no
 * contract is enforced rather than a crash: a shell without its contract is still
 * a screen that can explain itself.
 */
function readContract() {
  try {
    return JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
  } catch {
    process.stderr.write(`shell: no version contract at ${CONTRACT_FILE}\n`);
    return null;
  }
}

/**
 * What this window is: the product version and the build it was made from.
 *
 * Read from the payload's own `package.json`, which is the file the packager writes the
 * release version and the git build number into. A checkout has the same file without a
 * build number, so a development run reports the version it declares and no build rather
 * than inventing one. Two builds of one version are told apart by exactly this pair,
 * which is why it is shown instead of kept in a filename nobody reads.
 *
 * @returns {{ version: string, build: string }} the window's own identity
 */
let appIdentityCache = null;
function appIdentity() {
  if (appIdentityCache !== null) {
    return appIdentityCache;
  }
  try {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8'));
    appIdentityCache = {
      version: typeof manifest.version === 'string' ? manifest.version : '',
      build: typeof manifest.build === 'string' ? manifest.build : '',
    };
  } catch (error) {
    process.stderr.write(`shell: no app manifest for this window (${error?.message ?? error})\n`);
    appIdentityCache = { version: '', build: '' };
  }
  return appIdentityCache;
}

/** Where the user's choices live. Small enough that a file is the honest store. */
function settingsPath() {
  return join(args.dir, 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(next) {
  try {
    writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`shell: settings could not be written (${error.message})\n`);
  }
}

/**
 * Where the per-machine read watermarks live.
 *
 * A machine's dot means "finished work you have not looked at", so the client has
 * to remember how far it has read on each machine. A file beside the settings is
 * the honest store for a number per machine.
 */
function notifyStorePath() {
  return join(args.dir, 'notify.json');
}

/** The stored watermarks, or an empty record when the file is absent or unreadable. */
function readWatermarks() {
  try {
    return parseWatermarks(JSON.parse(readFileSync(notifyStorePath(), 'utf8')));
  } catch {
    // A missing or corrupt side file costs one read from zero, which is recoverable.
    // Refusing to show the machine list over it would not be.
    return {};
  }
}

/** Writes the watermarks through a temporary file, so a crash cannot leave half of one. */
function writeWatermarks(next) {
  const path = notifyStorePath();
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(temporary, path);
  } catch (error) {
    process.stderr.write(`shell: notify watermark could not be written (${error.message})\n`);
  }
}

/**
 * Records the newest notice this client has seen on one machine.
 *
 * Only ever moves forward: a stale reading that arrives late cannot un-read work
 * the user has already looked at.
 */
function markSeen(host, noticeId) {
  const id = clampWatermark(noticeId);
  const all = readWatermarks();
  if (!(id > (all[host] ?? 0))) {
    return;
  }
  all[host] = id;
  writeWatermarks(all);
}

/** Forgets one machine's watermark, for when its host restarted and ids start over. */
function forgetWatermark(host) {
  const all = readWatermarks();
  if ((all[host] ?? 0) === 0) {
    return;
  }
  all[host] = 0;
  writeWatermarks(all);
}

function proxySession() {
  return session.fromPartition(PARTITION);
}

/**
 * The window background, before any stylesheet exists.
 *
 * Generated next to the stylesheet from the same token source: an application must
 * not import the build script that produced them, and a path out of the bundle does
 * not resolve once the app is packaged.
 */
function windowBackground() {
  try {
    const tokens = JSON.parse(readFileSync(join(HERE, 'renderer', 'tokens.json'), 'utf8'));
    const scheme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    return tokens[scheme]?.bg ?? '#000000';
  } catch (error) {
    process.stderr.write(`shell: token data unavailable (${error.message})\n`);
    return '#000000';
  }
}

/**
 * Keeps only the entries that are really DSH machines.
 *
 * The probe goes through the shell's own session, so it travels the same
 * app-scoped path the workspace will. It asks each candidate for the
 * remote-access posture reading, which needs no session and is deployed on every
 * machine that serves a workspace; a name that merely happens to answer on port
 * 80 (an update channel, a landing page) does not declare an authority and is
 * therefore not offered. This is the same reading the fleet audit uses.
 *
 * Reachability is decided by that reading alone. The finished-run feed is a
 * second, later capability, so a machine that has not been updated answers 404
 * for it; that must leave the machine reachable and undotted rather than push it
 * out of the list.
 */
function probeEntries(entries) {
  const shellSession = proxySession();
  const watermarks = readWatermarks();
  return Promise.all(
    entries.map((entry) => probeEntry(entry, shellSession, watermarks[entry.host])),
  ).then((probed) => probed.filter((entry) => entry.reachable));
}

/**
 * The machine whose workspace is the one on screen, or '' when the user is not in one.
 *
 * It is the whole of "the user is inside this machine": a row for that host carries no
 * count and is recorded as read, because work that finished while its workspace was on
 * screen is work the user watched finish.
 *
 * @returns {string} the watched machine's canonical host
 */
function watchedHost() {
  return activeWorkspace;
}

/**
 * One candidate URL: does it answer as a DSH machine?
 *
 * The request goes through the shell's own session, so it uses the same trust store
 * and the same app-scoped path the workspace will, and an entry whose certificate
 * the machine does not trust is a failure here rather than a broken page later.
 *
 * @returns {Promise<{ declared: boolean, statusCode?: number, reason: string }>}
 */
function probeCandidate(url, shellSession) {
  return new Promise((resolve) => {
    const request = net.request({ method: 'GET', url: `${url}api/dsh-access/session`, session: shellSession });
    let body = '';
    const timer = setTimeout(() => {
      request.abort();
      resolve({ declared: false, reason: 'timed out' });
    }, 8_000);
    request.on('response', (response) => {
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        clearTimeout(timer);
        let declared = false;
        try {
          declared = JSON.parse(body)?.authority?.declared === true;
        } catch {
          declared = false;
        }
        resolve({
          declared,
          statusCode: response.statusCode,
          reason: declared ? '' : `HTTP ${response.statusCode} without an authority`,
        });
      });
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      resolve({ declared: false, reason: String(error?.message ?? error) });
    });
    request.end();
  });
}

/** One candidate: is it a machine, and does it have finished runs to report? */
async function probeEntry(entry, shellSession, stored) {
  const candidates = Array.isArray(entry.urls) && entry.urls.length > 0 ? entry.urls : [entry.url];
  let answered = null;
  const failures = [];
  for (const url of candidates) {
    const result = await probeCandidate(url, shellSession);
    if (result.declared) {
      answered = { url, statusCode: result.statusCode };
      break;
    }
    failures.push(`${url} (${result.reason})`);
  }
  if (answered === null) {
    // Named on stderr because it is also the reading for "the TLS entry is not
    // trusted on this machine yet", which otherwise only shows up as a machine
    // that quietly opened on plaintext and cannot record.
    process.stderr.write(`shell: ${entry.host} did not answer as a machine: ${failures.join('; ')}\n`);
    return { ...entry, reachable: false };
  }
  const probed = { ...entry, url: answered.url, reachable: true, statusCode: answered.statusCode };
  // The feed can only add the dot: it cannot withdraw a machine the reading
  // above accepted, and it cannot fail this probe - an absent feed is the
  // same answer as an empty one.
  try {
    const summary = await readNoticeFeed(probed, shellSession, stored, entry.host === watchedHost());
    return {
      ...probed,
      unread: summary.unread,
      unreadFailed: summary.failed,
      latestNotice: summary.latestNotice,
      latest: summary.latest,
    };
  } catch {
    // Belt and braces: a rejected feed read would leave this entry unresolved,
    // which would hold the whole list behind it.
    return { ...probed, unread: 0, unreadFailed: 0, latestNotice: null, latest: 0 };
  }
}

/** One feed request, as text. Resolves null for anything that is not a usable answer. */
function readFeedBody(url, shellSession) {
  return new Promise((resolve) => {
    let settled = false;
    let request = null;
    const done = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      request?.abort();
      done(null);
    }, 4_000);
    try {
      request = net.request({ method: 'GET', url, session: shellSession });
    } catch {
      // A url this client cannot dial is the same answer as a machine that does not
      // serve the feed: nothing to report.
      done(null);
      return;
    }
    request.on('response', (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => done(response.statusCode === 200 ? body : null));
      response.on('error', () => done(null));
    });
    request.on('error', () => done(null));
    request.end();
  });
}

/**
 * Reads one machine's finished-run feed and reduces it to the row's facts.
 *
 * `watching` says this machine's workspace is the one on screen. Its count is then zero
 * whatever the host holds - the user is inside it, so nothing there is work to come back
 * for - and the reading records the machine as read up to what the host just reported,
 * which is what keeps the dot about the machines the user is *not* in.
 *
 * Never rejects, and never tells the screen which kind of "nothing" it found: a
 * 404 (the capability is not deployed there yet), a timeout, a truncated body and
 * an empty feed all mean no dot.
 *
 * @param {{ host: string, url: string }} entry the machine being read
 * @param {object} shellSession the session the request travels through
 * @param {number} watermark the watermark stored for that machine
 * @param {boolean} [watching] whether its workspace is the one on screen
 * @returns {Promise<{ unread: number, failed: number, latestNotice: object|null, latest: number }>} the row's facts
 */
async function readNoticeFeed(entry, shellSession, stored, watching = false) {
  // An entry that exists is a machine this client has read before, even when it reads
  // zero (a host that restarted leaves a zero behind). A machine with no entry at all is
  // one being met for the first time, and its history is a baseline rather than news.
  const known = stored !== undefined && stored !== null;
  const watermark = clampWatermark(stored);
  const read = (since) => readFeedBody(badgeUrl(entry.url, since), shellSession);
  let summary = summarizeFeed(await read(watermark), watermark);
  if (summary.reset) {
    // The host restarted, so its ids start over. Keeping the old number would hide
    // every run the new process records, which is the one failure a dot must not
    // have; the watermark means "what the user has seen", and against a new process
    // nobody has seen anything.
    forgetWatermark(entry.host);
    summary = summarizeFeed(await read(0), 0);
  }
  const decision = readDecision(summary, { watching: watching === true, known });
  // Both a machine the user is inside and one being met for the first time earn the
  // watermark: the first because they are looking at it, the second so its history cannot
  // be claimed as news a second time.
  if ((watching === true || decision.baseline) && decision.ackId > 0) {
    markSeen(entry.host, decision.ackId);
  }
  return {
    unread: decision.unread,
    failed: decision.failed,
    latestNotice: summary.latestNotice,
    latest: summary.latest,
  };
}

/**
 * This machine's own row, with its finished-run count.
 *
 * The row itself is built from facts the client already owns, so it needs no reachability
 * probe - but its badge comes from the same feed every other row's does. That means the
 * local machine has to be read through the shell's session exactly like a fleet machine;
 * otherwise the one machine a single-machine user always has would be the one machine
 * whose finished work is never reported.
 *
 * @param {{ machine: string, host: string, url: string }} row the row to read: the measured
 *   authority when one was found, the host-name guess otherwise
 * @returns {Promise<object>} the row, with `unread`, `latestNotice` and `latest`
 */
async function probeLocalEntry(row) {
  try {
    const summary = await readNoticeFeed(
      row,
      proxySession(),
      readWatermarks()[row.host],
      row.host === watchedHost(),
    );
    return {
      ...row,
      unread: summary.unread,
      unreadFailed: summary.failed,
      latestNotice: summary.latestNotice,
      latest: summary.latest,
    };
  } catch (error) {
    process.stderr.write(`shell: local feed read failed (${error?.message ?? error})\n`);
    return { ...row, unread: 0, unreadFailed: 0, latestNotice: null, latest: 0 };
  }
}

/** Reads the engine's peer table through the CLI, for the acceptance mode. */
function localPeers() {
  const binary = args.netbird || '/opt/homebrew/bin/netbird';
  const run = (extra) => spawnSync(binary, ['status', ...extra], { encoding: 'utf8', timeout: 20_000 }).stdout ?? '';
  const self = parseSelfStatus(run([]));
  const peers = parsePeers(run(['-d']));
  const addresses = peers.flatMap((peer) => [peer.ip, peer.ipv6]).filter(Boolean);
  const cloudDomain = self.fqdn ? self.fqdn.split('.').slice(1).join('.') : '';
  const cloud = cloudDomain !== '' && isCloudZone(cloudDomain);
  const records = peers
    .filter((peer) => peer.ip)
    .map((peer) => cloud
      ? { type: 1, name: peer.name, zone: cloudDomain, content: peer.ip }
      : { type: 1, name: `dsh.${peer.name}`, zone: FLEET_ZONES[0], content: peer.ip });
  const registry = buildRegistry(records, addresses, FLEET_ZONES, { cloud });
  return { self, entries: registry.entries };
}

/** The acceptance-mode snapshot, shaped exactly like the supervisor's. */
async function acceptanceSnapshot() {
  const { self, entries } = localPeers();
  const reachable = args.proxy ? await probeEntries(entries) : entries;
  return {
    state: reachable.length > 0 ? 'ready' : 'empty',
    detail: '验收模式:机器列表来自本机引擎的 peer 表',
    loginUrl: '',
    engine: null,
    self,
    registered: entries.length,
    entries: reachable,
    proxy: args.proxy,
    local: { ...localIdentity(), state: 'ready', detail: '' },
    fleet: { state: reachable.length > 0 ? 'ready' : 'empty', detail: '' },
    server: serverBlock(),
    kernel: null,
  };
}

/**
 * Scripted snapshots, for the interface check only.
 *
 * `--states` points at a JSON object keyed by state name. A refresh names the state
 * to show; every other read returns the same one. Selecting rather than advancing
 * is deliberate: the renderer polls while the agent is in a transient state, and a
 * sequence would depend on how often the screen happened to ask.
 */
function scriptedSnapshot(select) {
  if (!scriptedStates) {
    return null;
  }
  const names = Object.keys(scriptedStates);
  if (names.length === 0) {
    return null;
  }
  if (typeof select === 'string' && Object.prototype.hasOwnProperty.call(scriptedStates, select)) {
    scriptedSelected = select;
  }
  if (!scriptedSelected) {
    scriptedSelected = names[0];
  }
  return {
    engine: null,
    self: null,
    entries: [],
    registered: 0,
    proxy: '',
    loginUrl: '',
    detail: '',
    ...scriptedStates[scriptedSelected],
    state: scriptedSelected,
  };
}

/**
 * Publishes a snapshot: to the window that renders it, and to the acceptance run
 * that checks the screen and the agent agree.
 *
 * Pushing is what removed the polling loop from the renderer, which had already
 * produced two bugs - a screen that never left "starting" and a state check that
 * only passed because a poll happened to run.
 */
function publish(snapshot) {
  // Whatever snapshot reaches the window defines what a click can open. Setting this
  // only on the read path meant a list delivered by push was on screen while the
  // click handler consulted an older, empty one - the refusal that took a run to find.
  // `local` counts: a single-machine user has exactly the same list, without a network.
  if ((snapshot.state === 'ready' || snapshot.state === 'local') && Array.isArray(snapshot.entries)) {
    offeredEntries = snapshot.entries;
  }
  // Kept so a click can clear the opened machine's dot without re-probing the fleet.
  lastSnapshot = snapshot;
  // In scripted mode the supplied snapshot is authoritative, or the interface check
  // would depend on the machine it runs on. Everywhere else the real reading wins.
  if (!scriptedStates) {
    snapshot.kernel = kernelStatus;
  }
  // This window's own version and build travel with every snapshot: the diagnostics block
  // is where a person answers "which build am I looking at", and the acceptance runs read
  // the same pair off the seam instead of trusting a filename.
  snapshot.app = appIdentity();
  globalThis.__awSnapshot = {
    state: snapshot.state,
    entries: Array.isArray(snapshot.entries) ? snapshot.entries.length : 0,
    registered: snapshot.registered,
    hasLoginUrl: Boolean(snapshot.loginUrl),
    loginUrl: snapshot.loginUrl ?? '',
    update: updateStatus.action,
    version: snapshot.app.version,
    build: snapshot.app.build,
  };
  writeSeam();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('snapshot', snapshot);
  }
  applyAgentProxy(snapshot.proxy);
  // The proxy belongs to the engine: a reading that offers none means the engine that
  // owned it is gone, and leaving the rule in place would send every request into a dead
  // loopback port. The window would look broken instead of disconnected.
  if (shouldClearProxy({ applied: appliedProxy, next: snapshot.proxy }) && snapshot.state !== 'ready') {
    clearAgentProxy();
  }
  // A machine that leaves the list keeps its page for a while: a probe that timed out is
  // far more common than a machine that is gone, and destroying a page over a blip costs
  // the user their place. Only a sustained absence drops it.
  trackMissingWorkspaces(snapshot);
  if (snapshot.state !== 'ready' && snapshot.state !== 'local') {
    // The detail pane belongs to the state now: the workspace must not cover it.
    // `local` is not one of those states - a single-machine user's workspace is
    // exactly what the pane is for.
    hideWorkspace();
  }
  lastPublishedAt = Date.now();
  syncWindowChrome(snapshot);
  watchLogin(snapshot);
}

/**
 * Keeps the two surfaces that name the machine current with the reading.
 *
 * Both are written once by whoever opens a machine - the window title from the entry that
 * was clicked, the tray tooltip from a fixed string - so a renamed machine or a list that
 * went from "connected" to "nothing reachable" left them describing the moment they were
 * written. They are cheap strings, and this is the one place every reading passes through.
 *
 * @param {object} snapshot the reading just published
 */
function syncWindowChrome(snapshot) {
  const machine = activeWorkspace === ''
    ? ''
    : (Array.isArray(snapshot.entries) ? snapshot.entries : []).find((entry) => entry.host === activeWorkspace)?.machine ?? '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(machine === '' ? 'Anywhere Work' : `${machine} · DeepSeek Harness`);
  }
  if (tray) {
    const count = Array.isArray(snapshot.entries) ? snapshot.entries.length : 0;
    const label = snapshot.state === 'ready' || snapshot.state === 'local'
      ? `${count} 台可达`
      : snapshot.state === 'login-required' ? '需要登录' : '未连接';
    tray.setToolTip(`Anywhere Work · ${label}`);
  }
}

/**
 * Ages out resident pages of machines that have been missing from the list.
 *
 * The list only contains machines that answered a probe, so a momentary timeout makes a
 * machine disappear from it. Dropping the page on that first miss would throw away a
 * conversation over a network blip, so the miss is only recorded; the page goes once the
 * machine has been missing for longer than the grace window (`viewsToPrune`).
 *
 * @param {object} snapshot the reading just published
 */
function trackMissingWorkspaces(snapshot) {
  if (snapshot.state !== 'ready' && snapshot.state !== 'local') {
    return;
  }
  const known = (Array.isArray(snapshot.entries) ? snapshot.entries : []).map((entry) => entry.host);
  const knownSet = new Set(known);
  for (const host of workspaceViews.keys()) {
    if (knownSet.has(host)) {
      workspaceMissingSince.delete(host);
    } else if (!workspaceMissingSince.has(host)) {
      workspaceMissingSince.set(host, Date.now());
    }
  }
  const missingSince = Object.fromEntries(workspaceMissingSince);
  for (const host of viewsToPrune({ known, open: workspaceViews.keys(), missingSince, now: Date.now() })) {
    process.stderr.write(`shell: ${host} has been missing from the list; dropping its page\n`);
    if (activeWorkspace === host) {
      hideWorkspace();
    }
    workspaceMissingSince.delete(host);
    dropWorkspaceView(host);
  }
}

/**
 * While a sign-in is pending, the main process asks the engine whether it finished.
 * It belongs here rather than in the renderer: this side owns the engine.
 */
function watchLogin(snapshot) {
  const pending = snapshot.state === 'login-required' && supervisor && !scriptedStates;
  if (pending && !loginWatcher) {
    loginWatcher = setInterval(async () => {
      try {
        const result = await supervisor.loginStatus();
        // The engine's answer is a fleet reading, so it goes back through the whole
        // resolve: the window must never be handed a snapshot that lacks the local
        // half just because the news came from the network half.
        await currentSnapshot();
        if (result?.done) {
          stopLoginWatch();
        }
      } catch (error) {
        process.stderr.write(`shell: login check failed (${error.message})\n`);
      }
    }, 2_000);
    return;
  }
  if (!pending) {
    stopLoginWatch();
  }
}

function stopLoginWatch() {
  if (loginWatcher) {
    clearInterval(loginWatcher);
    loginWatcher = null;
  }
}

async function currentSnapshot(select) {
  // Reads are shared, not stacked. A heartbeat, a menu refresh and a click can all ask at
  // the same moment, and each read probes every machine: without this, three reads mean
  // three times the traffic and three publishes of the same truth in different orders.
  // Scripted mode is exempt because its argument selects a state, not just a moment.
  if (!scriptedStates && snapshotRead !== null) {
    return snapshotRead;
  }
  const read = readSnapshot(select);
  if (scriptedStates) {
    return read;
  }
  snapshotRead = read.finally(() => {
    snapshotRead = null;
  });
  return snapshotRead;
}

/** One uncached read of the machine list, published as it completes. */
async function readSnapshot(select) {
  // The whole point of scripted mode is that the check does not depend on the machine it
  // runs on: reading the kernel here would both slow the check down and re-publish its
  // own reading of this machine over the fixture.
  if (args.engine && !scriptedStates) {
    await readKernelStatus();
  }
  const snapshot = await resolveSnapshot(select);
  publish(snapshot);
  return snapshot;
}

async function resolveSnapshot(select) {
  const scripted = scriptedSnapshot(select);
  if (scripted) {
    return scripted;
  }
  if (!args.engine) {
    // The acceptance seam: an agent is already running and this machine's own host
    // is not this process's business. `local` is reported ready so the list keeps
    // its shape without the client touching anything on the machine.
    return acceptanceSnapshot();
  }
  if (supervisor === null && localState === 'checking') {
    // Nothing has been prepared yet: the first frame says so rather than claiming a
    // state the client has not reached.
    return {
      state: 'provisioning',
      detail: '',
      loginUrl: '',
      engine: null,
      self: null,
      registered: 0,
      entries: [],
      proxy: '',
      local: localBlock(),
      fleet: { state: 'off', detail: '' },
      server: serverBlock(),
      kernel: kernelStatus,
    };
  }
  // The fleet half. `off` until the user asks for it: the private network is an
  // addition, so an account is never required to use the machine in front of you.
  const fleetSnapshot = supervisor ? supervisor.snapshot() : null;
  // "Asked for it but has nowhere to dial" is the sign-in screen with the server field
  // in place of the sign-in buttons: the user has to supply an address before this
  // install can enroll, and pretending the engine is working on it would be a lie.
  const fleetState = fleetSnapshot ? fleetSnapshot.state : fleetNeedsServer ? 'login-required' : 'off';
  const fleetDetail = fleetSnapshot ? fleetSnapshot.detail : fleetNeedsServer ? '还没有服务器地址' : '';
  // This machine's identity, decided by address and not by name: a fleet row is a record
  // pointing at an overlay address, and the records that point at one of this machine's
  // addresses are this machine - every one of them, however it is named. Names cannot
  // settle this (one machine holds a name per client that enrolled it), addresses can.
  const fleetSelf = fleetSnapshot?.self ?? null;
  const fallbackIdentity = localIdentity();
  const registeredEntries = Array.isArray(fleetSnapshot?.entries) ? fleetSnapshot.entries : [];
  const { local: measuredLocal, fleet: fleetRows } = localRowsFrom(
    registeredEntries,
    localAddresses(fleetSelf),
    loopbackUrl(),
  );
  const fleetEntryRows = fleetState === 'ready' ? await probeEntries(fleetRows) : [];
  const local = localState === 'ready' ? await probeLocalEntry(measuredLocal ?? localEntry(fallbackIdentity)) : null;
  const entries = mergeEntries(local, fleetEntryRows);
  const state = uiState(localState, fleetState);
  // The local block names the machine the list names: whichever authority was measured,
  // or the host name while no fleet has answered for it yet. Only the name and the
  // authority travel - the measured row's socket address is loopback, which is not this
  // machine's address in the fleet.
  const identity = measuredLocal
    ? { machine: measuredLocal.machine, host: measuredLocal.host, url: measuredLocal.url }
    : fallbackIdentity;
  return {
    state,
    detail: fleetDetail,
    loginUrl: fleetSnapshot ? fleetSnapshot.loginUrl : '',
    engine: fleetSnapshot ? fleetSnapshot.engine : null,
    self: fleetSelf,
    registered: fleetSnapshot ? fleetSnapshot.registered : entries.length,
    entries,
    proxy: fleetSnapshot ? fleetSnapshot.proxy : '',
    local: localBlock(identity),
    fleet: { state: fleetState, detail: fleetDetail },
    server: serverBlock(),
    kernel: kernelStatus,
  };
}

/**
 * The embedded workspace.
 *
 * A workspace is a native view placed over the detail pane, not a second window: the
 * user keeps one frame, the sidebar keeps the list, and switching machines is a swap
 * rather than window management. Views are kept per machine, so switching back is
 * instant - the page is still loaded.
 */
const workspaceViews = new Map();
/**
 * When each machine's page last stopped being visible.
 *
 * A resident page keeps the snapshot it had when its update socket died, and
 * nothing else in this process reloads it. Recording when it went off screen is what
 * lets `showWorkspace` tell "this page was being watched a moment ago" from "this
 * page has been painting the same frozen list for an hour" (see `src/view-freshness.mjs`).
 */
const workspaceHiddenSince = new Map();
/** When each machine was first missing from the list, so a blip does not drop its page. */
const workspaceMissingSince = new Map();
let activeWorkspace = '';
let detailRect = null;

/** Creates (or reuses) the view for one machine. */
function workspaceViewFor(entry) {
  const existing = workspaceViews.get(entry.host);
  if (existing) {
    return existing;
  }
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false },
  });
  view.setBackgroundColor(windowBackground());
  // A navigation that fails inside the view would otherwise be invisible.
  view.webContents.on('did-fail-load', (_event, code, description, url) => {
    process.stderr.write(`shell: workspace did-fail-load ${url} code=${code} ${description}\n`);
    mainWindow?.webContents.send('workspace-failed', { host: entry.host, reason: `${description} (${code})` });
  });
  workspaceViews.set(entry.host, view);
  return view;
}

function applyDetailBounds() {
  if (activeWorkspace === '' || detailRect === null) {
    return;
  }
  const view = workspaceViews.get(activeWorkspace);
  if (view) {
    view.setBounds(detailRect);
  }
}

/**
 * Shows one machine's workspace in the detail pane. Empty host hides it.
 *
 * `fresh` is the new-session entry: the machine's own front door is loaded again, so the
 * page starts at the screen where a conversation begins rather than wherever it was left.
 * An explicit refresh reloads the page too, but keeps its route; only this entry sends the
 * page back to the front door.
 *
 * @param {string} host the machine's canonical host, or '' to put the pane away
 * @param {{ fresh?: boolean }} [options]
 */
async function showWorkspace(host, options = {}) {
  // Moving to another machine is leaving this one: whatever finished while this one's
  // workspace was on screen was watched, so it must be recorded as seen before the row
  // becomes one of the machines the user is no longer in. Going home is the same move,
  // and `hideWorkspace` owns that half.
  if (host !== '' && activeWorkspace !== '' && host !== activeWorkspace) {
    acknowledgeWatched();
  }
  if (host === '') {
    hideWorkspace();
    return { ok: true, host: '' };
  }
  const entry = offeredEntries.find((candidate) => candidate.host === host);
  process.stderr.write(`shell: select ${host} -> ${entry ? 'found' : `refused (offered ${offeredEntries.length})`}\n`);
  if (!entry) {
    // Never a silent no-op: the renderer shows this back to the user.
    hideWorkspace();
    return { ok: false, host, reason: '这台机器现在没有应答,列表已刷新' };
  }
  // Opening a machine is looking at it: everything the host holds has now been seen.
  // The watermark moves to the feed's own newest id, not to the newest notice in the
  // page that happened to be read - a page's worth per look is what left a number that
  // never reached zero.
  markSeen(host, ackIdOf(entry));
  if (entry.unread > 0) {
    entry.unread = 0;
    entry.latestNotice = null;
    // The dot lives in the list the window already has, so re-publishing that same
    // snapshot clears it now instead of at the next refresh. `local` counts as much as
    // `ready`: a single-machine user's list is the one this matters most for, and
    // refreshing only the fleet case left their dot on screen after it was cleared.
    if (lastSnapshot?.state === 'ready' || lastSnapshot?.state === 'local') {
      publish(lastSnapshot);
    }
  }
  const previous = activeWorkspace === '' ? null : workspaceViews.get(activeWorkspace);
  if (previous) {
    previous.setVisible(false);
    workspaceHiddenSince.set(activeWorkspace, Date.now());
  }
  const view = workspaceViewFor(entry);
  if (!mainWindow.contentView.children.includes(view)) {
    mainWindow.contentView.addChildView(view);
  }
  activeWorkspace = host;
  applyDetailBounds();
  view.setVisible(true);
  writeSeam();
  // The acceptance run captures this view's page: a native view is not part of the
  // renderer's screenshot, so the seam is how the embedded workspace can be evidenced.
  globalThis.__awWorkspace = view;
  // A resident page only looks current. Its updates arrive over the machine's own
  // update socket, so any interruption - a sleep, a network switch, the engine
  // reconnecting, the host restarting its workspace - leaves it painting the snapshot
  // it had at that moment, and nothing else in this process replaces that snapshot.
  // A page that was off screen long enough for its socket to have died is therefore
  // reloaded rather than shown; reloading keeps the page's own route, so the
  // conversation the user was in is the one they come back to. `fresh` (the
  // new-session entry) instead loads the machine's front door, which is the screen a
  // conversation starts on.
  const pageAction = workspacePageAction({
    hasPage: view.webContents.getURL() !== '',
    fresh: options.fresh === true,
    hiddenSince: workspaceHiddenSince.get(host) ?? null,
    now: Date.now(),
  });
  workspaceHiddenSince.delete(host);
  if (pageAction !== 'reuse') {
    try {
      if (pageAction === 'reload') {
        // The one line that makes "the page was stale and we replaced it" visible in the
        // log, next to the explicit-refresh and wake lines.
        process.stderr.write(`shell: reloading ${host} after being off screen\n`);
        view.webContents.reload();
      } else {
        // `loadURL` lives on webContents, not on the view wrapper.
        await view.webContents.loadURL(entry.url);
      }
    } catch (error) {
      // A workspace that will not load is a failure the user must see, not a pane
      // that stays quietly blank.
      const reason = String(error?.message ?? error);
      process.stderr.write(`shell: workspace failed to load ${entry.url} (${reason})\n`);
      mainWindow?.webContents.send('workspace-failed', { host, reason });
    }
  }
  mainWindow.setTitle(`${entry.machine} · DeepSeek Harness`);
  return { ok: true, host, machine: entry.machine, url: entry.url };
}

/**
 * Records that everything the machine the user is leaving has finished is looked at.
 *
 * It re-reads instead of trusting the last snapshot, because work that finished since
 * that read happened while the workspace was on screen - exactly the work that must not
 * come back as a dot on the row the user is moving away from.
 *
 * The write is forward-only, so a slow machine can only delay this, never lose it; the
 * click that caused it is not made to wait on a network read.
 */
function acknowledgeWatched() {
  const host = activeWorkspace;
  if (host === '') {
    return;
  }
  const entry = offeredEntries.find((candidate) => candidate.host === host);
  if (!entry) {
    return;
  }
  readNoticeFeed(entry, proxySession(), readWatermarks()[host], true).catch((error) => {
    process.stderr.write(`shell: leaving ${host} was not recorded (${error?.message ?? error})\n`);
  });
}

function hideWorkspace() {
  acknowledgeWatched();
  if (activeWorkspace !== '') {
    workspaceViews.get(activeWorkspace)?.setVisible(false);
    workspaceHiddenSince.set(activeWorkspace, Date.now());
  }
  activeWorkspace = '';
  globalThis.__awWorkspace = null;
  writeSeam();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle('Anywhere Work');
  }
}

/** Destroys one cached view, for when a machine leaves the list for good. */
function dropWorkspaceView(host) {
  const view = workspaceViews.get(host);
  if (!view) {
    return;
  }
  if (activeWorkspace === host) {
    activeWorkspace = '';
  }
  mainWindow?.contentView.removeChildView(view);
  view.webContents.close();
  workspaceViews.delete(host);
  workspaceHiddenSince.delete(host);
}

/**
 * Reloads the page that is on screen, keeping its route.
 *
 * Refresh is the user's own answer to a screen that looks stuck, and a resident page
 * that has lost its update socket looks exactly like one that is merely idle: the
 * machine list around it is fine, so only the page itself can be replaced. Reloading
 * the page the view already has also keeps the route, so the conversation stays open.
 *
 * @returns {boolean} whether a page was reloaded
 */
function reloadActiveWorkspace() {
  if (activeWorkspace === '') {
    return false;
  }
  const view = workspaceViews.get(activeWorkspace);
  if (!view || !shouldReloadOnRefresh({ hasPage: view.webContents.getURL() !== '' })) {
    return false;
  }
  process.stderr.write(`shell: reloading ${activeWorkspace} for an explicit refresh\n`);
  view.webContents.reload();
  return true;
}

/**
 * The tray is deliberately thin: connection state, open the list, quit. Anything
 * more would be a second place to look for the same information.
 */
function installTray() {
  try {
    // The brand's mark, built at packaging time as a template image so the menu bar tints
    // it for either appearance. The inline fallback keeps a development run working.
    const markPath = join(process.resourcesPath ?? HERE, 'trayTemplate.png');
    const mark = existsSync(markPath) ? nativeImage.createFromPath(markPath) : nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    if (existsSync(markPath) && process.platform === 'darwin') {
      mark.setTemplateImage(true);
    }
    tray = new Tray(mark);
    tray.setToolTip('Anywhere Work');
    const menu = () => {
      const snapshot = lastSnapshot;
      return Menu.buildFromTemplate([
        { label: snapshot ? `状态:${snapshot.state}` : '状态:正在启动', enabled: false },
        { type: 'separator' },
        { label: '打开机器列表', click: () => mainWindow?.show() },
        {
          label: '刷新',
          click: () => refreshAgent().then(() => {
            reloadActiveWorkspace();
            mainWindow?.webContents.send('refresh');
          }),
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ]);
    };
    tray.on('right-click', () => tray.popUpContextMenu(menu()));
    tray.on('click', () => mainWindow?.show());
    tray.setContextMenu(menu());
  } catch (error) {
    process.stderr.write(`shell: tray unavailable (${error.message})\n`);
  }
}

/**
 * Applies an appearance choice and tells the window.
 *
 * One path for both the toolbar popup and the View menu, so the two can never disagree
 * about what is selected.
 */
function applyScheme(choice) {
  schemeChoice = ['light', 'dark'].includes(choice) ? choice : 'system';
  nativeTheme.themeSource = schemeChoice;
  writeSettings({ ...readSettings(), scheme: schemeChoice });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(windowBackground());
    mainWindow.webContents.send('scheme-changed', {
      scheme: schemeChoice === 'system' ? '' : schemeChoice,
      label: schemeLabel(),
    });
  }
  return { scheme: schemeChoice === 'system' ? '' : schemeChoice, label: schemeLabel() };
}

/**
 * The application menu.
 *
 * Refresh, the sidebar and appearance belong here, with their shortcuts: a toolbar
 * that prints its own shortcuts is a web page wearing a window frame, and a menu is
 * where a Mac user looks for them.
 */
function installAppMenu() {
  const appearanceItems = [
    ['跟随系统', 'system'],
    ['浅色', 'light'],
    ['深色', 'dark'],
  ].map(([label, value]) => ({
    label,
    type: 'radio',
    checked: schemeChoice === value,
    click: () => applyScheme(value),
  }));

  // Roles that exist on one platform only. A menu item that looks actionable and
  // does nothing is a defect on Windows, not a cosmetic difference: `hideOthers`,
  // `unhide`, `front` and `zoom` are macOS-specific, and Electron leaves them as
  // dead entries elsewhere.
  const isMac = process.platform === 'darwin';
  const appMenuExtras = isMac
    ? [
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
      ]
    : [];
  const windowMenuItems = isMac
    ? [
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ]
    : [{ role: 'close', label: '关闭' }];
  const template = [
    {
      // macOS owns an application menu named after the app; Windows expects a File
      // menu and shows it inside the window.
      label: isMac ? 'Anywhere Work' : '文件',
      submenu: [
        { role: 'about', label: '关于 Anywhere Work' },
        { type: 'separator' },
        ...appMenuExtras,
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '刷新',
          accelerator: 'CommandOrControl+R',
          click: () => {
            // Refresh also replaces the page that is on screen: the list around it can be
            // current while the page itself is frozen at a dead update socket.
            refreshAgent().then(() => {
              reloadActiveWorkspace();
              mainWindow?.webContents.send('refreshed');
            });
          },
        },
        {
          label: '搜索机器',
          accelerator: 'CommandOrControl+F',
          click: () => mainWindow?.webContents.send('focus-search'),
        },
        {
          label: '显示或隐藏侧栏',
          accelerator: 'CommandOrControl+Alt+S',
          click: () => mainWindow?.webContents.send('toggle-sidebar'),
        },
        {
          // The address is a setting, so it has a home in the menu as well as on the panels
          // that name it: a person who cannot reach the sign-in screen can still change it.
          label: '设置服务器地址…',
          click: () => mainWindow?.webContents.send('open-server-field'),
        },
        { type: 'separator' },
        { label: '外观', submenu: appearanceItems },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, ...windowMenuItems],
    },
    {
      label: '帮助',
      role: 'help',
      submenu: [
        {
          label: '复制诊断信息',
          click: () => {
            const snapshot = lastSnapshot;
            clipboard.writeText(JSON.stringify({ state: snapshot?.state, detail: snapshot?.detail, local: snapshot?.local, fleet: snapshot?.fleet, proxy: snapshot?.proxy, kernel: kernelStatus }, null, 2));
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    title: 'Anywhere Work',
    backgroundColor: windowBackground(),
    // macOS floats its window controls over the content, so the toolbar is inset and
    // the controls are positioned inside it. Windows draws a frame and a title bar,
    // where both options are ignored - asking for them there is how a window ends up
    // with no way to move or close it.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : {}),
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(HERE, 'preload.cjs'),
    },
  });
  mainWindow.loadFile(join(HERE, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Brings the engine up (or back up) and returns the resulting snapshot. */
async function refreshAgent(select) {
  if (scriptedStates) {
    return currentSnapshot(select);
  }
  if (select === 'connect') {
    return connectFleet();
  }
  if (select === 'disconnect') {
    return disconnectFleet();
  }
  // An explicit refresh is the user's answer to a screen that looks stuck, so it must not
  // repeat a cached kernel reading: the cache is 30 seconds old at most, and "still the
  // same failure" is exactly the answer a person already rejected by pressing refresh.
  if (select === undefined && args.engine) {
    await readKernelStatus(true);
  }
  // Every read goes through currentSnapshot: it is what attaches the kernel
  // reading and publishes, so a path that returns a snapshot directly is a path
  // whose screen silently lacks both.
  if (!args.engine) {
    return currentSnapshot();
  }
  if (localState !== 'ready') {
    // The local host is the product's floor: refresh is the documented way out of a
    // failed install, so it re-runs the sequence rather than reporting the failure
    // again.
    await prepareLocal();
    return currentSnapshot();
  }
  if (!supervisor) {
    return currentSnapshot();
  }
  const fleet = supervisor.snapshot().state;
  // A settled screen re-reads: what changes is whether the machines answer, not the
  // engine link. A fleet that is off, failed or empty is the one case a refresh
  // should actually drive the link again.
  if (fleet === 'ready' || fleet === 'connecting') {
    return currentSnapshot();
  }
  await supervisor.connect();
  return currentSnapshot();
}

/**
 * Turns the private network on, because the user asked for their other machines.
 *
 * This is the only path that starts the engine. It is deliberately not part of
 * launch: an account is what the *second* machine needs, and a client that demands
 * one before showing the machine it is running on has its priorities backwards.
 */
async function connectFleet(origin = 'user') {
  if (currentEndpoint().url === '') {
    // Nothing to dial. Starting the engine against a name that does not resolve is what
    // turned "I want my other machines" into a minute of "connecting" and an English
    // error that never mentioned the server; asking for the address is the honest answer.
    fleetNeedsServer = true;
    process.stderr.write('shell: the fleet was requested with no address to enroll against\n');
    return currentSnapshot();
  }
  fleetNeedsServer = false;
  if (!supervisor) {
    supervisor = startSupervisor();
    process.stderr.write(
      origin === 'restore'
        ? 'shell: fleet link restored from the choice this install left on\n'
        : 'shell: fleet link requested by the user\n',
    );
    await supervisor.begin();
    rememberFleetLink();
    return currentSnapshot();
  }
  await supervisor.connect();
  rememberFleetLink();
  return currentSnapshot();
}

/**
 * Records that the user's fleet request produced a link, so the next launch can restore it.
 *
 * Only a link that is actually up is remembered: a request that stopped at a sign-in or at
 * an error must not turn every later launch into a dial-up the user has to cancel.
 */
function rememberFleetLink() {
  const state = supervisor?.snapshot().state;
  if (state !== 'ready' && state !== 'empty') {
    return;
  }
  writeSettings(withFleetIntent(readSettings(), true));
}

/**
 * Turns the private network back off, because the user declined or is done with it.
 *
 * The client is not allowed to have a one-way door here: the sign-in is an addition,
 * so abandoning it has to leave the machine in front of the user fully usable. The
 * engine is stopped and the session's proxy cleared, which is what returns the window
 * to the ordinary single-machine state.
 */
async function disconnectFleet() {
  stopLoginWatch();
  // Turning the network off is a choice like turning it on: the next launch stays local
  // until the user asks again.
  writeSettings(withFleetIntent(readSettings(), false));
  // The request is withdrawn, so the "no address yet" screen goes with it: the window
  // returns to the ordinary single-machine state rather than to a question nobody asked.
  fleetNeedsServer = false;
  // The window's state is decided from this variable, so it is cleared before anything
  // waits: the screen moves back to this machine first, and the engine is stopped
  // afterwards. A stop that blocks - the engine can be mid-sign-in, and "暂不登录" is
  // exactly what a person presses then - must not hold the window on a screen they left.
  const dying = supervisor;
  supervisor = null;
  offeredEntries = [];
  if (appliedProxy !== '') {
    appliedProxy = '';
    try {
      await proxySession().setProxy({ mode: 'direct' });
    } catch (error) {
      process.stderr.write(`shell: session proxy could not be cleared (${error?.message ?? error})\n`);
    }
  }
  process.stderr.write('shell: fleet link refused by the user\n');
  const snapshot = await currentSnapshot();
  if (dying) {
    void dying.stop().catch(() => undefined);
  }
  return snapshot;
}

/**
 * Records the address the user typed, and points the engine at it.
 *
 * This is the way out of a wrong or missing address, and it is the same surface the
 * mobile client gives: the value is the user's own choice from then on, so it outranks
 * the package default and no channel document can move it. An engine already dialling
 * the old address is stopped first - it is started with the address it enrolls against,
 * so a change is a restart rather than a setting.
 *
 * @param {unknown} value what the field handed over
 * @returns {Promise<{ ok: boolean, reason?: string, server?: object }>}
 */
async function applyServerAddress(value) {
  const url = normalizeEndpoint(value);
  if (url !== '' && !endpointIsUsable(url)) {
    return { ok: false, reason: '请填完整地址,例如 https://netbird.example.com:443' };
  }
  writeSettings({ ...readSettings(), server: { url } });
  if (supervisor) {
    // The engine is started with the address it enrolls against, so changing the address is
    // a restart: the refusal hands the screen back and clears the proxy, and this path is
    // the one place that then waits for the old engine to be gone, so two engines never
    // race for the sign-in callback port.
    const previous = supervisor;
    await disconnectFleet();
    await previous.stop();
  }
  if (url === '') {
    fleetNeedsServer = true;
    process.stderr.write('shell: the server address was cleared\n');
    return { ok: true, server: serverBlock() };
  }
  process.stderr.write('shell: the server address was set by the user\n');
  await connectFleet();
  return { ok: true, server: serverBlock() };
}

/**
 * The engine process this window owns, so a crash can be answered with a restart.
 *
 * The supervisor's last snapshot otherwise keeps saying "connected": it is a record of
 * what the engine said, and a dead engine says nothing at all.
 */
let engineClient = null;
/** Set while the app is quitting, so the helper's exit is not read as a crash. */
let quitting = false;
/** Recent crash recoveries, so an engine that keeps dying is not restarted forever. */
const engineRecoveries = [];
const ENGINE_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const ENGINE_RECOVERY_LIMIT = 3;

/**
 * Answers an engine that exited on its own with one restart.
 *
 * A helper can die for reasons the app cannot influence (an OOM kill, a crash in the
 * overlay engine), and the fleet link is the only reason this window has a network at
 * all. Restarting once is the difference between "the other machines stopped working"
 * and "the app healed itself"; the window is bounded so a helper that dies on every start
 * cannot turn into a restart loop, and it is skipped entirely when the user turned the
 * link off or is quitting, because a dead helper is the expected end of both.
 */
async function recoverEngine() {
  if (!supervisor || quitting) {
    return;
  }
  const now = Date.now();
  while (engineRecoveries.length > 0 && now - engineRecoveries[0] > ENGINE_RECOVERY_WINDOW_MS) {
    engineRecoveries.shift();
  }
  engineRecoveries.push(now);
  if (engineRecoveries.length > ENGINE_RECOVERY_LIMIT) {
    process.stderr.write('shell: the engine keeps exiting; leaving the fleet link down rather than restarting it again\n');
    await currentSnapshot().catch(() => undefined);
    return;
  }
  process.stderr.write('shell: the engine exited on its own; starting a fresh one\n');
  try {
    await engineClient?.restart();
    await supervisor.connect();
  } catch (error) {
    process.stderr.write(`shell: the engine could not be started again (${error?.message ?? error})\n`);
  }
  await currentSnapshot().catch((error) => {
    process.stderr.write(`shell: the list could not be re-read after the engine came back (${error?.message ?? error})\n`);
  });
}

function startSupervisor() {
  const configPath = join(args.dir, 'config.json');
  // Logged because two sources exist (the bundle and the developer cache) and
  // "which one is the app actually running" must be answerable from the log.
  const binary = resolveHelper();
  process.stderr.write(`shell: engine binary ${binary}\n`);
  const client = new TunnelClient({
    binary,
    onExit: () => {
      // Bookkeeping is already done by the client: a restart here starts from no child.
      void recoverEngine();
    },
    onStderr: (line) => {
      if (/error|failed|level=warning/i.test(line)) {
        process.stderr.write(`[engine] ${line}\n`);
      }
    },
  });
  engineClient = client;
  client.start();
  return createSupervisor({
    engine: client,
    paths: { config: configPath, state: join(args.dir, 'state.json') },
    managementUrl: currentEndpoint().url,
    deviceName: 'anywhere-shell',
    configExists: () => existsSync(configPath),
    contract: readContract(),
    setupKey: args.setupKey,
    // The window renders from these; without them a state the agent reaches on its
    // own would never reach the screen. It goes through the full resolve rather than
    // publishing the engine's own snapshot, which carries only the fleet half.
    onState: () => {
      void currentSnapshot();
    },
    log: (line) => process.stderr.write(`[agent] ${line}\n`),
  });
}

ipcMain.handle('state', async () => currentSnapshot());
ipcMain.handle('refresh', async (_event, select) => {
  const snapshot = await refreshAgent(select);
  // A plain refresh means "bring this screen up to date". It is not a connection
  // command, so it also replaces the workspace page: the machine list can be current
  // while the page is frozen at a dead update socket.
  if (select === undefined || select === null || select === '') {
    reloadActiveWorkspace();
  }
  return snapshot;
});
ipcMain.handle('login-status', async () => (supervisor ? supervisor.loginStatus() : { done: false, state: await currentSnapshot() }));
/**
 * A sign-in link that works when it is used.
 *
 * The displayed link may be minutes old and the engine stops listening for the
 * callback after a few, so the click asks for a fresh one instead of opening what is
 * on screen. Nothing else about the agent is touched.
 */
ipcMain.handle('fresh-login', async () => {
  if (!supervisor) {
    return { ok: false, reason: '还没有连接需求,无需登录' };
  }
  await supervisor.relogin();
  // The engine's own snapshot carries the fleet half only, so the window is handed
  // the resolved one; the link is read from the same place the panel would.
  const snapshot = await currentSnapshot();
  const url = snapshot?.loginUrl ?? '';
  return url === '' ? { ok: false, reason: snapshot?.detail || '登录链接没有生成' } : { ok: true, url };
});

/**
 * The address field's one command.
 *
 * It answers with the facts the window shows, so a rejected value can say why instead of
 * leaving the field looking accepted.
 */
ipcMain.handle('set-server', async (_event, value) => applyServerAddress(value));

ipcMain.handle('select-machine', async (_event, host) => showWorkspace(String(host ?? '')));
// The rail's new-session entry: the same machine, loaded at its own front door.
ipcMain.handle('new-session', async (_event, host) => showWorkspace(String(host ?? ''), { fresh: true }));
// The one place a missing runtime is answered: a command in the person's own terminal.
ipcMain.handle('run-installer', () => runInstallerInTerminal(localCommand));

// The renderer owns the layout, so it reports where the detail pane is; the native
// view is placed there and re-placed whenever that changes.
ipcMain.on('detail-bounds', (_event, rect) => {
  if (!rect || typeof rect !== 'object') {
    return;
  }
  detailRect = {
    x: Math.round(Number(rect.x) || 0),
    y: Math.round(Number(rect.y) || 0),
    width: Math.max(0, Math.round(Number(rect.width) || 0)),
    height: Math.max(0, Math.round(Number(rect.height) || 0)),
  };
  applyDetailBounds();
});

ipcMain.on('sidebar', (_event, visible) => {
  // The pane moves when the sidebar folds, so the view has to be told.
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sidebar', Boolean(visible));
  }
});

/**
 * Hands one URL to the platform's browser, once.
 *
 * A press repeated while the link is still being minted resolves to the same hand-off, and
 * opening it once per press is how several tabs appeared for one intent. The guard is
 * short-lived, so asking for the same address again later is still a new decision.
 */
const openedExternally = new Map();
const OPEN_EXTERNAL_WINDOW_MS = 10_000;
ipcMain.handle('open-external', async (_event, value) => {
  const url = String(value ?? '');
  const now = Date.now();
  for (const [opened, at] of openedExternally) {
    if (now - at > OPEN_EXTERNAL_WINDOW_MS) {
      openedExternally.delete(opened);
    }
  }
  if (openedExternally.has(url)) {
    process.stderr.write('shell: the same sign-in link was already handed to the browser\n');
    return { opened: false, reason: 'already-open' };
  }
  openedExternally.set(url, now);
  await electronShell.openExternal(url);
  return { opened: true };
});
ipcMain.handle('scheme', () => ({ scheme: schemeChoice === 'system' ? '' : schemeChoice, label: schemeLabel() }));
ipcMain.on('appearance-menu', () => {
  const menu = Menu.buildFromTemplate(
    [
      ['跟随系统', 'system'],
      ['浅色', 'light'],
      ['深色', 'dark'],
    ].map(([label, value]) => ({
      label,
      type: 'radio',
      checked: schemeChoice === value,
      click: () => applyScheme(value),
    })),
  );
  menu.popup({ window: mainWindow ?? undefined });
});

function schemeLabel() {
  if (schemeChoice === 'light') {
    return '浅色';
  }
  if (schemeChoice === 'dark') {
    return '深色';
  }
  return '跟随系统';
}

let updateStatus = { action: 'none', reason: 'not checked yet' };
/** When the channel was last asked; the heartbeat re-asks once this ages. */
let updateCheckedAt = 0;

/**
 * Asks the update channel what this build should be.
 *
 * The policy lives in src/update.mjs and is unit-tested; this only supplies the
 * facts and records the answer. An empty channel in the version contract means the
 * product has no channel yet, and then nothing is requested at all.
 */
async function checkUpdateChannel() {
  const contract = readContract();
  const channel = contract?.update?.channel ?? '';
  // Recorded before the request: a channel that answers with an error is still an
  // answer, and retrying it every tick would turn a dead channel into a request loop.
  updateCheckedAt = Date.now();
  try {
    const { checkForUpdate } = await import('../src/update.mjs');
    updateStatus = await checkForUpdate({
      channel,
      current: contract?.shell ?? '0.0.0',
      protocol: Number(contract?.protocol ?? 0),
    });
  } catch (error) {
    updateStatus = { action: 'error', reason: String(error?.message ?? error) };
  }
  process.stderr.write(`shell: update ${updateStatus.action} (${updateStatus.reason})\n`);
  return updateStatus;
}

// One instance per user. Two copies would fight over the same profile and start two
// engines, and a tray app has no way for a user to tell them apart.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  // A packaged app keeps its state where macOS expects it; a checkout keeps it in
  // the directory the developer passed.
  if (!args.dir) {
    args.dir = app.getPath('userData');
  }
  // The theme is remembered across restarts; the window is themed before it is
  // shown so there is no flash of the wrong scheme.
  const stored = readSettings();
  schemeChoice = ['light', 'dark'].includes(stored.scheme) ? stored.scheme : 'system';
  nativeTheme.themeSource = schemeChoice;

  // The kernel reading is filled in by the first snapshot; nothing waits on it.
  // The update check runs after the window is up, never before it: a slow or dead
  // channel must not delay the screen. Installing is a separate, deliberate step
  // that needs a signed app, so this only records what the channel says.
  void checkUpdateChannel();
  // The channel document is only consulted when this install has nothing to dial, and it
  // never gates the screen: a machine with no address shows the field while the fetch is
  // still in flight.
  void discoverChannelEndpoint();

  if (args.states) {
    try {
      scriptedStates = JSON.parse(readFileSync(args.states, 'utf8'));
    } catch (error) {
      process.stderr.write(`shell: could not read --states (${error.message})\n`);
    }
  }
  // The window comes first, always. The agent (and the proxy it will hand out)
  // may take seconds or fail outright, and the user must never stare at nothing
  // while that happens: they get a screen that says which layer is working,
  // updated by the renderer's own polling.
  createMainWindow();
  // The Dock tile is set from the bundle's own artwork at every launch. Icon caches keyed
  // by bundle id can keep serving an old image after the app is replaced - and a stale Dock
  // icon is exactly the kind of thing a user is right to call out, because the icon is where
  // the brand actually lives on macOS.
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = join(process.resourcesPath ?? HERE, 'AppIcon.png');
    if (existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
      process.stderr.write('shell: dock icon set from AppIcon.png\n');
    } else {
      process.stderr.write('shell: dock icon art missing; the bundle icon applies\n');
    }
  }

  installAppMenu();
  installTray();

  // Sleeping takes the page's update socket with it, and nothing on screen re-subscribes
  // on wake: without this, the window keeps painting whatever it had before the lid
  // closed. Only a machine that was actually asleep invalidates the page - a display
  // sleep or a brief suspend leaves it alone, and an unsent draft with it.
  let suspendedAt = 0;
  powerMonitor.on('suspend', () => {
    suspendedAt = Date.now();
  });
  powerMonitor.on('resume', () => {
    const suspendedMs = suspendedAt === 0 ? 0 : Date.now() - suspendedAt;
    suspendedAt = 0;
    // The machine list is as stale as the page: reachability, unseen work and the engine
    // link all changed while this process was suspended, and none of them is pushed.
    if (!scriptedStates) {
      void currentSnapshot().catch((error) => {
        process.stderr.write(`shell: the list could not be re-read after wake (${error?.message ?? error})\n`);
      });
    }
    if (activeWorkspace === '') {
      return;
    }
    const view = workspaceViews.get(activeWorkspace);
    if (!view || !shouldReloadOnWake({ hasPage: view.webContents.getURL() !== '', suspendedMs })) {
      return;
    }
    process.stderr.write(`shell: reloading ${activeWorkspace} after ${Math.round(suspendedMs / 1000)}s asleep\n`);
    view.webContents.reload();
  });

  // The machine list's three answers are not pushed by anything, so without a heartbeat
  // the screen keeps the answer it got at launch: a machine that finished work while the
  // window sat open never grows a dot, one that went away still looks reachable, and an
  // engine that died still reports "connected". The tick only decides; the read happens
  // once the last reading is older than the interval, which tightens when the window is
  // on screen: probes cost two requests per machine, and a hidden window can wait.
  let heartbeatTimer = null;
  let snapshotInFlight = false;
  const heartbeatTick = async () => {
    const windowUp = Boolean(mainWindow && !mainWindow.isDestroyed());
    const visible = windowUp ? mainWindow.isVisible() : false;
    const interval = snapshotHeartbeatMs({ visible });
    if (windowUp) {
      // A tray app can stay open for weeks, so "this build is up to date" is an answer
      // about the morning it launched unless the channel is asked again.
      if (updateCheckDue({ lastCheckedAt: updateCheckedAt, now: Date.now() })) {
        void checkUpdateChannel();
      }
      // A launch-time read can lose the race with the network; while nothing is dialable,
      // the channel document is worth one more look a minute.
      if (shouldRetryEndpointDiscovery({ hasEndpoint: currentEndpoint().url !== '', lastAttemptAt: channelReadAt, now: Date.now() })) {
        void retryChannelEndpoint();
      }
      if (!snapshotInFlight && shouldReadSnapshotOnHeartbeat({ lastReadAt: lastPublishedAt, now: Date.now(), heartbeatMs: interval })) {
        snapshotInFlight = true;
        try {
          await currentSnapshot();
        } catch (error) {
          process.stderr.write(`shell: heartbeat read failed (${error?.message ?? error})\n`);
        } finally {
          snapshotInFlight = false;
        }
      }
    }
    heartbeatTimer = setTimeout(heartbeatTick, Math.max(1_000, Math.round(interval / 3)));
    heartbeatTimer.unref?.();
  };
  if (!scriptedStates) {
    heartbeatTimer = setTimeout(heartbeatTick, Math.max(1_000, Math.round(SNAPSHOT_HEARTBEAT_MS / 3)));
    heartbeatTimer.unref?.();
  }

  if (args.proxy) {
    applyAgentProxy(args.proxy);
  }

  // The interface check supplies every reading it needs, so it must not touch the
  // machine it runs on: no install, no service, no probe.
  if (args.engine && scriptedStates === null) {
    // The client prepares this machine by itself: check, install, keep resident.
    // The window is already up and the steps are published as they happen, so a
    // first run shows what is being done rather than a spinner.
    void prepareLocal()
      .catch((error) => {
        localState = 'error';
        localDetail = String(error?.message ?? error);
      })
      .then(async () => {
        await currentSnapshot();
        // The network comes back only if the user left it on: the identity is already on
        // disk, so restoring the request costs no sign-in, while starting it for someone
        // who never asked would take the machine over. `--fleet` still forces it for the
        // acceptance runs.
        if (args.fleet || (fleetWanted(readSettings()) && currentEndpoint().url !== '')) {
          process.stderr.write('shell: restoring the fleet link the user left on\n');
          void connectFleet(args.fleet ? 'acceptance' : 'restore').catch((error) =>
            process.stderr.write(`shell: fleet link failed (${error?.message ?? error})\n`),
          );
        }
      })
      .catch((error) => process.stderr.write(`shell: local host could not be prepared (${error?.message ?? error})\n`));
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  // The helper is about to be stopped on purpose: its exit must not be answered with a
  // restart, which would outlive the app.
  quitting = true;
  // What the next launch restores is what this one ended on: a fleet that was up comes
  // back without asking, one that ended in a failure or was turned off does not.
  const fleetState = supervisor?.snapshot().state;
  if (fleetState === 'ready' || fleetState === 'empty') {
    writeSettings(withFleetIntent(readSettings(), true));
  } else if (fleetState !== undefined) {
    writeSettings(withFleetIntent(readSettings(), false));
  }
  supervisor?.stop();
});