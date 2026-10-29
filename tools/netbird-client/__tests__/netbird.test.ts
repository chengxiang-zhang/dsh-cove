// The platform predicate is asserted directly; the rest of this suite drives the
// bridge through the tunnel helpers.
import {
  FOREGROUND_REFRESH_MIN_MS,
  hasBundledBrowserContainer,
  shouldRefreshOnForeground,
} from '../src/netbird';

jest.mock('../src/NetBirdPortal', () => ({
  NetBirdPortal: {
    listServices: jest.fn(),
    probe: jest.fn(),
    clearWebSessions: jest.fn(),
    clearWebViewProxy: jest.fn(),
    stop: jest.fn(),
    hasPersistedConfig: jest.fn(),
    resumeConnection: jest.fn(),
    resetConnection: jest.fn(),
    diagnostics: jest.fn(),
    reportServiceCount: jest.fn(),
    clearServiceCount: jest.fn(),
    verify: jest.fn(),
    ensureServiceReady: jest.fn(),
    fetch: jest.fn(),
    startProxy: jest.fn(),
    applyWebViewProxy: jest.fn(),
  },
}));

import {NetBirdPortal} from '../src/NetBirdPortal';
import {
  probeManagementServer,
  serverDisplayUrl,
  serverHostLabel,
  RECONNECT_ESCALATE_AFTER_ATTEMPTS,
  RECONNECT_ESCALATE_AFTER_MS,
  clearWebViewSessions,
  ensureConnected,
  getServiceUrl,
  hasPersistedLogin,
  listServices,
  readConnectionDiagnostics,
  recordReconnectFailure,
  reconnectNotice,
  resetAndReconnect,
  resumePersistedConnection,
  shouldEscalateReconnect,
  startReconnectStreak,
} from '../src/netbird';

const listServicesMock = NetBirdPortal.listServices as jest.MockedFunction<
  typeof NetBirdPortal.listServices
>;
const probeMock = NetBirdPortal.probe as jest.MockedFunction<typeof NetBirdPortal.probe>;
const clearWebSessionsMock = NetBirdPortal.clearWebSessions as jest.MockedFunction<
  typeof NetBirdPortal.clearWebSessions
>;
const clearWebViewProxyMock = NetBirdPortal.clearWebViewProxy as jest.MockedFunction<
  typeof NetBirdPortal.clearWebViewProxy
>;
const stopMock = NetBirdPortal.stop as jest.MockedFunction<typeof NetBirdPortal.stop>;

