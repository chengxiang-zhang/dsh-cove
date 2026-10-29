/**
 * Service list recovery: a stall must always leave the user a way forward.
 *
 * @format
 */

import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

jest.mock('../src/NetBirdPortal', () => ({
  NetBirdPortal: {
    status: jest.fn(),
    listServices: jest.fn(),
    probe: jest.fn(),
    hasPersistedConfig: jest.fn(),
    resumeConnection: jest.fn(),
    resetConnection: jest.fn(),
    diagnostics: jest.fn(),
    reportServiceCount: jest.fn(),
    clearServiceCount: jest.fn(),
  },
}));

import ServiceListScreen from '../src/screens/ServiceListScreen';
import {NetBirdPortal} from '../src/NetBirdPortal';

const statusMock = NetBirdPortal.status as jest.MockedFunction<typeof NetBirdPortal.status>;
const listServicesMock = NetBirdPortal.listServices as jest.MockedFunction<
  typeof NetBirdPortal.listServices
>;
const probeMock = NetBirdPortal.probe as jest.MockedFunction<typeof NetBirdPortal.probe>;
const hasPersistedConfigMock = NetBirdPortal.hasPersistedConfig as jest.MockedFunction<
  typeof NetBirdPortal.hasPersistedConfig
>;
const resetConnectionMock = NetBirdPortal.resetConnection as jest.MockedFunction<
  typeof NetBirdPortal.resetConnection
>;
const diagnosticsMock = NetBirdPortal.diagnostics as jest.MockedFunction<
  typeof NetBirdPortal.diagnostics
>;
const resumeConnectionMock = NetBirdPortal.resumeConnection as jest.MockedFunction<
  typeof NetBirdPortal.resumeConnection
>;

async function renderScreen(
  props: Partial<React.ComponentProps<typeof ServiceListScreen>> = {},
): Promise<{tree: ReactTestRenderer.ReactTestRenderer; onLogout: jest.Mock}> {
  const onLogout = jest.fn(async () => {});
  let tree: ReactTestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    tree = ReactTestRenderer.create(
      <ServiceListScreen
        onAuthRequired={jest.fn()}
        onOpen={jest.fn()}
        onOpenSettings={jest.fn()}
        onLogout={onLogout}
        {...props}
      />,
    );
  });
  return {tree: tree as unknown as ReactTestRenderer.ReactTestRenderer, onLogout};
}

/**
 * Collects the rendered text without JSON.stringify: some React Native props
 * hold React elements whose fiber back-references are circular.
 */
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

async function press(
  tree: ReactTestRenderer.ReactTestRenderer,
  testID: string,
): Promise<void> {
  await act(async () => {
    await tree.root.findByProps({testID}).props.onPress();
  });
}

describe('service list recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hasPersistedConfigMock.mockResolvedValue(true);
    resumeConnectionMock.mockResolvedValue(undefined);
    resetConnectionMock.mockResolvedValue(undefined);
    diagnosticsMock.mockResolvedValue({
      serviceRunning: true,
      stage: 'management_disconnected',
      lastError: 'NetBird management connection timed out',
      failures: 1,
      hardResets: 0,
      authVerdict: 'unknown',
    });
    statusMock.mockRejectedValue(new Error('NetBird management connection is still recovering'));
  });

  test('never leaves a stalled install without a way out', async () => {
    const {tree} = await renderScreen();

    const rendered = screenText(tree);
    expect(rendered).toContain('内网暂时未连接，无需重新登录');
    expect(rendered).toContain('管理端没有连上');
    expect(tree.root.findByProps({testID: 'service-list-retry'})).toBeTruthy();
    expect(tree.root.findByProps({testID: 'service-list-relogin'})).toBeTruthy();

    act(() => tree.unmount());
  });

  test('escalates to a re-login offer after repeated failures', async () => {
    const {tree} = await renderScreen();

    await press(tree, 'service-list-retry');
    await press(tree, 'service-list-retry');

    const rendered = screenText(tree);
    expect(rendered).toContain('内网一直没连上');
    expect(rendered).toContain('重新登录');
    // Three failed attempts rebuild the engine instead of waiting another round.
    expect(resetConnectionMock).toHaveBeenCalled();

    act(() => tree.unmount());
  });

  test('keeps retrying in the background instead of stopping after one pass', async () => {
    jest.useFakeTimers();
    try {
      const {tree} = await renderScreen();

      expect(screenText(tree)).toContain('已自动重试 1 次');

      for (const step of [3000, 6000]) {
        await act(async () => {
          jest.advanceTimersByTime(step);
          await Promise.resolve();
        });
      }

      // Three failed passes: the chain is still alive and the wording escalates.
      expect(screenText(tree)).toContain('内网一直没连上');

      act(() => tree.unmount());
    } finally {
      jest.useRealTimers();
    }
  });

  test('names a dead login as soon as the native verdict says so', async () => {
    diagnosticsMock.mockResolvedValue({
      serviceRunning: true,
      stage: 'management_disconnected',
      lastError: 'NetBird management connection timed out',
      failures: 1,
      hardResets: 0,
      authVerdict: 'login_required',
    });

    const {tree} = await renderScreen();

    expect(screenText(tree)).toContain('登录已失效，请重新登录');

    act(() => tree.unmount());
  });

  test('re-login from the stalled screen reaches the logout path', async () => {
    const {tree, onLogout} = await renderScreen();

    await press(tree, 'service-list-relogin');

    expect(onLogout).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  test('returns to login when the persisted identity is really gone', async () => {
    hasPersistedConfigMock.mockResolvedValue(false);
    const onAuthRequired = jest.fn();

    const {tree} = await renderScreen({onAuthRequired});

    expect(onAuthRequired).toHaveBeenCalledTimes(1);

    act(() => tree.unmount());
  });

  test('still lists the registered DSH service once the tunnel answers', async () => {
    statusMock.mockResolvedValue({
      managementConnected: true,
      ip: '100.64.0.11',
      fqdn: 'studio-mac.vpn',
    });
    listServicesMock.mockResolvedValue([
      {
        name: 'dsh.studio-mac.netbird',
        type: 1,
        class: 'IN',
        content: '100.64.0.11',
        zone: 'netbird.',
      },
    ]);
    probeMock.mockImplementation(async url => ({url, statusCode: 200, reachable: true}));

    const {tree} = await renderScreen();

    const rendered = screenText(tree);
    expect(rendered).toContain('dsh.studio-mac.netbird');
    expect(rendered).toContain('已连接 · 1 台机器可用');
    expect(tree.root.findByProps({testID: 'service-list-settings'})).toBeTruthy();

    act(() => tree.unmount());
  });

});