/**
 * Where the page comes from.
 *
 * A platform that can point its browser at the forward proxy loads the service's own
 * address. iOS cannot - WKWebView has no proxy API - so the engine there serves the page
 * from a loopback origin and the view loads that instead. These tests pin the difference,
 * because getting it wrong looks like "the page is blank" on one platform only.
 *
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {Platform} from 'react-native';

jest.mock('react-native-webview', () => ({
  WebView: require('react-native').View,
}));

jest.mock('../src/NetBirdPortal', () => ({
  NetBirdPortal: {
    startPageProxy: jest.fn(() => Promise.resolve('http://127.0.0.1:19002/')),
    stopPageProxy: jest.fn(() => Promise.resolve()),
  },
}));

import {NetBirdPortal} from '../src/NetBirdPortal';
import ServiceWebViewScreen from '../src/screens/ServiceWebViewScreen';

const service = {
  name: 'dsh.studio-mac.netbird',
  url: 'http://dsh.studio-mac.netbird/',
  statusCode: 200,
  reachable: true,
  needsLogin: false,
};

const startPageProxyMock = NetBirdPortal.startPageProxy as jest.MockedFunction<
  typeof NetBirdPortal.startPageProxy
>;

/** The web view is mocked as a View, so it is found by the prop only it carries. The
 * tree holds both the element and the host node it renders to; either answers. */
function pageSource(tree: ReactTestRenderer.ReactTestRenderer): string {
  const candidates = tree.root.findAll(node => node.props?.source?.uri !== undefined);
  expect(candidates.length).toBeGreaterThan(0);
  return candidates[0].props.source.uri;
}

async function renderOn(platform: 'ios' | 'android') {
  const previous = Platform.OS;
  Platform.OS = platform;
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <ServiceWebViewScreen
        service={service}
        services={[service]}
        onBack={jest.fn()}
        onSwitch={jest.fn()}
      />,
    );
  });
  return tree as unknown as ReactTestRenderer.ReactTestRenderer;
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('iOS loads the page from the loopback origin the engine serves', async () => {
  const tree = await renderOn('ios');
  expect(startPageProxyMock).toHaveBeenCalledWith(service.url);
  expect(pageSource(tree)).toBe('http://127.0.0.1:19002/');
});

test('a platform with a browser-level proxy keeps the service address', async () => {
  const tree = await renderOn('android');
  expect(startPageProxyMock).not.toHaveBeenCalled();
  expect(pageSource(tree)).toBe(service.url);
});