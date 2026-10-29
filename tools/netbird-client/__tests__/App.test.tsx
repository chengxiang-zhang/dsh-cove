/**
 * @format
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

jest.mock('react-native-webview', () => ({
  WebView: require('react-native').View,
}));

// The app queries the native NetBird module on mount; stub it so the
// component tree renders regardless of native availability.
jest.mock('../src/NetBirdPortal', () => ({
  NetBirdPortal: {
    verify: jest.fn(() => Promise.resolve({url: '', statusCode: 200, body: ''})),
    startProxy: jest.fn(() => Promise.resolve('http://127.0.0.1:1')),
    applyWebViewProxy: jest.fn(() => Promise.resolve()),
    clearWebViewProxy: jest.fn(() => Promise.resolve()),
    loginSSO: jest.fn(() => Promise.resolve('https://netbird.example/oauth2/auth')),
    ssoStatus: jest.fn(() => Promise.resolve({state: 'waiting'})),
    status: jest.fn(() =>
      Promise.resolve({managementConnected: true, ip: '100.64.1.1', fqdn: 'x'}),
    ),
    fetch: jest.fn(() => Promise.resolve({url: '', statusCode: 200, body: ''})),
    stop: jest.fn(() => Promise.resolve()),
    listServices: jest.fn(() => Promise.resolve([])),
    probe: jest.fn(() =>
      Promise.resolve({url: 'http://dsh.studio-mac.netbird', statusCode: 200, reachable: true}),
    ),
    hasPersistedConfig: jest.fn(() => Promise.resolve(false)),
    resumeConnection: jest.fn(() => Promise.resolve()),
    clearWebSessions: jest.fn(() => Promise.resolve()),
    openGeckoService: jest.fn(() => Promise.resolve()),
    listBookmarks: jest.fn(() => Promise.resolve([])),
    getServerConfig: jest.fn(() =>
      Promise.resolve({
        url: 'https://netbird.example.com:443',
        defaultUrl: 'https://netbird.example.com:443',
        isCustom: false,
      }),
    ),
    setServerUrl: jest.fn(() =>
      Promise.resolve({url: 'https://netbird.example.com:443', changed: false}),
    ),
    resetServerUrl: jest.fn(() =>
      Promise.resolve({url: 'https://netbird.example.com:443', changed: false}),
    ),
  },
}));

import App, {authorizedDshHostForService, restoreInitialScreen} from '../App';
import {NetBirdPortal} from '../src/NetBirdPortal';

const hasPersistedConfigMock = NetBirdPortal.hasPersistedConfig as jest.MockedFunction<
  typeof NetBirdPortal.hasPersistedConfig
>;
const resumeConnectionMock = NetBirdPortal.resumeConnection as jest.MockedFunction<
  typeof NetBirdPortal.resumeConnection
>;

describe('DSH service microphone authorization', () => {
  test('binds only a discovered service whose name matches its URL host', () => {
    const base = {statusCode: 200, reachable: true, needsLogin: false};
    expect(
      authorizedDshHostForService({
        ...base,
        name: 'dsh.studio-mac.netbird',
        url: 'http://dsh.studio-mac.netbird/conversation/1',
      }),
    ).toBe('dsh.studio-mac.netbird');
    expect(
      authorizedDshHostForService({
        ...base,
        name: 'dsh.studio-mac.netbird',
        url: 'https://dsh.attacker.com',
      }),
    ).toBe('');
    expect(
      authorizedDshHostForService({
        ...base,
        name: 'wiki.studio-mac.netbird',
        url: 'http://wiki.studio-mac.netbird',
      }),
    ).toBe('');
  });
});

describe('App cold start', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hasPersistedConfigMock.mockResolvedValue(false);
    resumeConnectionMock.mockResolvedValue(undefined);
  });

  test('selects login when no persisted identity exists', async () => {
    await expect(restoreInitialScreen()).resolves.toBe('login');
    expect(resumeConnectionMock).not.toHaveBeenCalled();
  });

  test('keeps the saved login when background resume is temporarily unavailable', async () => {
    hasPersistedConfigMock.mockResolvedValue(true);
    resumeConnectionMock.mockRejectedValue(new Error('network is not ready'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(restoreInitialScreen()).resolves.toBe('list');

    expect(resumeConnectionMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('NETBIRD_RESUME_PENDING', expect.any(Error));
    warn.mockRestore();
  });

  test('renders without native modules', async () => {
    await act(async () => {
      ReactTestRenderer.create(<App />);
    });
  });
});
