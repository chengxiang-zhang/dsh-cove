import {
  BOOTSTRAP_CONFIG_URLS,
  DEFAULT_FLEET_CONFIG,
  fleetConfigLoadedFromRemote,
  getFleetConfig,
  loadFleetConfig,
  mergeFleetConfig,
  resetFleetConfig,
} from '../src/fleetConfig';
import {resolveApkUrl} from '../src/updater';

type FakeResponse = {ok?: boolean; status?: number; text: () => Promise<string>};

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body))};
}

describe('fleet configuration', () => {
  beforeEach(() => {
    resetFleetConfig();
  });

  test('compiled defaults are live endpoints, not placeholders', () => {
    // A dead default is the bug this module exists to prevent: the app uses the
    // defaults before fleet.json can be read and whenever the channel is down.
    expect(DEFAULT_FLEET_CONFIG.manifestUrl).toMatch(/^https:\/\//);
    expect(DEFAULT_FLEET_CONFIG.apkBaseUrl).toMatch(/^https:\/\//);
    expect(DEFAULT_FLEET_CONFIG.managementUrl).toMatch(/^https:\/\//);
    for (const url of [DEFAULT_FLEET_CONFIG.manifestUrl, DEFAULT_FLEET_CONFIG.apkBaseUrl]) {
      expect(url).not.toContain('dl-dev');
    }
  });

  test('the overlay bootstrap does not need a DNS lookup', () => {
    // The embedded netstack's resolver does not answer the names a connect-time
    // probe was given (measured: `lookup tx.vpn ... no such host`), and the
    // overlay fallback goes through the same stack, so it addresses the edge
    // peer by literal. The public origin stays a name because it is fetched
    // over the system network, where DNS works.
    const [publicUrl, overlayUrl] = BOOTSTRAP_CONFIG_URLS;
    expect(publicUrl).toMatch(/^https:\/\//);
    expect(overlayUrl).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+\//);
  });

  test('there is no connect-time probe target to compile any more', () => {
    // The login path must not depend on a URL answering through the netstack.
    expect(Object.keys(DEFAULT_FLEET_CONFIG)).not.toContain('healthUrl');
    expect(Object.keys(DEFAULT_FLEET_CONFIG)).not.toContain('healthUrls');
  });

  test('merges known keys and ignores everything else', () => {
    const merged = mergeFleetConfig({
      managementUrl: 'https://mgmt.example:443',
      manifestUrl: 'https://channel.example/version.json',
      apkBaseUrl: 'https://channel.example/',
      zone: 'NetBird',
      unknown: 'dropped',
      healthUrl: 'http://legacy.example/health',
    });
    expect(merged).toEqual({
      managementUrl: 'https://mgmt.example:443',
      manifestUrl: 'https://channel.example/version.json',
      apkBaseUrl: 'https://channel.example/',
      zone: 'netbird',
    });
  });

  test('a malformed value falls back per key instead of rejecting the document', () => {
    const merged = mergeFleetConfig({apkBaseUrl: 'not-a-url', manifestUrl: 'https://ok.example/v.json'});
    expect(merged?.apkBaseUrl).toBe(DEFAULT_FLEET_CONFIG.apkBaseUrl);
    expect(merged?.manifestUrl).toBe('https://ok.example/v.json');
  });

  test('rejects documents that carry nothing usable', () => {
    expect(mergeFleetConfig(null)).toBeNull();
    expect(mergeFleetConfig('https://channel.example/x.json')).toBeNull();
    expect(mergeFleetConfig({apkBaseUrl: 'ftp://nope', zone: 'has space'})).toBeNull();
  });

  test('reads the first origin that answers', async () => {
    const seen: string[] = [];
    const config = await loadFleetConfig(url => {
      seen.push(url);
      return Promise.resolve(jsonResponse({manifestUrl: 'https://channel.example/version.json'}));
    });
    expect(seen).toEqual([BOOTSTRAP_CONFIG_URLS[0]]);
    expect(config.manifestUrl).toBe('https://channel.example/version.json');
    expect(fleetConfigLoadedFromRemote()).toBe(true);
    expect(getFleetConfig().manifestUrl).toBe('https://channel.example/version.json');
  });

  test('falls through to the overlay origin when the public one is unreachable', async () => {
    const seen: string[] = [];
    const config = await loadFleetConfig(url => {
      seen.push(url);
      if (url === BOOTSTRAP_CONFIG_URLS[0]) {
        return Promise.reject(new Error('offline'));
      }
      return Promise.resolve(jsonResponse({zone: 'netbird'}));
    });
    expect(seen).toEqual([...BOOTSTRAP_CONFIG_URLS]);
    expect(config.zone).toBe('netbird');
  });

  test('keeps the compiled defaults when every origin fails, and never throws', async () => {
    const config = await loadFleetConfig(() => Promise.reject(new Error('no route')));
    expect(config).toEqual(DEFAULT_FLEET_CONFIG);
    expect(fleetConfigLoadedFromRemote()).toBe(false);
  });

  test('a bootstrap response that is not a usable document is skipped', async () => {
    const config = await loadFleetConfig((url) =>
      Promise.resolve(url === BOOTSTRAP_CONFIG_URLS[0] ? jsonResponse({}) : jsonResponse({zone: 'netbird'})),
    );
    expect(config).toEqual({...DEFAULT_FLEET_CONFIG, zone: 'netbird'});
  });

  test('resolves a relative apkUrl against the configured channel', () => {
    expect(resolveApkUrl('AnywhereWork.apk', 'https://channel.example/')).toBe(
      'https://channel.example/AnywhereWork.apk',
    );
    expect(resolveApkUrl('/AnywhereWork.apk', 'https://channel.example')).toBe(
      'https://channel.example/AnywhereWork.apk',
    );
    expect(resolveApkUrl('https://other.example/a.apk', 'https://channel.example/')).toBe(
      'https://other.example/a.apk',
    );
  });
});