describe('intranet service catalogue (DSH first)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('uses only local persisted state to preserve cold-start login', async () => {
    (NetBirdPortal.hasPersistedConfig as jest.Mock).mockResolvedValue(true);
    (NetBirdPortal.resumeConnection as jest.Mock).mockResolvedValue(undefined);

    await expect(hasPersistedLogin()).resolves.toBe(true);
    await expect(resumePersistedConnection()).resolves.toBeUndefined();
    expect(NetBirdPortal.hasPersistedConfig).toHaveBeenCalledTimes(1);
    expect(NetBirdPortal.resumeConnection).toHaveBeenCalledTimes(1);
  });

  test('stops the runtime before its final WebView proxy clear on logout', async () => {
    const calls: string[] = [];
    clearWebSessionsMock.mockImplementation(async () => {
      calls.push('sessions');
    });
    stopMock.mockImplementation(async () => {
      calls.push('stop');
    });
    clearWebViewProxyMock.mockImplementation(async () => {
      calls.push('proxy');
    });

    await clearWebViewSessions();

    expect(calls).toEqual(['sessions', 'stop', 'proxy']);
  });

  test('opens every service through its root URL', () => {
    expect(getServiceUrl('dsh.laptop-b.netbird')).toBe('http://dsh.laptop-b.netbird/');
    expect(getServiceUrl('openviking.dl-dev')).toBe('http://openviking.dl-dev/');
  });

  test('keeps the registered DSH records returned by the native registry', async () => {
    listServicesMock.mockResolvedValue([
      {
        name: 'dsh.studio-mac.netbird.',
        type: 1,
        class: 'IN',
        content: '100.64.0.11',
        zone: 'netbird.',
      },
      {
        name: 'dsh.laptop-b.netbird',
        type: 1,
        class: 'IN',
        content: '100.64.0.12',
        zone: 'netbird.',
      },
      {
        name: 'dsh.tower-lab.netbird.',
        type: 1,
        class: 'IN',
        content: '100.64.0.15',
        zone: 'netbird.',
      },
    ]);
    probeMock.mockImplementation(async url => ({url, statusCode: 200, reachable: true}));

    // Ordered by name, so the list reads the same way on every read instead of
    // following whatever order the registry answered in this time. The records
    // above are deliberately not in that order, and one of them even carries a
    // zone with a trailing dot, which normalization has to fold into the name
    // the order is computed from.
    await expect(listServices()).resolves.toEqual([
      {
        name: 'dsh.laptop-b.netbird',
        url: 'http://dsh.laptop-b.netbird/',
        statusCode: 200,
        reachable: true,
        needsLogin: false,
      },
      {
        name: 'dsh.studio-mac.netbird',
        url: 'http://dsh.studio-mac.netbird/',
        statusCode: 200,
        reachable: true,
        needsLogin: false,
      },
      {
        name: 'dsh.tower-lab.netbird',
        url: 'http://dsh.tower-lab.netbird/',
        statusCode: 200,
        reachable: true,
        needsLogin: false,
      },
    ]);
    expect(probeMock.mock.calls.map(([url]) => url)).toEqual([
      'http://dsh.laptop-b.netbird',
      'http://dsh.studio-mac.netbird',
      'http://dsh.tower-lab.netbird',
    ]);
  });

  test('qualifies a zone-relative record against its own zone', async () => {
    listServicesMock.mockResolvedValue([
      {name: 'dsh.imac-office', type: 1, class: 'IN', content: '100.64.0.13', zone: 'netbird'},
    ]);
    probeMock.mockImplementation(async url => ({url, statusCode: 200, reachable: true}));

    await expect(listServices()).resolves.toEqual([
      {
        name: 'dsh.imac-office.netbird',
        url: 'http://dsh.imac-office.netbird/',
        statusCode: 200,
        reachable: true,
        needsLogin: false,
      },
    ]);
  });

  test('drops unreachable DSH services instead of offering a dead entry', async () => {
    listServicesMock.mockResolvedValue([
      {
        name: 'dsh.studio-mac.netbird',
        type: 1,
        class: 'IN',
        content: '100.64.0.11',
        zone: 'netbird.',
      },
    ]);
    probeMock.mockImplementation(async url => ({url, statusCode: 0, reachable: false}));

    await expect(listServices()).resolves.toEqual([]);
  });

  test('waits out the map settle window instead of reporting an empty catalogue', async () => {
    jest.useFakeTimers();
    try {
      // A peer that already reports a connected management stream can still
      // have no map yet; the first reads come back empty (measured on a cold
      // start, where only a pull-to-refresh listed the six machines).
      let reads = 0;
      listServicesMock.mockImplementation(() => {
        reads += 1;
        return Promise.resolve(
          reads < 3
            ? []
            : [
                {
                  name: 'dsh.studio-mac.netbird',
                  type: 1,
                  class: 'IN',
                  content: '100.64.0.11',
                  zone: 'netbird.',
                },
              ],
        );
      });
      probeMock.mockImplementation(async url => ({url, statusCode: 200, reachable: true}));

      const pending = listServices();
      await jest.advanceTimersByTimeAsync(3000);

      await expect(pending).resolves.toEqual([
        {
          name: 'dsh.studio-mac.netbird',
          url: 'http://dsh.studio-mac.netbird/',
          statusCode: 200,
          reachable: true,
          needsLogin: false,
        },
      ]);
      expect(reads).toBeGreaterThanOrEqual(3);
    } finally {
      jest.useRealTimers();
    }
  });

  test('connects with no HTTP liveness probe in the path', async () => {
    (NetBirdPortal.ensureServiceReady as jest.Mock).mockResolvedValue('http://127.0.0.1:19001');
    (NetBirdPortal.applyWebViewProxy as jest.Mock).mockResolvedValue(undefined);

    await expect(ensureConnected('')).resolves.toBe(true);
    expect(NetBirdPortal.ensureServiceReady).toHaveBeenCalledTimes(1);
    // The gate is gone for good. Both failed releases put a fetch through the
    // embedded netstack in front of login, and that resolver did not answer the
    // name either time (`apk.dl-dev`, then `tx.vpn` as `no such host`).
    expect(NetBirdPortal.verify).not.toHaveBeenCalled();
    expect(NetBirdPortal.fetch).not.toHaveBeenCalled();
  });

  test('hands a not-yet-ready engine to the service list instead of failing the login', async () => {
    (NetBirdPortal.ensureServiceReady as jest.Mock).mockRejectedValue(
      new Error('NetBird management connection timed out'),
    );

    await expect(ensureConnected('')).resolves.toBe(true);
  });

  test('still surfaces a confirmed authentication failure', async () => {
    (NetBirdPortal.ensureServiceReady as jest.Mock).mockRejectedValue(
      new Error('NETBIRD_AUTH_REQUIRED'),
    );

    await expect(ensureConnected('')).rejects.toThrow('NETBIRD_AUTH_REQUIRED');
  });
});

