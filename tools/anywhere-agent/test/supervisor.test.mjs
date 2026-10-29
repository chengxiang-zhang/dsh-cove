import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AgentState, createSupervisor, isMissingIdentity } from '../agent/supervisor.mjs';

/** A scripted engine that records what it was asked, so the sequence is provable. */
function fakeEngine(script = {}) {
  const calls = [];
  return {
    calls,
    version: async () => script.version ?? { protocol: 1, netbird: 'v0.78.1', helper: '0.1.0' },
    request: async (cmd, fields) => {
      calls.push({ cmd, fields });
      if (script.request) {
        return script.request(cmd, fields);
      }
      throw new Error(`unexpected command ${cmd}`);
    },
    stop: async () => {},
  };
}

/** Fast, deterministic options: no real waiting in a unit test. */
const fast = (overrides = {}) => ({
  paths: { config: '/tmp/aw-test/config.json', state: '/tmp/aw-test/state.json' },
  managementUrl: 'https://netbird.example:443',
  deviceName: 'aw-test',
  configExists: () => false,
  connectTimeoutMs: 200,
  mapTimeoutMs: 0,
  pollMs: 1,
  sleep: async () => {},
  ...overrides,
});

const RECORDS = [
  { type: 1, name: 'dsh.peer-a', zone: 'netbird', content: '100.64.1.81' },
  { type: 1, name: 'clickhouse.peer-a', zone: 'netbird', content: '100.64.1.81' },
];

test('a machine that has never signed in is asked to sign in', async () => {
  const engine = fakeEngine({ request: (cmd) => (cmd === 'login' ? 'https://sso.example/auth' : null) });
  const agent = createSupervisor({ engine, ...fast({ configExists: () => false }) });

  const snapshot = await agent.begin();
  assert.equal(snapshot.state, AgentState.LOGIN_REQUIRED);
  assert.equal(snapshot.loginUrl, 'https://sso.example/auth');
  assert.deepEqual(engine.calls.map((call) => call.cmd), ['login']);
});

test('a finished sign-in connects and offers the accepted entries', async () => {
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd === 'login') return 'https://sso.example/auth';
      if (cmd === 'sso-status') return { state: 'done' };
      if (cmd === 'start') return 'started';
      if (cmd === 'status') return { managementConnected: true, ip: '100.64.1.8', fqdn: 'aw-test.vpn' };
      if (cmd === 'peers') return ['100.64.1.81'];
      if (cmd === 'services') return RECORDS;
      if (cmd === 'proxy') return 'http://127.0.0.1:19002';
      return null;
    },
  });
  const agent = createSupervisor({ engine, ...fast() });

  await agent.begin();
  const result = await agent.loginStatus();

  assert.equal(result.done, true);
  assert.equal(result.state.state, AgentState.READY);
  // The internal zone's service name is refused; only the dsh entry is offered.
  assert.deepEqual(result.state.entries.map((entry) => entry.host), ['dsh.peer-a.netbird']);
  assert.equal(result.state.registered, 2);
  assert.equal(result.state.proxy, 'http://127.0.0.1:19002');
});

test('a half-written profile offers the sign-in instead of failing', async () => {
  // The config file exists, the identity inside it does not: the engine starts and
  // then reports the missing identity through status.
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd === 'start') return 'started';
      if (cmd === 'status') throw new Error('client not started: login: no sso information provided');
      if (cmd === 'login') return 'https://sso.example/auth';
      return null;
    },
  });
  const agent = createSupervisor({ engine, ...fast({ configExists: () => true }) });

  const snapshot = await agent.begin();
  assert.equal(snapshot.state, AgentState.LOGIN_REQUIRED);
  assert.equal(snapshot.loginUrl, 'https://sso.example/auth');
  // It did not burn the connect timeout: the identity error is classified.
  assert.ok(engine.calls.some((call) => call.cmd === 'start'));
  assert.ok(engine.calls.some((call) => call.cmd === 'login'));
});

