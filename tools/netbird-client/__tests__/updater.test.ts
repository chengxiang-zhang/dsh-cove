/**
 * In-app update delivery: a stuck or poisoned transfer must stay recoverable.
 *
 * @format
 */

jest.mock('../src/NetBirdPortal', () => ({
  NetBirdPortal: {
    fetch: jest.fn(),
    getAppVersion: jest.fn(),
    getDownloadsDir: jest.fn(),
    downloadApk: jest.fn(),
    downloadState: jest.fn(),
    cancelDownload: jest.fn(),
    deleteFile: jest.fn(),
    installApk: jest.fn(),
  },
}));

import {Platform} from 'react-native';

// This suite is the Android update flow: an integer versionCode, an APK downloaded over
// the tunnel and handed to the system installer. The iOS build skips that flow entirely
// (see updater-ios.test.ts), so the platform is stated here rather than inherited from
// the jest preset's default.
Platform.OS = 'android';

import {NetBirdPortal} from '../src/NetBirdPortal';
import {
  DOWNLOAD_STALL_TIMEOUT_MS,
  MANIFEST_ATTEMPT_TIMEOUT_MS,
  UpdateManifest,
  checkForUpdate,
  downloadAndInstall,
  isResumeConflict,
  manifestCandidates,
} from '../src/updater';

/**
 * Node ships a real global fetch, and the update check now reads over the
 * device's own network first. Without this stub the suite would talk to the live
 * channel and pass or fail according to connectivity - a test that can only be
 * trusted while online is worse than no test.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = jest.fn(async () => {
    throw new Error('offline in tests');
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const manifest: UpdateManifest = {
  versionCode: 19,
  versionName: '2.5.3',
  apkUrl: 'http://apk.dl-dev/NetBirdPortal.apk',
};

const downloadedPath = '/data/downloads/NetBirdPortal-update-v19.apk';

describe('in-app update delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (NetBirdPortal.getDownloadsDir as jest.Mock).mockResolvedValue('/data/downloads');
    (NetBirdPortal.downloadState as jest.Mock).mockResolvedValue({
      active: false,
      destPath: '',
      bytes: 0,
      total: 0,
    });
    (NetBirdPortal.downloadApk as jest.Mock).mockResolvedValue({
      destPath: downloadedPath,
      bytes: 1,
      total: 1,
    });
    (NetBirdPortal.deleteFile as jest.Mock).mockResolvedValue(true);
    (NetBirdPortal.installApk as jest.Mock).mockResolvedValue(undefined);
  });

  test('recognises the native resume conflict', () => {
    expect(isResumeConflict(new Error('resume /data/x.apk: HTTP 416'))).toBe(true);
    expect(isResumeConflict(new Error('network is unreachable'))).toBe(false);
  });

  test('drops a poisoned partial and retries once', async () => {
    (NetBirdPortal.downloadApk as jest.Mock)
      .mockRejectedValueOnce(new Error('resume ' + downloadedPath + ': HTTP 416'))
      .mockResolvedValueOnce({destPath: downloadedPath, bytes: 2, total: 2});

    await expect(downloadAndInstall(manifest)).resolves.toBeUndefined();

    expect(NetBirdPortal.deleteFile).toHaveBeenCalledWith(downloadedPath);
    expect(NetBirdPortal.downloadApk).toHaveBeenCalledTimes(2);
    expect(NetBirdPortal.installApk).toHaveBeenCalledWith(downloadedPath);
  });

  test('does not retry a plain network failure', async () => {
    (NetBirdPortal.downloadApk as jest.Mock).mockRejectedValue(
      new Error('network is unreachable'),
    );

    await expect(downloadAndInstall(manifest)).rejects.toThrow('network is unreachable');

    expect(NetBirdPortal.deleteFile).not.toHaveBeenCalled();
    expect(NetBirdPortal.downloadApk).toHaveBeenCalledTimes(1);
  });

  test('cancels a transfer that stops making progress', async () => {
    jest.useFakeTimers();
    try {
      let failDownload: ((error: Error) => void) | undefined;
      (NetBirdPortal.downloadApk as jest.Mock).mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            failDownload = reject;
          }),
      );
      (NetBirdPortal.downloadState as jest.Mock).mockResolvedValue({
        active: true,
        destPath: downloadedPath,
        bytes: 100,
        total: 1000,
      });
      (NetBirdPortal.cancelDownload as jest.Mock).mockImplementation(async () => {
        failDownload?.(new Error('download cancelled'));
      });

      const pending = downloadAndInstall(manifest);
      let failure: Error | undefined;
      const guarded = pending.catch(error => {
        failure = error as Error;
      });

      await jest.advanceTimersByTimeAsync(DOWNLOAD_STALL_TIMEOUT_MS + 1000);
      await guarded;

      expect(failure?.message).toMatch(/没有进展/);
      expect(NetBirdPortal.cancelDownload).toHaveBeenCalledTimes(1);
      expect(NetBirdPortal.installApk).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('reports an update only when the channel is strictly newer', async () => {
    (NetBirdPortal.fetch as jest.Mock).mockResolvedValue({
      url: '',
      statusCode: 200,
      body: JSON.stringify({versionCode: 19, versionName: '2.5.3', apkUrl: 'http://x'}),
    });
    (NetBirdPortal.getAppVersion as jest.Mock).mockResolvedValue({
      versionCode: 19,
      versionName: '2.5.3',
    });
    await expect(checkForUpdate()).resolves.toBeNull();

    (NetBirdPortal.getAppVersion as jest.Mock).mockResolvedValue({
      versionCode: 18,
      versionName: '2.5.2',
    });
    await expect(checkForUpdate()).resolves.toMatchObject({manifest: {versionCode: 19}});
  });
});

/**
 * The update check spent its whole life reading one public name through the
 * embedded netstack with no ceiling, so on a connected device it failed after
 * the native retry budget (~90s) and nobody was ever offered a new version.
 * These pin the two properties that fix it: every origin the fleet config already
 * trusts is tried, and an unreadable channel is reported as a failure instead of
 * as "up to date".
 */