describe('connection recovery wording', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('keeps the quiet wording while an outage may still pass', () => {
    const state = recordReconnectFailure(startReconnectStreak(), 1_000);

    expect(state.escalated).toBe(false);
    expect(shouldEscalateReconnect(state.failures, state.firstFailureAt, 2_000)).toBe(false);

    const notice = reconnectNotice(state, null);
    expect(notice.message).toBe('内网暂时未连接，无需重新登录，正在自动重试…');
    expect(notice.escalate).toBe(false);
    expect(notice.loginRequired).toBe(false);
  });

  test('escalates after repeated failures and still offers a way out', () => {
    let state = startReconnectStreak();
    for (let attempt = 0; attempt < RECONNECT_ESCALATE_AFTER_ATTEMPTS; attempt += 1) {
      state = recordReconnectFailure(state, 1_000 + attempt);
    }

    expect(state.escalated).toBe(true);
    const notice = reconnectNotice(state, null);
    expect(notice.escalate).toBe(true);
    expect(notice.message).toBe('内网一直没连上，登录可能已失效');
    expect(notice.detail).toContain('重新登录');
  });

  test('escalates on the time window even when attempts stay few', () => {
    const state = recordReconnectFailure(startReconnectStreak(), 0);

    expect(
      shouldEscalateReconnect(state.failures, state.firstFailureAt, RECONNECT_ESCALATE_AFTER_MS),
    ).toBe(true);
    expect(
      shouldEscalateReconnect(state.failures, state.firstFailureAt, RECONNECT_ESCALATE_AFTER_MS - 1),
    ).toBe(false);
  });

  test('names a dead login as soon as the native verdict says so', () => {
    const state = recordReconnectFailure(startReconnectStreak(), 1_000);
    const notice = reconnectNotice(state, {
      serviceRunning: true,
      stage: 'management_disconnected',
      lastError: 'NetBird management connection timed out',
      failures: 1,
      hardResets: 0,
      authVerdict: 'login_required',
    });

    expect(notice.loginRequired).toBe(true);
    expect(notice.escalate).toBe(true);
    expect(notice.message).toBe('登录已失效，请重新登录');
  });

  test('rebuilds the engine instead of calling the no-op resume path', async () => {
    (NetBirdPortal.resetConnection as jest.Mock).mockResolvedValue(undefined);

    await resetAndReconnect();

    expect(NetBirdPortal.resetConnection).toHaveBeenCalledTimes(1);
    expect(NetBirdPortal.resumeConnection).not.toHaveBeenCalled();
  });

  test('falls back to the resume path when the reset entry point is missing', async () => {
    (NetBirdPortal.resetConnection as jest.Mock).mockRejectedValue(new Error('no such method'));
    (NetBirdPortal.resumeConnection as jest.Mock).mockResolvedValue(undefined);

    await expect(resetAndReconnect()).resolves.toBeUndefined();
    expect(NetBirdPortal.resumeConnection).toHaveBeenCalledTimes(1);
  });

  test('returns no diagnostics instead of breaking the screen', async () => {
    (NetBirdPortal.diagnostics as jest.Mock).mockRejectedValue(new Error('bridge unavailable'));

    await expect(readConnectionDiagnostics()).resolves.toBeNull();
  });

  test('still clears the WebView proxy when the tunnel stop fails', async () => {
    // The stop call can time out behind the service's 30-second management
    // wait; that must not keep the user stuck on the service list.
    stopMock.mockRejectedValue(new Error('NETBIRD_STOP'));
    clearWebViewProxyMock.mockResolvedValue(undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(clearWebViewSessions()).resolves.toBeUndefined();

    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(clearWebViewProxyMock).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('does not fail a login when only the system WebView proxy is unsupported', async () => {
    (NetBirdPortal.ensureServiceReady as jest.Mock).mockResolvedValue('http://127.0.0.1:19001');
    (NetBirdPortal.applyWebViewProxy as jest.Mock).mockRejectedValue(
      new Error('WEBVIEW_PROXY_UNSUPPORTED'),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(ensureConnected()).resolves.toBe(true);

    warn.mockRestore();
  });
});

describe('management address display', () => {
  test('leaves out a port the scheme already implies', () => {
    // The native canonical form always carries the port (one enrollment identity
    // for host and host:443), but a person reading a row should not have to decode
    // it: https says 443.
    expect(serverHostLabel('https://netbird.example.com:443')).toBe('netbird.example.com');
    expect(serverDisplayUrl('https://netbird.example.com:443')).toBe('https://netbird.example.com');
  });

  test('keeps a port that is the only thing telling two servers apart', () => {
    expect(serverHostLabel('https://netbird.example.com:8443')).toBe('netbird.example.com:8443');
    expect(serverDisplayUrl('https://netbird.example.com:8443')).toBe(
      'https://netbird.example.com:8443',
    );
  });

  test('passes through what it cannot parse rather than blanking it', () => {
    expect(serverHostLabel('netbird.example.com')).toBe('netbird.example.com');
    expect(serverDisplayUrl('')).toBe('');
  });
});

describe('management address probe', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('reports the control plane when its management API answers', async () => {
    const fetchMock = jest.fn(async () => ({status: 401}));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const probe = await probeManagementServer('https://netbird.example.com:443');

    // `/api/peers` is the marker self-hosted.md uses to prove a deployment, and
    // 401 is the expected answer to an unauthenticated call - a positive result,
    // not a failure.
    expect(fetchMock).toHaveBeenCalledWith('https://netbird.example.com/api/peers');
    expect(probe.verdict).toBe('management');
    expect(probe.reachable).toBe(true);
  });

  test('accepts an API that answers without credentials too', async () => {
    globalThis.fetch = jest.fn(async () => ({status: 200})) as unknown as typeof fetch;

    const probe = await probeManagementServer('https://netbird.example.com');

    expect(probe.verdict).toBe('management');
  });

  test('reports a host that answers but is not this control plane', async () => {
    globalThis.fetch = jest.fn(async () => ({status: 404})) as unknown as typeof fetch;

    const probe = await probeManagementServer('https://netbird.example.com');

    // TLS and the host are proven; the address is just not a NetBird deployment,
    // which is a different problem from an unreachable one.
    expect(probe.verdict).toBe('answering');
    expect(probe.detail).toBe('HTTP 404');
  });

  test('reports why nothing answered instead of claiming to be reachable', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('Network request failed');
    }) as unknown as typeof fetch;

    const probe = await probeManagementServer('https://netbird.example.com');

    expect(probe.reachable).toBe(false);
    expect(probe.verdict).toBe('unreachable');
    expect(probe.detail).toContain('Network request failed');
  });

  test('refuses what it cannot parse without inventing a scheme', async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const probe = await probeManagementServer('netbird.example.com');

    // The native rule requires the scheme; a probe that guessed one would test
    // an address the save would then refuse.
    expect(probe.verdict).toBe('unreachable');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the bundled browser container', () => {
  test('Android has one, iOS does not', () => {
    // The predicate the app uses instead of calling an entry that can only reject.
    expect(hasBundledBrowserContainer('android')).toBe(true);
    expect(hasBundledBrowserContainer('ios')).toBe(false);
  });
});

describe('returning to the foreground', () => {
  test('re-reads a healthy catalogue once it has aged', () => {
    // Nothing pushes this list: without the re-read, a machine that joined the fleet or one
    // that went away stays invisible until someone pulls to refresh.
    const now = 10_000_000;
    expect(
      shouldRefreshOnForeground({lastLoadAt: now - FOREGROUND_REFRESH_MIN_MS, now, failures: 0}),
    ).toBe(true);
  });

  test('does not probe the fleet on every quick app switch', () => {
    const now = 10_000_000;
    expect(shouldRefreshOnForeground({lastLoadAt: now - 1_000, now, failures: 0})).toBe(false);
    expect(shouldRefreshOnForeground({lastLoadAt: 0, now, failures: 0})).toBe(false);
  });

  test('a failing catalogue is refreshed immediately', () => {
    // Its backoff timers may have been throttled while the app was backgrounded.
    expect(shouldRefreshOnForeground({lastLoadAt: 10_000_000, now: 10_000_000, failures: 2})).toBe(
      true,
    );
  });
});