test('a connected engine with no map is empty, and the door still opens', async () => {
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd === 'start') return 'started';
      if (cmd === 'status') return { managementConnected: true };
      if (cmd === 'peers') return [];
      if (cmd === 'services') return [];
      if (cmd === 'proxy') return 'http://127.0.0.1:19002';
      return null;
    },
  });
  const agent = createSupervisor({ engine, ...fast({ configExists: () => true }) });

  const snapshot = await agent.begin();
  assert.equal(snapshot.state, AgentState.EMPTY);
  assert.equal(snapshot.proxy, 'http://127.0.0.1:19002');
  assert.equal(snapshot.entries.length, 0);
});

test('an engine that cannot be reached reports the reason', async () => {
  const engine = fakeEngine();
  engine.version = async () => {
    throw new Error('helper exited');
  };
  const agent = createSupervisor({ engine, ...fast() });

  const snapshot = await agent.begin();
  assert.equal(snapshot.state, AgentState.ERROR);
  assert.match(snapshot.detail, /helper exited/);
});

test('two callers cannot drive the engine at the same time', async () => {
  // The regression this guards: the shell asks for state while the agent is still
  // starting, the engine is asked for two sign-in flows, and the second never
  // returns - the screen stays on "starting" forever.
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let versionCalls = 0;
  const engine = fakeEngine({ request: (cmd) => (cmd === 'login' ? 'https://sso.example/auth' : null) });
  engine.version = async () => {
    versionCalls += 1;
    await gate;
    return { protocol: 1 };
  };
  const agent = createSupervisor({ engine, ...fast() });

  const first = agent.begin();
  const second = agent.connect();
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(versionCalls, 1, 'the engine must be driven once');
  assert.equal(a.state, AgentState.LOGIN_REQUIRED);
  assert.equal(b.state, AgentState.LOGIN_REQUIRED, 'the second caller sees the first flight');
  assert.equal(engine.calls.filter((call) => call.cmd === 'login').length, 1);
});

test('a sign-in that cannot be renewed keeps the sign-in screen', async () => {
  // The measured failure: with a reachable server the window reaches the sign-in screen,
  // the button mints a hand-off, and the callback window closes while the person is still
  // in their browser. Turning that into an error takes the sign-in buttons away and leaves
  // 重试 as the only way back, so the screen has to survive it.
  let logins = 0;
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd !== 'login') {
        return null;
      }
      logins += 1;
      if (logins > 1) {
        throw new Error('create auth client: create connection: dial context: context deadline exceeded');
      }
      return 'https://sso.example/auth';
    },
  });
  const agent = createSupervisor({ engine, ...fast({ configExists: () => false }) });

  const first = await agent.begin();
  assert.equal(first.state, AgentState.LOGIN_REQUIRED);
  assert.equal(first.loginUrl, 'https://sso.example/auth');

  const renewed = await agent.relogin();
  assert.equal(renewed.state, AgentState.LOGIN_REQUIRED, 'the sign-in screen stays');
  assert.equal(renewed.loginUrl, '', 'a link that failed is not left on screen');
  assert.match(renewed.detail, /could not be renewed/);
  assert.match(renewed.detail, /context deadline exceeded/, 'the engine words are kept for the diagnostics');
  // The next press is free to mint again, which is what the button promises.
  const again = await agent.relogin();
  assert.equal(again.state, AgentState.LOGIN_REQUIRED);
});

