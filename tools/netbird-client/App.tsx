import React, {useCallback, useEffect, useState} from 'react';
import {Platform, StyleSheet} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import {
  ServiceInfo,
  clearWebViewSessions,
  ensureConnected,
  hasBundledBrowserContainer,
  hasPersistedLogin,
  resumePersistedConnection,
} from './src/netbird';
import {NetBirdPortal} from './src/NetBirdPortal';
import {loadFleetConfig} from './src/fleetConfig';
import LoginScreen from './src/screens/LoginScreen';
import ServiceListScreen from './src/screens/ServiceListScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import ServerScreen from './src/screens/ServerScreen';
import ServiceWebViewScreen from './src/screens/ServiceWebViewScreen';
import UpdateOverlay from './src/screens/UpdateOverlay';
import {checkForUpdate} from './src/updater';
import {useTheme} from './src/theme/tokens';

export type Screen = 'login' | 'list' | 'service' | 'settings' | 'server';

/**
 * Microphone candidate for one listed DSH service. JavaScript only proposes the
 * service's own host; the native registered-host list remains the authority.
 */
export function authorizedDshHostForService(service: ServiceInfo): string {
  const serviceHost = new URL(service.url).hostname.toLowerCase();
  return service.name.toLowerCase() === serviceHost && serviceHost.startsWith('dsh.')
    ? serviceHost
    : '';
}

export async function restoreInitialScreen(): Promise<Screen> {
  const loggedIn = await hasPersistedLogin();
  if (!loggedIn) {
    return 'login';
  }

  // Cold start is local-only: the foreground service reconnects and retries
  // in the background while the existing login stays valid. Neither a
  // temporary service-start failure nor voice-bridge setup invalidates it.
  try {
    await resumePersistedConnection();
  } catch (error) {
    console.warn('NETBIRD_RESUME_PENDING', error);
  }
  return 'list';
}

