/**
 * Settings owns the low-frequency actions: connection summary, update check,
 * version and sign-out. These used to sit in the service-list footer, which
 * competed with opening a machine.
 *
 * @format
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

jest.mock('../src/NetBirdPortal', () => ({
  NetBirdPortal: {
    getAppVersion: jest.fn(),
    getRunNotificationsEnabled: jest.fn(),
    setRunNotificationsEnabled: jest.fn(),
    getServerConfig: jest.fn(),
    setServerUrl: jest.fn(),
    resetServerUrl: jest.fn(),
  },
}));

import {Platform} from 'react-native';

import SettingsScreen from '../src/screens/SettingsScreen';
import {NetBirdPortal} from '../src/NetBirdPortal';

// This suite is the Android settings screen: the finished-run switch it toggles is
// driven by the Android foreground service's poller. iOS hides that row (see the
// iOS case at the end), so the platform is stated rather than inherited from the
// jest preset's default.
Platform.OS = 'android';

const getAppVersionMock = NetBirdPortal.getAppVersion as jest.MockedFunction<
  typeof NetBirdPortal.getAppVersion
>;
const getRunNotificationsEnabledMock =
  NetBirdPortal.getRunNotificationsEnabled as jest.MockedFunction<
    typeof NetBirdPortal.getRunNotificationsEnabled
  >;
const setRunNotificationsEnabledMock =
  NetBirdPortal.setRunNotificationsEnabled as jest.MockedFunction<
    typeof NetBirdPortal.setRunNotificationsEnabled
  >;
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

function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach(child => collectText(child, out));
    return out;
  }
  if (node && typeof node === 'object') {
    const children = (node as {children?: unknown}).children;
    if (children !== undefined) {
      collectText(children, out);
    }
  }
  return out;
}

function screenText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return collectText(tree.toJSON()).join(' | ');
}

async function renderScreen(
  props: Partial<React.ComponentProps<typeof SettingsScreen>> = {},
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <SettingsScreen
        machineCount={2}
        onBack={jest.fn()}
        onLogout={jest.fn()}
        onOpenServer={jest.fn()}
        {...props}
      />,
    );
  });
  return tree as unknown as ReactTestRenderer.ReactTestRenderer;
}

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await act(async () => {
    await tree.root.findByProps({testID}).props.onPress();
  });
}


function switchState(
  tree: ReactTestRenderer.ReactTestRenderer,
): {checked?: boolean; role?: string} {
  const node = tree.root.findByProps({testID: 'settings-run-notifications'});
  return {
    checked: node.props.accessibilityState?.checked,
    role: node.props.accessibilityRole,
  };
}

describe('settings screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getAppVersionMock.mockResolvedValue({versionCode: 19, versionName: '2.5.3'});
    getRunNotificationsEnabledMock.mockResolvedValue(true);
    setRunNotificationsEnabledMock.mockResolvedValue(undefined);
    getServerConfigMock.mockResolvedValue(DEFAULT_SERVER);
    setServerUrlMock.mockResolvedValue({url: CUSTOM_SERVER.url, changed: true});
  });

  test('summarises the reachable machines', async () => {
    const tree = await renderScreen({machineCount: 3});
    expect(screenText(tree)).toContain('已连接 · 3 台机器可用');
    act(() => tree.unmount());
  });

  test('reports the installed version', async () => {
    const tree = await renderScreen();
    expect(screenText(tree)).toContain('v2.5.3');
    act(() => tree.unmount());
  });

  test('says so when the manual update check cannot reach the channel', async () => {
    const onCheckUpdate = jest.fn(async () => {
      throw new Error('NETBIRD_FETCH');
    });
    const tree = await renderScreen({onCheckUpdate});

    await press(tree, 'settings-check-update');

    // The check runs over the tunnel: silence used to look like a dead button.
    expect(screenText(tree)).toContain('检查失败，点此重试');
    act(() => tree.unmount());
  });

  test('reports when the install is already current', async () => {
    const tree = await renderScreen({onCheckUpdate: jest.fn(async () => false)});

    await press(tree, 'settings-check-update');

    expect(screenText(tree)).toContain('已是最新');
    act(() => tree.unmount());
  });

  test('signs out through the shared logout path', async () => {
    const onLogout = jest.fn(async () => {});
    const tree = await renderScreen({onLogout});

    await press(tree, 'settings-logout');

    expect(onLogout).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  test('shows the stored finished-run switch, not a guess', async () => {
    getRunNotificationsEnabledMock.mockResolvedValue(false);

    const tree = await renderScreen();

    expect(getRunNotificationsEnabledMock).toHaveBeenCalledTimes(1);
    expect(switchState(tree).role).toBe('switch');
    expect(switchState(tree).checked).toBe(false);
    act(() => tree.unmount());
  });

  test('defaults the finished-run switch to on when nothing is stored', async () => {
    const tree = await renderScreen();

    expect(switchState(tree).checked).toBe(true);
    expect(screenText(tree)).toContain('任务完成提醒');
    act(() => tree.unmount());
  });

  test('persists turning the finished-run switch off', async () => {
    const tree = await renderScreen();

    await press(tree, 'settings-run-notifications');

    expect(setRunNotificationsEnabledMock).toHaveBeenCalledWith(false);
    expect(switchState(tree).checked).toBe(false);
    act(() => tree.unmount());
  });

  test('persists turning the finished-run switch back on', async () => {
    getRunNotificationsEnabledMock.mockResolvedValue(false);
    const tree = await renderScreen();

    await press(tree, 'settings-run-notifications');

    expect(setRunNotificationsEnabledMock).toHaveBeenCalledWith(true);
    expect(switchState(tree).checked).toBe(true);
    act(() => tree.unmount());
  });

  test('reverts the switch when the setting cannot be stored', async () => {
    setRunNotificationsEnabledMock.mockRejectedValue(new Error('NETBIRD_RUN_NOTIFY_WRITE'));
    const tree = await renderScreen();

    await press(tree, 'settings-run-notifications');

    // A switch that shows "off" while the service keeps polling would be a lie.
    expect(switchState(tree).checked).toBe(true);
    expect(screenText(tree)).toContain('设置没保存，请重试');
    act(() => tree.unmount());
  });

  test('names the server this install enrolls against', async () => {
    getServerConfigMock.mockResolvedValue(CUSTOM_SERVER);
    const tree = await renderScreen();

    // A row that printed a compiled default would keep naming the server this
    // install stopped using.
    expect(screenText(tree)).toContain('nb.corp.example:8443（自建）');
    act(() => tree.unmount());
  });

  test('says the server is unreadable instead of guessing one', async () => {
    getServerConfigMock.mockRejectedValue(new Error('NETBIRD_SERVER_READ'));
    const tree = await renderScreen();

    expect(screenText(tree)).toContain('读取失败，可重新设置');
    act(() => tree.unmount());
  });

  test('opens the management address screen instead of expanding in place', async () => {
    const onOpenServer = jest.fn();
    const tree = await renderScreen({onOpenServer});

    await press(tree, 'settings-server');

    // The editing surface is a screen of its own now: growing a text field, its
    // buttons and a reset row inside this list is what put them under the
    // keyboard, and it left the address unreachable before signing in.
    expect(onOpenServer).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByProps({testID: 'server-editor-input'})).toHaveLength(0);
    act(() => tree.unmount());
  });
});

test('iOS hides the finished-run switch: nothing polls there', async () => {
  const previous = Platform.OS;
  Platform.OS = 'ios';
  try {
    const tree = await renderScreen();
    expect(tree.root.findAllByProps({testID: 'settings-run-notifications'}).length).toBe(0);
    expect(screenText(tree)).not.toContain('任务完成提醒');
  } finally {
    Platform.OS = previous;
  }
});