test('a hand-off that cannot be issued restarts the engine, and then works', async () => {
  // Measured on a real engine: the sign-in callback listener binds one port for the life of
  // the process, so an attempt nobody finished makes every later attempt fail with
  // "no available port found from configured redirect URLs". The window stayed on the
  // sign-in screen with a button that did nothing, which is what a person reports as
  // "cannot log in".
  let portHeld = false;
  let restarts = 0;
  let logins = 0;
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd !== 'login') {
        return null;
      }
      logins += 1;
      if (portHeld) {
        throw new Error('get oauth flow: no available port found from configured redirect URLs: ["http://localhost:53000/"]');
      }
      portHeld = true;
      return 'https://sso.example/auth';
    },
  });
  engine.restart = async () => {
    restarts += 1;
    portHeld = false;
  };
  const agent = createSupervisor({ engine, ...fast({ configExists: () => false }) });

  const first = await agent.begin();
  assert.equal(first.loginUrl, 'https://sso.example/auth');
  const renewed = await agent.relogin();
  assert.equal(renewed.state, AgentState.LOGIN_REQUIRED);
  assert.equal(renewed.loginUrl, 'https://sso.example/auth', 'the button works again');
  assert.equal(restarts, 1);
  // The repeat press starts a fresh engine *before* asking, so no attempt is wasted on a
  // port the engine cannot give back.
  assert.equal(logins, 2, 'one hand-off, then the one on the fresh engine');
});

test('one restart, then the honest reason', async () => {
  // The restart is spent once: an engine that still cannot issue a hand-off leaves the
  // sign-in screen with the engine's own words for the diagnostics, not a restart loop.
  let logins = 0;
  let restarts = 0;
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd !== 'login') {
        return null;
      }
      logins += 1;
      if (logins === 1) {
        return 'https://sso.example/auth';
      }
      throw new Error('get oauth flow: no available port found from configured redirect URLs');
    },
  });
  engine.restart = async () => {
    restarts += 1;
  };
  const agent = createSupervisor({ engine, ...fast({ configExists: () => false }) });
  await agent.begin();

  const renewed = await agent.relogin();
  assert.equal(renewed.state, AgentState.LOGIN_REQUIRED, 'the screen is kept');
  assert.equal(renewed.loginUrl, '', 'no dead link is left behind');
  assert.match(renewed.detail, /could not be renewed/);
  assert.equal(restarts, 1, 'exactly one restart');
});

test('a sign-in that cannot start at all is still an error', async () => {
  // The other half of the rule: when no sign-in screen has been offered yet there is
  // nothing to go back to, so an engine that cannot mint a link is a failure the user has
  // to see - the state that names the server and offers to change it.
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd === 'login') {
        throw new Error('create auth client: create connection: dial context: context deadline exceeded');
      }
      return null;
    },
  });
  const agent = createSupervisor({ engine, ...fast({ configExists: () => false }) });
  const snapshot = await agent.begin();
  assert.equal(snapshot.state, AgentState.ERROR);
  assert.match(snapshot.detail, /could not start/);
  assert.match(snapshot.detail, /context deadline exceeded/);
});

test('an engine that does not match the contract is refused before any network use', async () => {
  const engine = fakeEngine({ version: { protocol: 2, netbird: 'v0.79.0', helper: '0.2.0' } });
  const agent = createSupervisor({
    engine,
    ...fast({ contract: { protocol: 1, netbird: 'v0.78.1' } }),
  });

  const snapshot = await agent.begin();
  assert.equal(snapshot.state, AgentState.ERROR);
  assert.match(snapshot.detail, /protocol 2/);
  // Nothing was asked of the engine beyond its version.
  assert.deepEqual(engine.calls, []);
});

test('a refused contract stays refused through a later refresh', async () => {
  const engine = fakeEngine({ version: { protocol: 2, netbird: 'v0.79.0' } });
  const agent = createSupervisor({ engine, ...fast({ contract: { protocol: 1, netbird: 'v0.78.1' } }) });

  await agent.begin();
  const second = await agent.connect();
  assert.equal(second.state, AgentState.ERROR);
  assert.match(second.detail, /protocol 2/);
  // Retrying must not take the network up.
  assert.equal(engine.calls.length, 0);
});

test('every transition is announced, so a push-driven shell keeps up', async () => {
  const seen = [];
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd === 'login') return 'https://sso.example/auth';
      return null;
    },
  });
  const agent = createSupervisor({
    engine,
    ...fast({ configExists: () => false, onState: (snapshot) => seen.push(snapshot.state) }),
  });

  await agent.begin();
  assert.deepEqual(seen, [AgentState.STARTING, AgentState.LOGIN_REQUIRED]);
});

