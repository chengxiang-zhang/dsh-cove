/**
 * The agent's state machine.
 *
 * Everything the shell shows comes from here, and every step that can fail has a
 * named state instead of a spinner: a machine that has never signed in needs a
 * login, a machine that is signed in but sees no map is a different problem, and
 * a machine that is connected but whose entries do not answer is a third. The
 * mobile client learned this the hard way - "the list is empty" is the complaint
 * that costs the most support time - so the desktop client names the layer.
 *
 * Two rules shape the code below:
 *
 * 1. One driver at a time. The shell asks for state while the agent is still
 *    starting; without a single-flight slot the engine gets asked for two sign-in
 *    flows and the second one never returns.
 * 2. A half-written profile is a login problem, not a dead end. Sign-ins get
 *    interrupted, and the honest answer is to offer the sign-in again rather than
 *    report a failure the user cannot act on.
 *
 * The engine is injected, never constructed here, so the whole sequence is
 * testable without a network or a 30 MB binary.
 */

import { DSH_ZONES } from '../src/generated/fleetConfig.mjs';

/** Every state the shell can render. */
export const AgentState = {
  STARTING: 'starting',
  LOGIN_REQUIRED: 'login-required',
  CONNECTING: 'connecting',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error',
};

const DEFAULTS = {
  /** How long the engine may take to report that the management link is up. */
  connectTimeoutMs: 90_000,
  /**
   * How long one sign-in hand-off may take.
   *
   * Shorter than the client's own request timeout on purpose: the engine's listener binds its
   * callback port for the life of the process, so an attempt it cannot serve does not fail -
   * it retries with backoff, which is how a press turned into minutes of waiting.
   */
  loginTimeoutMs: 20_000,
  /** How long the network map may take to arrive after the link is up. */
  mapTimeoutMs: 25_000,
  /** Poll interval for both waits. */
  pollMs: 1_500,
  zones: [...DSH_ZONES],
};

/** A promise-based sleep that a test can replace with an immediate resolution. */
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether an engine error means "this machine has no identity yet".
 *
 * The engine starts asynchronously and reports an unusable profile through later
 * calls, so waiting out a connect timeout would leave the user on "connecting" for
 * a minute and a half when the honest answer is "sign in". The wording is the
 * engine's, hence the substring match.
 */
export function isMissingIdentity(message) {
  return /no sso|setup-?key|permissiondenied|unauthenticated|no peer auth/i.test(String(message ?? ''));
}

/**
 * Creates the supervisor.
 *
 * @param {{
 *   engine: { version: () => Promise<any>, request: (cmd: string, fields?: object) => Promise<any>, stop?: () => Promise<void>, restart?: () => Promise<void> },
 *   paths: { config: string, state: string },
 *   managementUrl: string,
 *   deviceName: string,
 *   configExists: () => boolean,
 *   setupKey?: string,
 *   zones?: string[],
 *   connectTimeoutMs?: number,
 *   mapTimeoutMs?: number,
 *   pollMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   log?: (line: string) => void,
 *   onState?: (snapshot: object) => void,
 * }} options
 */
