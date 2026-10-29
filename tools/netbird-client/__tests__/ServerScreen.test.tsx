/**
 * The management-address screen: the single edit surface both entry points
 * navigate to (the login row and the settings row), so its contract is pinned
 * here rather than through either screen.
 *
 * It replaced a card that expanded inside those two lists. The reason it is a
 * screen is in the module comment, and the reason it is worth a test is that it
 * is reachable before sign-in: a fresh install has nothing else to check an
 * address with.
 *
 * @format
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

jest.mock('../src/NetBirdPortal', () => ({
  NetBirdPortal: {
    getServerConfig: jest.fn(),
    setServerUrl: jest.fn(),
    resetServerUrl: jest.fn(),
  },
}));

import ServerScreen from '../src/screens/ServerScreen';
import {NetBirdPortal} from '../src/NetBirdPortal';

const getServerConfigMock = NetBirdPortal.getServerConfig as jest.MockedFunction<
  typeof NetBirdPortal.getServerConfig
>;
const setServerUrlMock = NetBirdPortal.setServerUrl as jest.MockedFunction<
  typeof NetBirdPortal.setServerUrl
>;

const DEFAULT_SERVER = {
  url: 'https://netbird.example.com:443',
  defaultUrl: 'https://netbird.example.com:443',
  isCustom: false,
};
const CUSTOM_SERVER = {
  url: 'https://nb.corp.example:8443',
  defaultUrl: 'https://netbird.example.com:443',
  isCustom: true,
};

async function renderScreen(
  props: Partial<React.ComponentProps<typeof ServerScreen>> = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <ServerScreen onBack={jest.fn()} onSaved={jest.fn()} {...props} />,
    );
  });
  return tree as unknown as ReactTestRenderer.ReactTestRenderer;
}

describe('management address screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getServerConfigMock.mockResolvedValue(DEFAULT_SERVER);
    setServerUrlMock.mockResolvedValue({url: CUSTOM_SERVER.url, changed: true});
  });

  test('opens on the address in force, in the form a person reads', async () => {
    const tree = await renderScreen();

    // https already implies 443, and the field arrives filled so the reader can
    // see what a save would keep.
    expect(tree.root.findByProps({testID: 'server-editor-input'}).props.value).toBe(
      'https://netbird.example.com',
    );
    expect(tree.root.findByProps({testID: 'server-back'})).toBeTruthy();
  });

  test('reports a save back to its caller with the native verdict', async () => {
    const onSaved = jest.fn();
    const tree = await renderScreen({onSaved});

    await act(async () => {
      tree.root
        .findByProps({testID: 'server-editor-input'})
        .props.onChangeText(CUSTOM_SERVER.url);
    });
    await act(async () => {
      await tree.root.findByProps({testID: 'server-editor-save'}).props.onPress();
    });

    // `changed` is the caller's cue to sign out: the enrollment belonged to the
    // old control plane.
    expect(onSaved).toHaveBeenCalledWith({url: CUSTOM_SERVER.url, changed: true});
  });

  test('leaves through the back control without saving', async () => {
    const onBack = jest.fn();
    const tree = await renderScreen({onBack});

    await act(async () => {
      await tree.root.findByProps({testID: 'server-editor-cancel'}).props.onPress();
    });

    expect(onBack).toHaveBeenCalledTimes(1);
    expect(setServerUrlMock).not.toHaveBeenCalled();
  });

  test('says the address is unreadable instead of guessing one', async () => {
    getServerConfigMock.mockRejectedValue(new Error('NETBIRD_SERVER_READ'));
    const tree = await renderScreen();

    expect(tree.root.findByProps({testID: 'server-read-failed'})).toBeTruthy();
  });
});