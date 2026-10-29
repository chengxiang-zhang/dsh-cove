import {NetBirdPortal, AppVersion} from './NetBirdPortal';
import {Platform} from 'react-native';

import {BOOTSTRAP_CONFIG_URLS, getFleetConfig} from './fleetConfig';
import {withTimeout} from './netbird';

/**
 * In-app self-update flow: read a version manifest from the update channel,
 * optionally download the new APK and hand it to the system installer.
 *
 * The manifest used to be read only through the embedded netstack, from the one
 * public name, with no ceiling. Measured on a fully connected device that call
 * failed, and it failed slowly: the native fetch retries for 90 seconds before
 * giving up, so tapping "check for updates" sat on "checking" for a minute and a
 * half and then reported a failure. Nobody was ever offered a new version, which
 * is how a phone ends up stuck releases behind.
 *
 * The channel is public HTTPS by design - publish.sh serves it so that "phones
 * on ordinary WiFi, no NetBird" can download - and loadFleetConfig already
 * proves the shape that works: try the public origin, then the overlay one, each
 * with a short deadline. The manifest now does the same, over the device's own
 * network first (which is what the cleartext policy assumes: the update channel
 * needs no exception) and the tunnel second.
 */

/** One attempt against one origin. The native retry budget is far longer. */
export const MANIFEST_ATTEMPT_TIMEOUT_MS = 6000;

/** Ceiling for the whole check, so a manual tap always resolves promptly. */
export const MANIFEST_CHECK_TIMEOUT_MS = 20000;

export type UpdateManifest = {
  versionCode: number;
  versionName: string;
  apkUrl: string;
  notes?: string;
};

export type UpdateCheckResult = {
  manifest: UpdateManifest;
  current: AppVersion;
};

/**
 * Resolves the manifest's APK location against the configured channel. A
 * relative `apkUrl` (or a bare filename) is what publish.sh writes, so the
 * channel host lives in exactly one place: the fleet config.
 */
export function resolveApkUrl(apkUrl: string, apkBaseUrl: string): string {
  const value = (apkUrl || '').trim();
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const base = apkBaseUrl.endsWith('/') ? apkBaseUrl : `${apkBaseUrl}/`;
  return `${base}${value.replace(/^\/+/, '')}`;
}

/**
 * The manifest URL on every origin the fleet config already trusts, in the same
 * order and for the same reasons: the public HTTPS name first, then the overlay
 * name for a device that cannot reach it.
 */
export function manifestCandidates(config = getFleetConfig()): string[] {
  const derived = BOOTSTRAP_CONFIG_URLS.map(url => url.replace(/fleet\.json$/, 'version.json'));
  const seen = new Set<string>();
  return [config.manifestUrl, ...derived].filter(url => {
    if (!url || seen.has(url)) {
      return false;
    }
    seen.add(url);
    return true;
  });
}

/**
 * Read one origin over whichever transport can reach it. The device's own
 * network is tried first because that is how the same channel's fleet.json is
 * already read; the embedded netstack is the fallback, not the only path.
 */
async function readManifest(url: string): Promise<{body: string; base: string} | null> {
  try {
    if (typeof fetch === 'function') {
      const response = await withTimeout(
        fetch(url).then(async r => ({ok: r.ok, text: await r.text()})),
        MANIFEST_ATTEMPT_TIMEOUT_MS,
        'manifest fetch timed out',
      );
      if (response.ok) {
        return {body: response.text, base: url};
      }
    }
  } catch {
    // Fall through to the tunnel; a public name can be unreachable on a locked
    // down network while the overlay still answers.
  }
  try {
    const result = await withTimeout(
      NetBirdPortal.fetch(url),
      MANIFEST_ATTEMPT_TIMEOUT_MS,
      'manifest fetch timed out',
    );
    if (result.statusCode === 200) {
      return {body: result.body, base: url};
    }
  } catch {
    // Try the next origin.
  }
  return null;
}

/**
 * Whether the channel's update flow applies to this platform.
 *
 * The manifest describes the Android package: an integer `versionCode` and an APK to hand
 * to the system installer. iOS has neither - updates arrive through TestFlight or the App
 * Store, and no app installs one from a file - so offering an update there would download
 * something that cannot be installed. The check is skipped instead of failing.
 */
export function updateFlowApplies(platform: string = Platform.OS): boolean {
  return platform !== 'ios';
}