function App() {
  const {c} = useTheme();
  const [screen, setScreen] = useState<Screen>('login');
  // Where the management-address screen was opened from, so 返回 goes back there
  // rather than guessing.
  const [serverFrom, setServerFrom] = useState<Screen>('login');
  const [booted, setBooted] = useState(false);
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [current, setCurrent] = useState<ServiceInfo | null>(null);
  const [updateVisible, setUpdateVisible] = useState(false);
  const [silentChecked, setSilentChecked] = useState(false);

  // On launch: if a previous login persisted the network config, auto-connect
  // and skip the login page (N5: 不用每次都得登录).
  useEffect(() => {
    let alive = true;
    // Refresh the fleet configuration in the background. Every address is read
    // through getFleetConfig() at the moment of use, so a late answer is picked
    // up automatically and a missed one costs nothing — the compiled defaults
    // are live endpoints, never placeholders.
    loadFleetConfig().catch(() => {});
    (async () => {
      try {
        const initialScreen = await restoreInitialScreen();
        if (alive) {
          setScreen(initialScreen);
        }
      } catch {
        if (alive) {
          setScreen('login');
        }
      } finally {
        if (alive) {
          setBooted(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Silent startup update check: only prompts when a newer version exists.
  const runSilentCheck = useCallback(async () => {
    if (silentChecked) {
      return;
    }
    setSilentChecked(true);
    try {
      const found = await checkForUpdate();
      if (found) {
        setUpdateVisible(true);
      }
    } catch {
      // offline / transient: skip silently
    }
  }, [silentChecked]);

  useEffect(() => {
    if (booted && screen === 'list') {
      runSilentCheck();
    }
  }, [booted, screen, runSilentCheck]);

  const handleManualCheck = useCallback(async (): Promise<boolean> => {
    const found = await checkForUpdate();
    if (found) {
      setUpdateVisible(true);
      return true;
    }
    return false;
  }, []);

  const handleLogin = useCallback(async () => {
    await ensureConnected('');
    setScreen('list');
  }, []);

  const handleOpen = useCallback(async (service: ServiceInfo) => {
    // DSH services open in the bundled GeckoView engine: a modern kernel that
    // renders the full DSH workspace page regardless of the device's old
    // system WebView. The loopback NetBird proxy port was stored by
    // ensureConnected() -> startProxy(), so the engine routes via the tunnel.
    //
    // A platform without that container (iOS) goes straight to the in-app screen:
    // calling an entry that can only reject would leave a warning behind on every
    // open and say nothing a person could act on.
    if (!hasBundledBrowserContainer(Platform.OS)) {
      setCurrent(service);
      setScreen('service');
      return;
    }
    try {
      await NetBirdPortal.openGeckoService(
        service.url,
        authorizedDshHostForService(service),
      );
    } catch (error) {
      // The in-app WebView screen remains the fallback path.
      setCurrent(service);
      setScreen('service');
      console.warn('GECKO_OPEN_FAILED', error);
    }
  }, []);

  const handleSwitch = useCallback((service: ServiceInfo) => {
    setCurrent(service);
  }, []);

  const handleBack = useCallback(() => {
    setScreen('list');
  }, []);

  const returnToLogin = useCallback(() => {
    setCurrent(null);
    setServices([]);
    setScreen('login');
  }, []);

  const handleAuthRequired = useCallback(() => {
    returnToLogin();
  }, [returnToLogin]);

  const handleLogout = useCallback(async () => {
    try {
      await clearWebViewSessions();
    } catch (error) {
      // Best effort by design: the user asked to leave this install to get
      // unstuck, so the login screen must be reached even when the native
      // teardown fails (its stop call waits on the same wedged service).
      console.warn('NETBIRD_LOGOUT_INCOMPLETE', error);
    } finally {
      returnToLogin();
    }
  }, [returnToLogin]);

  const openServer = useCallback((from: Screen) => {
    setServerFrom(from);
    setScreen('server');
  }, []);

  // Switching the management server drops the enrollment that belonged to the old
  // control plane, so a change leaves through the same path as a sign-out:
  // sessions and proxy cleared, back to the login screen. An unchanged address
  // (or a reset back to it) just returns to whichever screen opened this one.
  const handleServerSaved = useCallback(
    (result: {url: string; changed: boolean}) => {
      if (result.changed) {
        handleLogout();
        return;
      }
      setScreen(serverFrom);
    },
    [handleLogout, serverFrom],
  );

  if (!booted) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={[styles.safe, {backgroundColor: c.bg}]} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.safe, {backgroundColor: c.bg}]}>
        {screen === 'login' && (
          <LoginScreen onLogin={handleLogin} onOpenServer={() => openServer('login')} />
        )}
        {screen === 'list' && (
          <ServiceListScreen
            onOpen={handleOpen}
            onAuthRequired={handleAuthRequired}
            onLogout={handleLogout}
            onOpenSettings={() => setScreen('settings')}
            onServicesLoaded={setServices}
          />
        )}
        {screen === 'settings' && (
          <SettingsScreen
            machineCount={booted ? services.length : null}
            onBack={() => setScreen('list')}
            onCheckUpdate={handleManualCheck}
            onLogout={handleLogout}
            onOpenServer={() => openServer('settings')}
          />
        )}
        {screen === 'server' && (
          <ServerScreen onBack={() => setScreen(serverFrom)} onSaved={handleServerSaved} />
        )}
        {screen === 'service' && current && (
          <ServiceWebViewScreen
            onBack={handleBack}
            onSwitch={handleSwitch}
            service={current}
            services={services.length > 0 ? services : [current]}
          />
        )}
        {screen === 'service' && !current && (
          <ServiceListScreen
            onOpen={handleOpen}
            onAuthRequired={handleAuthRequired}
            onLogout={handleLogout}
            onOpenSettings={() => setScreen('settings')}
            onServicesLoaded={setServices}
          />
        )}
        <UpdateOverlay
          check={checkForUpdate}
          onClose={() => setUpdateVisible(false)}
          visible={updateVisible}
        />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  // Opaque from the first frame: the native launch background shows through
  // until the root view paints, so the colour is applied per theme at render.
  safe: {flex: 1},
});

export default App;