test('a fresh sign-in link is issued on demand, and only while one is pending', async () => {
  let issued = 0;
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd === 'login') {
        issued += 1;
        return `https://sso.example/auth?n=${issued}`;
      }
      return null;
    },
  });
  const agent = createSupervisor({ engine, ...fast({ configExists: () => false }) });

  const first = await agent.begin();
  assert.equal(first.state, AgentState.LOGIN_REQUIRED);
  assert.equal(first.loginUrl, 'https://sso.example/auth?n=1');

  // The displayed link goes stale, so asking again must mint a new one - the hand-off
  // window is short and a stale link lands on a closed port.
  const again = await agent.relogin();
  assert.equal(again.loginUrl, 'https://sso.example/auth?n=2');
  assert.equal(issued, 2);
});

test('a fresh link is not minted once the machine is connected', async () => {
  // A connected agent must not be re-driven to produce a link nobody asked to use:
  // the guard is what keeps the button from disturbing the network.
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd === 'start') return 'started';
      if (cmd === 'status') return { managementConnected: true, ip: '100.64.1.8', fqdn: 'aw.vpn' };
      if (cmd === 'peers') return ['100.64.1.81'];
      if (cmd === 'services') return [{ type: 1, name: 'dsh.peer-a', zone: 'netbird', content: '100.64.1.81' }];
      if (cmd === 'proxy') return 'http://127.0.0.1:19002';
      if (cmd === 'login') return 'https://sso.example/auth';
      return null;
    },
  });
  const agent = createSupervisor({ engine, ...fast({ configExists: () => true }) });
  const ready = await agent.begin();
  assert.equal(ready.state, AgentState.READY);

  const before = engine.calls.filter((call) => call.cmd === 'login').length;
  const same = await agent.relogin();
  assert.equal(engine.calls.filter((call) => call.cmd === 'login').length, before);
  assert.equal(same.state, AgentState.READY);
});

test('a setup key enrolls without a browser', async () => {
  const engine = fakeEngine({
    request: (cmd) => {
      if (cmd === 'start') return 'started';
      if (cmd === 'status') return { managementConnected: true, ip: '100.64.1.8', fqdn: 'aw.vpn' };
      if (cmd === 'peers') return ['100.64.1.81'];
      if (cmd === 'services') return [{ type: 1, name: 'dsh.peer-a', zone: 'netbird', content: '100.64.1.81' }];
      if (cmd === 'proxy') return 'http://127.0.0.1:19002';
      return null;
    },
  });
  const agent = createSupervisor({ engine, ...fast({ configExists: () => false, setupKey: 'one-time-key' }) });

  const snapshot = await agent.begin();
  assert.equal(snapshot.state, AgentState.READY);
  // The key went to the engine, and no sign-in was started.
  const start = engine.calls.find((call) => call.cmd === 'start');
  assert.equal(start.fields.setupKey, 'one-time-key');
  assert.equal(engine.calls.some((call) => call.cmd === 'login'), false);
});

test('a matching engine proceeds to the sign-in', async () => {
  const engine = fakeEngine({ request: (cmd) => (cmd === 'login' ? 'https://sso.example/auth' : null) });
  const agent = createSupervisor({
    engine,
    ...fast({ contract: { protocol: 1, netbird: 'v0.78.1' } }),
  });

  const snapshot = await agent.begin();
  assert.equal(snapshot.state, AgentState.LOGIN_REQUIRED);
});

test('identity failures are recognised by their wording', () => {
  for (const message of [
    'no peer auth method provided, please use a setup key or interactive SSO login',
    'invalid setup-key or no sso information provided',
    'code = PermissionDenied',
  ]) {
    assert.equal(isMissingIdentity(message), true, message);
  }
  for (const message of ['connection refused', 'i/o timeout', '']) {
    assert.equal(isMissingIdentity(message), false, message);
  }
});