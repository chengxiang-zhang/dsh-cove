import {NativeModules} from 'react-native';

export type NetBirdStatus = {
  managementConnected: boolean;
  ip: string;
  fqdn: string;
};

export type NetBirdFetchResult = {
  url: string;
  statusCode: number;
  body: string;
};

export type ServiceRecord = {
  name: string;
  type: number;
  class: string;
  content: string;
  zone: string;
};

export type ProbeResult = {
  url: string;
  statusCode: number;
  reachable: boolean;
};

export type AuthVerdict =
  | 'unknown'
  | 'valid'
  | 'login_required'
  | 'management_unreachable';

/**
 * The control plane this install enrolls against (native `serverConfigJson`):
 * the address in force, the compiled default a "restore default" action returns
 * to, and whether the current address is the user's own choice.
 */
export type ServerConfig = {
  url: string;
  defaultUrl: string;
  isCustom: boolean;
};

/**
 * Outcome of choosing a management server. `changed` means the local enrollment
 * was dropped along with the old control plane, so the caller has to end the
 * session and send the user back through sign-in.
 */
export type ServerChange = {
  url: string;
  changed: boolean;
};

/**
 * Why the last connection attempt stopped. Shown as one line on the service
 * list, so a stuck install can be diagnosed from a screenshot.
 */
export type ConnectionDiagnostics = {
  serviceRunning: boolean;
  stage: string;
  lastError: string;
  failures: number;
  hardResets: number;
  authVerdict: AuthVerdict;
};

type NativeNetBirdPortal = {
  verify(setupKey: string, url: string): Promise<string>;
  /** Engine up + loopback proxy URL, with no HTTP probe (see netbird.ts). */
  ensureServiceReady(): Promise<string>;
  startProxy(): Promise<string>;
  applyWebViewProxy(proxyUrl: string): Promise<void>;
  clearWebViewProxy(): Promise<void>;
  /**
   * Serve a page from a loopback origin and answer with that origin.
   *
   * The platforms that can point a browser at the forward proxy use `applyWebViewProxy`;
   * iOS cannot, so the engine serves the page itself and the view loads the loopback
   * address instead of the private-network one.
   */
  startPageProxy(url: string): Promise<string>;
  stopPageProxy(): Promise<void>;
  status(): Promise<string>;
  fetch(url: string): Promise<string>;
  stop(): Promise<void>;
  listServices(): Promise<string>;
  probe(url: string): Promise<string>;
  hasPersistedConfig(): Promise<boolean>;
  resumeConnection(): Promise<void>;
  resetConnection(): Promise<void>;
  diagnostics(): Promise<string>;
  /** Management server in force, its compiled default, and whether it is a choice. */
  getServerConfig(): Promise<string>;
  setServerUrl(url: string): Promise<string>;
  resetServerUrl(): Promise<string>;
  reportServiceCount(count: number): Promise<void>;
  clearServiceCount(): Promise<void>;
  /** Finished-run notification switch; the foreground service owns the polling. */
  getRunNotificationsEnabled(): Promise<boolean>;
  setRunNotificationsEnabled(enabled: boolean): Promise<void>;
  clearWebSessions(): Promise<void>;
  clearWebViewCache(): Promise<void>;
  downloadApk(url: string, destPath: string): Promise<string>;
  downloadState(): Promise<string>;
  cancelDownload(): Promise<void>;
  installApk(destPath: string): Promise<void>;
  getAppVersion(): Promise<string>;
  getDownloadsDir(): Promise<string>;
  /** Removes one of this app's own download files (scope-checked natively). */
  deleteFile(path: string): Promise<boolean>;
  loginSSO(): Promise<string>;
  ssoStatus(): Promise<string>;
  openGeckoService(url: string, authorizedDshHost?: string): Promise<void>;
};

const nativePortal = NativeModules.NetBirdPortal as NativeNetBirdPortal;