describe('update manifest lookup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (NetBirdPortal.getAppVersion as jest.Mock).mockResolvedValue({versionCode: 10, versionName: '1.0'});
    (NetBirdPortal.fetch as jest.Mock).mockRejectedValue(new Error('tunnel unavailable'));
  });

  test('tries the public origin and then the overlay one, without duplicates', () => {
    const candidates = manifestCandidates();
    expect(candidates[0]).toBe('https://anywhere.example.com/version.json');
    // A literal address on purpose: the netstack resolver does not answer the
    // overlay names, so the fallback must not need a lookup.
    expect(candidates).toContain('http://100.64.0.20/version.json');
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test('reads the manifest over the device network', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({versionCode: 27, versionName: '2.7.1', apkUrl: 'AnywhereWork.apk'}),
    })) as unknown as typeof fetch;

    const found = await checkForUpdate();
    expect(found?.manifest.versionCode).toBe(27);
    // A bare filename resolves against the origin that answered.
    expect(found?.manifest.apkUrl).toBe('https://anywhere.example.com/AnywhereWork.apk');
    expect(NetBirdPortal.fetch).not.toHaveBeenCalled();
  });

  test('falls back to the next origin when the first one fails', async () => {
    let call = 0;
    globalThis.fetch = jest.fn(async (_url: string) => {
      call += 1;
      if (call === 1) {
        throw new Error('public origin unreachable');
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({versionCode: 30, versionName: '3.0.0', apkUrl: 'AnywhereWork.apk'}),
      };
    }) as unknown as typeof fetch;

    const found = await checkForUpdate();
    expect(found?.manifest.versionCode).toBe(30);
    // Resolved against the overlay origin, so the download follows the same route.
    expect(found?.manifest.apkUrl).toBe('http://100.64.0.20/AnywhereWork.apk');
  });

  test('reports an unreadable channel as a failure, not as up to date', async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    await expect(checkForUpdate()).rejects.toThrow(/更新通道无法访问/);
  });

  test('reports up to date only when the channel actually answered', async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({versionCode: 9, versionName: '0.9', apkUrl: 'a.apk'}),
    })) as unknown as typeof fetch;

    await expect(checkForUpdate()).resolves.toBeNull();
  });

  test('does not wait on the native retry budget for a manual tap', () => {
    // The native fetch retries for 90 seconds; the check must not inherit that.
    expect(MANIFEST_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(10000);
  });
});