/**
 * Returns the newer manifest, or null when this install is already current.
 *
 * A channel that cannot be read throws, so a manual check can say "check failed"
 * rather than claiming to be up to date. The distinction matters: reporting an
 * unreachable channel as "up to date" is how an update goes unnoticed.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult | null> {
  if (!updateFlowApplies()) {
    return null;
  }
  const config = getFleetConfig();
  const candidates = manifestCandidates(config);

  const attempt = async (): Promise<UpdateCheckResult | null> => {
    for (const url of candidates) {
      const read = await readManifest(url);
      if (!read) {
        continue;
      }
      try {
        const parsed = JSON.parse(read.body) as UpdateManifest;
        const base = read.base.replace(/version\.json$/, '');
        const manifest: UpdateManifest = {
          ...parsed,
          // Resolve against the origin that actually answered, so an overlay
          // answer downloads over the overlay instead of the public name.
          apkUrl: resolveApkUrl(parsed.apkUrl, base || config.apkBaseUrl),
        };
        const current = await NetBirdPortal.getAppVersion();
        console.info('UPDATE_MANIFEST_OK', url, manifest.versionCode);
        if (manifest.versionCode <= current.versionCode) {
          return null;
        }
        return {manifest, current};
      } catch {
        // Unparseable origin: try the next one.
      }
    }
    throw new Error('更新通道无法访问，请检查网络后重试');
  };

  return withTimeout(attempt(), MANIFEST_CHECK_TIMEOUT_MS, '更新检查超时，请重试');
}

export type DownloadProgress = {
  bytes: number;
  total: number;
  percent: number;
};

/**
 * The native downloader resumes from a `.part` file and keeps it when the
 * range can no longer be satisfied, so the same request fails forever and the
 * user has to clear app data. This is how that state surfaces.
 */
const RESUME_CONFLICT = /416|range not satisfiable|requested range/i;

const PROGRESS_POLL_MS = 500;

/** No byte progress for this long means the transfer is stuck. */
export const DOWNLOAD_STALL_TIMEOUT_MS = 120_000;

export function isResumeConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return RESUME_CONFLICT.test(message);
}

async function transfer(
  url: string,
  destPath: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  let lastBytes = -1;
  let lastProgressAt = Date.now();
  let stalled = false;
  const poller = setInterval(async () => {
    try {
      const state = await NetBirdPortal.downloadState();
      if (state.bytes > lastBytes) {
        lastBytes = state.bytes;
        lastProgressAt = Date.now();
      }
      if (state.active && state.total > 0 && onProgress) {
        onProgress({
          bytes: state.bytes,
          total: state.total,
          percent: Math.min(100, Math.round((state.bytes / state.total) * 100)),
        });
      }
      if (!stalled && state.active && Date.now() - lastProgressAt >= DOWNLOAD_STALL_TIMEOUT_MS) {
        // The native reader sets no deadline, so a peer that stops sending
        // without closing would freeze this transfer and keep every later
        // download refused with "download already in progress".
        stalled = true;
        await NetBirdPortal.cancelDownload();
      }
    } catch {
      // transient poll failure is fine; the download promise decides
    }
  }, PROGRESS_POLL_MS);
  try {
    await NetBirdPortal.downloadApk(url, destPath);
  } catch (error) {
    if (stalled) {
      throw new Error('下载长时间没有进展，已取消；网络恢复后可以重试（支持断点续传）');
    }
    throw error;
  } finally {
    clearInterval(poller);
  }
}

/**
 * Downloads the new APK into app-private storage and hands it to the system
 * installer. The native downloader picks the transport from the URL
 * (native/download.go, transportOrder): the public channel goes out over the
 * device network, an overlay address through the tunnel. Neither can stand in
 * for the other, which is why this used to fail on a connected phone with
 * "dial: lookup ...: server misbehaving" - the public URL the manifest had just
 * answered from was handed to the tunnel-only client. `onProgress` is called
 * while the transfer runs; pass a cancel predicate via the returned controller.
 */
export async function downloadAndInstall(
  manifest: UpdateManifest,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const dir = await NetBirdPortal.getDownloadsDir();
  // Version-specific partials can be resumed safely without ever appending
  // bytes from one release to a different APK.
  const destPath = `${dir}/NetBirdPortal-update-v${manifest.versionCode}.apk`;
  try {
    await transfer(manifest.apkUrl, destPath, onProgress);
  } catch (error) {
    if (!isResumeConflict(error)) {
      throw error;
    }
    // One clean pass, so a poisoned partial cannot wedge the update forever.
    try {
      await NetBirdPortal.deleteFile(destPath);
    } catch (deleteError) {
      console.warn('NETBIRD_UPDATE_PARTIAL_DELETE_FAILED', deleteError);
    }
    await transfer(manifest.apkUrl, destPath, onProgress);
  }
  await NetBirdPortal.installApk(destPath);
}

export function cancelUpdateDownload(): Promise<void> {
  return NetBirdPortal.cancelDownload();
}