export const NetBirdPortal = {
  async verify(setupKey: string, url: string): Promise<NetBirdFetchResult> {
    return JSON.parse(await nativePortal.verify(setupKey, url)) as NetBirdFetchResult;
  },
  /**
   * Brings the engine up and returns the loopback proxy URL. Deliberately does
   * no HTTP fetch: a liveness probe through the embedded netstack is what broke
   * login twice, because that resolver does not answer the names it was given.
   */
  ensureServiceReady(): Promise<string> {
    return nativePortal.ensureServiceReady();
  },
  startProxy(): Promise<string> {
    return nativePortal.startProxy();
  },
  applyWebViewProxy(proxyUrl: string): Promise<void> {
    return nativePortal.applyWebViewProxy(proxyUrl);
  },
  clearWebViewProxy(): Promise<void> {
    return nativePortal.clearWebViewProxy();
  },
  startPageProxy(url: string): Promise<string> {
    return nativePortal.startPageProxy(url);
  },
  stopPageProxy(): Promise<void> {
    return nativePortal.stopPageProxy();
  },
  async status(): Promise<NetBirdStatus> {
    return JSON.parse(await nativePortal.status()) as NetBirdStatus;
  },
  async fetch(url: string): Promise<NetBirdFetchResult> {
    return JSON.parse(await nativePortal.fetch(url)) as NetBirdFetchResult;
  },
  stop(): Promise<void> {
    return nativePortal.stop();
  },
  async listServices(): Promise<ServiceRecord[]> {
    return JSON.parse(await nativePortal.listServices()) as ServiceRecord[];
  },
  async probe(url: string): Promise<ProbeResult> {
    return JSON.parse(await nativePortal.probe(url)) as ProbeResult;
  },
  hasPersistedConfig(): Promise<boolean> {
    return nativePortal.hasPersistedConfig();
  },
  resumeConnection(): Promise<void> {
    return nativePortal.resumeConnection();
  },
  /**
   * Rebuilds the embedded engine. Repeated `Portal.start()` calls are no-ops
   * while an instance exists, so a stalled engine only recovers through this.
   */
  resetConnection(): Promise<void> {
    return nativePortal.resetConnection();
  },
  async diagnostics(): Promise<ConnectionDiagnostics> {
    return JSON.parse(await nativePortal.diagnostics()) as ConnectionDiagnostics;
  },
  /**
   * Feeds the reachable-machine count to the ongoing notification. Best
   * effort: a stale count in a notification must never break the catalogue.
   */
  async reportServiceCount(count: number): Promise<void> {
    try {
      await nativePortal.reportServiceCount(count);
    } catch (error) {
      console.warn('NETBIRD_SERVICE_COUNT_FAILED', error);
    }
  },
  async clearServiceCount(): Promise<void> {
    try {
      await nativePortal.clearServiceCount();
    } catch (error) {
      console.warn('NETBIRD_SERVICE_COUNT_CLEAR_FAILED', error);
    }
  },
  /**
   * Whether the phone raises a normal notification when a task started from it
   * finishes on a machine. The foreground service does the polling; this only
   * reads the stored switch. An unreadable value reads as enabled, matching the
   * native default, because the alternative is silently switching off the one
   * alert the user asked for.
   */
  async getRunNotificationsEnabled(): Promise<boolean> {
    try {
      return await nativePortal.getRunNotificationsEnabled();
    } catch (error) {
      console.warn('NETBIRD_RUN_NOTIFY_READ_FAILED', error);
      return true;
    }
  },
  /**
   * Persists the switch. The service reads the same preference on every poll,
   * so this takes effect without reconnecting; turning it off also withdraws
   * the notification already in the shade.
   */
  setRunNotificationsEnabled(enabled: boolean): Promise<void> {
    return nativePortal.setRunNotificationsEnabled(enabled);
  },
  clearWebSessions(): Promise<void> {
    return nativePortal.clearWebSessions();
  },
  clearWebViewCache(): Promise<void> {
    return nativePortal.clearWebViewCache();
  },
  async downloadApk(url: string, destPath: string): Promise<DownloadResult> {
    return JSON.parse(await nativePortal.downloadApk(url, destPath)) as DownloadResult;
  },
  async downloadState(): Promise<DownloadState> {
    return JSON.parse(await nativePortal.downloadState()) as DownloadState;
  },
  cancelDownload(): Promise<void> {
    return nativePortal.cancelDownload();
  },
  installApk(destPath: string): Promise<void> {
    return nativePortal.installApk(destPath);
  },
  async getAppVersion(): Promise<AppVersion> {
    return JSON.parse(await nativePortal.getAppVersion()) as AppVersion;
  },
  getDownloadsDir(): Promise<string> {
    return nativePortal.getDownloadsDir();
  },
  deleteFile(path: string): Promise<boolean> {
    return nativePortal.deleteFile(path);
  },
  /**
   * The management server this install enrolls against, its compiled default and
   * whether the current one is the user's choice. Read natively so a screen
   * cannot display an address the engine stopped using.
   */
  async getServerConfig(): Promise<ServerConfig> {
    return JSON.parse(await nativePortal.getServerConfig()) as ServerConfig;
  },
  /**
   * Chooses the management server. The rule (https origin, host and port only)
   * lives natively, so a value a screen accepts is always one the engine can
   * dial; a rejection arrives as NETBIRD_SERVER_URL with the reason to show.
   */
  async setServerUrl(url: string): Promise<ServerChange> {
    return JSON.parse(await nativePortal.setServerUrl(url)) as ServerChange;
  },
  /** Goes back to the compiled default, with the same re-enrollment consequence. */
  async resetServerUrl(): Promise<ServerChange> {
    return JSON.parse(await nativePortal.resetServerUrl()) as ServerChange;
  },
  loginSSO(): Promise<string> {
    return nativePortal.loginSSO();
  },
  async ssoStatus(): Promise<SSOStatus> {
    return JSON.parse(await nativePortal.ssoStatus()) as SSOStatus;
  },
  /** Opens one registered DSH service in the bundled GeckoView engine. */
  openGeckoService(url: string, authorizedDshHost = ''): Promise<void> {
    return nativePortal.openGeckoService(url, authorizedDshHost);
  },
};

export type SSOStatus = {
  state: 'not_started' | 'waiting' | 'done' | 'error';
  url?: string;
  error?: string;
};

export type DownloadResult = {
  destPath: string;
  bytes: number;
  total: number;
};

export type DownloadState = {
  active: boolean;
  destPath: string;
  bytes: number;
  total: number;
};

export type AppVersion = {
  versionCode: number;
  versionName: string;
};