export function createSupervisor(options) {
  const config = { ...DEFAULTS, ...options };
  const sleep = config.sleep ?? realSleep;
  const log = config.log ?? (() => {});

  let state = AgentState.STARTING;
  let detail = '';
  let loginUrl = '';
  /**
   * How many hand-offs this engine has issued.
   *
   * After the first one the callback port is held until the process ends, so the next press
   * gets a fresh engine before it asks - that is what keeps the second press as fast as the
   * first instead of waiting out the engine's retries.
   */
  let handoffsIssued = 0;
  let engineInfo = null;
  let self = null;
  let entries = [];
  let registered = 0;
  let proxy = '';

  const snapshot = () => ({
    state,
    detail,
    loginUrl,
    engine: engineInfo,
    self,
    entries,
    registered,
    proxy,
  });

  // Every transition is announced. The shell renders from these notifications
  // rather than by polling, so a state the supervisor reaches on its own - the
  // sign-in hand-off, the map arriving - has to travel the same way.
  const notify = config.onState ?? (() => {});
  const setState = (next, note = '') => {
    state = next;
    detail = note;
    log(`state=${next}${note ? ` (${note})` : ''}`);
    notify(snapshot());
  };

  /**
   * Set when the engine failed the version contract.
   *
   * The refusal has to be sticky: a later refresh that quietly re-drove the engine
   * would take the network up anyway and defeat the whole check.
   */
  let refused = '';

  /** Reads the engine's peer addresses and the entries it accepted. */
  const readMap = async () => {
    const peers = await config.engine.request('peers');
    const services = await config.engine.request('services');
    return {
      addresses: (Array.isArray(peers) ? peers : []).map((address) => String(address)),
      records: (Array.isArray(services) ? services : []).filter((record) => record && record.name),
    };
  };

  /**
   * Waits for the network map, which arrives after the management link does.
   *
   * A peer that is connected but not yet mapped reports zero peers and zero
   * records; treating that as "no machines" is exactly the bug the mobile client
   * waits out with its own settle window.
   */
  const waitForMap = async () => {
    const deadline = Date.now() + config.mapTimeoutMs;
    for (;;) {
      const map = await readMap();
      if (map.addresses.length > 0 || map.records.length > 0 || Date.now() >= deadline) {
        return map;
      }
      await sleep(config.pollMs);
    }
  };

  const waitForManagement = async () => {
    const deadline = Date.now() + config.connectTimeoutMs;
    for (;;) {
      try {
        const status = await config.engine.request('status');
        if (status && status.managementConnected) {
          return status;
        }
      } catch (error) {
        log(`status failed: ${error.message}`);
        if (isMissingIdentity(error.message)) {
          throw new Error(`no usable identity: ${error.message}`);
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('the engine never reported a management connection');
      }
      await sleep(config.pollMs);
    }
  };

  const startProxy = async () => {
    proxy = String(await config.engine.request('proxy'));
    return proxy;
  };

  /** One hand-off out of an engine whose callback port is free.
   *
   * @returns {Promise<{ url: string, restarted: boolean }>} the link, and whether this press
   *   already spent its one restart on a fresh engine.
   */
  const mintHandoff = async () => {
    const neededFresh = handoffsIssued > 0 && typeof config.engine.restart === 'function';
    if (neededFresh) {
      log('a hand-off was already issued by this engine; starting a fresh one for this press');
      await config.engine.restart();
    }
    const url = String(
      await config.engine.request(
        'login',
        {
          deviceName: config.deviceName,
          managementUrl: config.managementUrl,
          configPath: config.paths.config,
          statePath: config.paths.state,
        },
        config.loginTimeoutMs,
      ),
    );
    handoffsIssued += 1;
    return { url, restarted: neededFresh };
  };

  /** The sign-in hand-off; the URL is what the shell hands to the browser. */
  const loginImpl = async (allowRestart = true, alreadyRestarted = false) => {
    try {
      const minted = await mintHandoff();
      loginUrl = minted.url;
      setState(AgentState.LOGIN_REQUIRED, 'the browser must finish the sign-in');
    } catch (error) {
      // A sign-in that cannot be issued while the sign-in screen is already up is the engine
      // holding its own callback port: the listener binds one port for the life of the
      // process, so an attempt the person did not finish makes every later attempt fail with
      // "no available port". Restarting the engine is what gives the port back, and it is
      // the difference between a button that works again and a button that never does.
      // At most one restart per press: the fresh engine taken before asking (in `mintHandoff`)
      // already counts, so this path only spends the restart the first press never spent.
      const restartedForThisAttempt = alreadyRestarted || handoffsIssued > 0;
      if (state === AgentState.LOGIN_REQUIRED && allowRestart && !restartedForThisAttempt && typeof config.engine.restart === 'function') {
        log(`the hand-off could not be issued (${error.message}); restarting the engine`);
        loginUrl = '';
        await config.engine.restart();
        return loginImpl(false, true);
      }
      // The hand-off is short-lived by design, so a renewal can fail while the user is still
      // on the sign-in screen: they took longer than the callback window, or they pressed the
      // button twice. That is the same situation as before they pressed anything, so the
      // answer cannot be an error state - it takes the button away and leaves 重试 as the only
      // way back. The engine's words are kept for the diagnostics, and the link is cleared so
      // nobody clicks a dead one.
      if (state === AgentState.LOGIN_REQUIRED) {
        loginUrl = '';
        setState(AgentState.LOGIN_REQUIRED, `sign-in could not be renewed: ${error.message}`);
        return snapshot();
      }
      setState(AgentState.ERROR, `login could not start: ${error.message}`);
    }
    return snapshot();
  };

  /**
   * Issues a fresh sign-in link.
   *
   * The hand-off is short-lived by design: the engine listens for the callback for a
   * few minutes and then stops. A link that has been on screen longer than that is a
   * link whose click lands on a dead port, with nothing on screen to explain it - so
   * the button re-issues rather than trusting what is displayed.
   */
  const reloginImpl = async () => {
    if (state !== AgentState.LOGIN_REQUIRED) {
      // Never disturb a working connection to mint a link nobody asked to use.
      return snapshot();
    }
    return loginImpl();
  };

  /** Brings the overlay up and reads the map; the state says what happened. */
  const connectImpl = async () => {
    // A refused contract ends the road until the pair is fixed: retrying would take
    // the network up anyway and defeat the refusal.
    if (refused) {
      setState(AgentState.ERROR, refused);
      return snapshot();
    }
    setState(AgentState.CONNECTING);
    try {
      await config.engine.request('start', {
        // Empty means "use the stored identity"; a key here enrolls this machine
        // without a browser, which is how a headless machine joins.
        setupKey: config.setupKey ?? '',
        deviceName: config.deviceName,
        managementUrl: config.managementUrl,
        configPath: config.paths.config,
        statePath: config.paths.state,
      });
      self = await waitForManagement();
    } catch (error) {
      // A half-written profile is the ordinary failure: the config file exists,
      // the identity inside it does not. That is a login problem, so the user gets
      // the sign-in rather than an error they cannot act on. A genuinely broken
      // network surfaces from the login attempt itself.
      log(`connect could not use the stored profile (${error.message}); asking for a sign-in`);
      return loginImpl();
    }

    const { addresses, records } = await waitForMap();
    registered = records.length;

    if (records.length === 0) {
      // The door still opens: the proxy refuses every name until the map arrives,
      // which lets the shell tell "nothing to offer yet" apart from "no door".
      await startProxy();
      setState(AgentState.EMPTY, 'the engine sees no machine of this network yet');
      return snapshot();
    }

    const { buildRegistry, peerAddressSet } = await import('../src/discovery.mjs');
    const { isCloudManagement } = await import('../src/endpoint.mjs');
    // Cloud peers answer under their own FQDN, self-hosted entries under
    // `dsh.<machine>.<zone>`; the acceptance rule needs to know which world
    // this control plane belongs to.
    const registry = buildRegistry(records, peerAddressSet(addresses.map((ip) => ({ ip }))), config.zones, {
      cloud: isCloudManagement(config.managementUrl),
    });
    entries = registry.entries;
    await startProxy();
    setState(AgentState.READY, `${entries.length} machines reachable by registration`);
    return snapshot();
  };

  /** Reports whether the browser finished the sign-in. */
  const loginStatusImpl = async () => {
    if (state !== AgentState.LOGIN_REQUIRED) {
      return { done: false, state: snapshot() };
    }
    try {
      const status = await config.engine.request('sso-status');
      if (String(status?.state ?? '').toLowerCase() === 'done') {
        loginUrl = '';
        await connectImpl();
        return { done: true, state: snapshot() };
      }
      return { done: false, state: snapshot() };
    } catch (error) {
      return { done: false, state: snapshot(), error: error.message };
    }
  };

  const beginImpl = async () => {
    setState(AgentState.STARTING);
    try {
      engineInfo = await config.engine.version();
    } catch (error) {
      setState(AgentState.ERROR, `engine unavailable: ${error.message}`);
      return snapshot();
    }

    // The shell and the engine ship and update separately, so the pair is checked
    // before anything touches the network: a mismatched protocol or engine version
    // is a refusal, not a half-working overlay.
    if (config.contract) {
      const { checkContract } = await import('../src/update.mjs');
      const verdict = checkContract(engineInfo, config.contract);
      if (!verdict.ok) {
        refused = verdict.reason;
        setState(AgentState.ERROR, verdict.reason);
        return snapshot();
      }
    }

    if (!config.configExists() && !config.setupKey) {
      return loginImpl();
    }
    return connectImpl();
  };

  // One driver at a time. A caller that arrives mid-flight gets that flight
  // instead of starting a second one against the same engine.
  let driving = null;
  let drivingLabel = '';
  const runExclusive = (label, run) => {
    if (driving) {
      log(`skip ${label}: ${drivingLabel} is already in flight`);
      return driving;
    }
    drivingLabel = label;
    driving = Promise.resolve()
      .then(run)
      .finally(() => {
        driving = null;
        drivingLabel = '';
      });
    return driving;
  };

  return {
    snapshot,
    begin: () => runExclusive('begin', beginImpl),
    connect: () => runExclusive('connect', connectImpl),
    beginLogin: () => runExclusive('login', loginImpl),
    relogin: () => runExclusive('login', reloginImpl),
    loginStatus: () => runExclusive('login-status', loginStatusImpl),
    async stop() {
      try {
        await config.engine.stop?.();
      } catch (error) {
        log(`stop failed: ${error.message}`);
      }
    },
  };
}