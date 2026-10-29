import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {AppState, Linking, Text} from 'react-native';

const webViewProps: Array<Record<string, unknown>> = [];

jest.mock('react-native-webview', () => ({
  WebView: (props: Record<string, unknown>) => {
    webViewProps.push(props);
    return require('react').createElement(require('react-native').View, props);
  },
}));

jest.mock('../src/NetBirdPortal', () => ({
  NetBirdPortal: {
    clearWebViewProxy: jest.fn(() => Promise.resolve()),
    loginSSO: jest.fn(),
    ssoStatus: jest.fn(),
    getServerConfig: jest.fn(),
    setServerUrl: jest.fn(),
    resetServerUrl: jest.fn(),
  },
}));

import {NetBirdPortal} from '../src/NetBirdPortal';
import LoginScreen, {
  CONNECT_TIMEOUT_MS,
  beginNetBirdLogin,
  isSafeAuthUrl,
  RESUME_NUDGE_SCRIPT,
  shouldHandOffToApp,
} from '../src/screens/LoginScreen';

const loginSSOMock = NetBirdPortal.loginSSO as jest.MockedFunction<
  typeof NetBirdPortal.loginSSO
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

let openURLSpy: jest.SpyInstance;

/** Every string a Text node renders, for assertions on what the reader sees. */
function screenText(renderer: ReactTestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .filter(child => typeof child === 'string')
    .join(' | ');
}

/**
 * Renderers this file created, torn down after each test.
 *
 * A mounted login screen keeps its 1.2 s status poll alive until the five-minute
 * status deadline, so a test that never unmounted left the suite running for
 * minutes after its ~0.3 s of assertions.
 */
const mounted: ReactTestRenderer.ReactTestRenderer[] = [];

function createTracked(element: React.ReactElement): ReactTestRenderer.ReactTestRenderer {
  const tree = ReactTestRenderer.create(element);
  mounted.push(tree);
  return tree;
}

afterEach(() => {
  for (const tree of mounted.splice(0)) {
    act(() => {
      tree.unmount();
    });
  }
});

describe('NetBird login screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    webViewProps.length = 0;
    (NetBirdPortal.clearWebViewProxy as jest.Mock).mockResolvedValue(undefined);
    (NetBirdPortal.ssoStatus as jest.Mock).mockResolvedValue({state: 'waiting'});
    getServerConfigMock.mockResolvedValue(DEFAULT_SERVER);
    setServerUrlMock.mockResolvedValue({url: CUSTOM_SERVER.url, changed: true});
    openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined as never);
  });

  test('accepts only complete HTTP(S) authentication URLs', () => {
    expect(isSafeAuthUrl('https://netbird.example/oauth2/auth')).toBe(true);
    expect(isSafeAuthUrl('http://localhost:53000/')).toBe(true);
    expect(isSafeAuthUrl('undefined')).toBe(false);
    expect(isSafeAuthUrl('')).toBe(false);
    expect(isSafeAuthUrl('data:text/plain,blocked')).toBe(false);
  });

  test('waits for stale proxy removal before starting OAuth', async () => {
    let finishClear: (() => void) | undefined;
    (NetBirdPortal.clearWebViewProxy as jest.Mock).mockImplementation(
      () => new Promise<void>(resolve => (finishClear = resolve)),
    );
    loginSSOMock.mockResolvedValue('https://netbird.example/oauth2/auth');

    const login = beginNetBirdLogin();
    await Promise.resolve();
    expect(loginSSOMock).not.toHaveBeenCalled();

    finishClear!();
    await expect(login).resolves.toBe('https://netbird.example/oauth2/auth');
    expect(loginSSOMock).toHaveBeenCalledTimes(1);
  });

  test('does not open the WebView for an invalid authentication URL', async () => {
    loginSSOMock.mockResolvedValue('undefined');
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = createTracked(<LoginScreen onLogin={jest.fn()} onOpenServer={jest.fn()} />);
    });

    const loginButton = renderer!.root.findByProps({testID: 'login-submit'});
    await act(async () => {
      loginButton.props.onPress();
      await Promise.resolve();
    });

    expect(NetBirdPortal.clearWebViewProxy).toHaveBeenCalledTimes(1);
    expect(webViewProps).toHaveLength(0);
    expect(
      renderer!.root
        .findAllByType(Text)
        .some(node => node.props.children === '服务端没有返回有效的登录地址，请重试'),
    ).toBe(true);
  });

  test('replaces the native WebView error page with a retryable error', async () => {
    loginSSOMock.mockResolvedValue('https://netbird.example/oauth2/auth');
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = createTracked(<LoginScreen onLogin={jest.fn()} onOpenServer={jest.fn()} />);
    });

    await act(async () => {
      renderer!.root.findByProps({testID: 'login-submit'}).props.onPress();
      await Promise.resolve();
    });
    expect(webViewProps).toHaveLength(1);

    await act(async () => {
      (webViewProps[0].onError as (event: unknown) => void)({
        nativeEvent: {description: 'net::ERR_NAME_NOT_RESOLVED'},
      });
    });

    expect(renderer!.root.findByProps({testID: 'login-submit'})).toBeTruthy();
    expect(
      renderer!.root
        .findAllByType(Text)
        .some(
          node =>
            node.props.children ===
            '登录页加载失败：net::ERR_NAME_NOT_RESOLVED',
        ),
    ).toBe(true);
  });

  test('connects once even when two status polls both report done', async () => {
    jest.useFakeTimers();
    try {
      loginSSOMock.mockResolvedValue('https://netbird.example/oauth2/auth');
      const pendingStatus: Array<(status: {state: string}) => void> = [];
      (NetBirdPortal.ssoStatus as jest.Mock).mockImplementation(
        () => new Promise(resolve => pendingStatus.push(resolve)),
      );
      let releaseLogin: (() => void) | undefined;
      const onLogin = jest.fn(
        () =>
          new Promise<void>(resolve => {
            releaseLogin = resolve;
          }),
      );

      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = createTracked(<LoginScreen onLogin={onLogin} onOpenServer={jest.fn()} />);
      });
      await act(async () => {
        renderer!.root.findByProps({testID: 'login-submit'}).props.onPress();
        await Promise.resolve();
      });

      // Two overlapping polls: the status RPC can outlast the 1.2 s tick.
      await act(async () => {
        jest.advanceTimersByTime(1200);
      });
      await act(async () => {
        jest.advanceTimersByTime(1200);
      });
      expect(pendingStatus).toHaveLength(2);

      await act(async () => {
        pendingStatus.forEach(resolve => resolve({state: 'done'}));
        await Promise.resolve();
        await Promise.resolve();
      });

      // A second `ensureConnected()` would race the first one natively.
      expect(onLogin).toHaveBeenCalledTimes(1);

      releaseLogin?.();
      await act(async () => {
        await Promise.resolve();
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('leaves the connecting phase with an error when the bridge never settles', async () => {
    jest.useFakeTimers();
    try {
      // Already authenticated: the flow goes straight to the connecting phase.
      loginSSOMock.mockResolvedValue('');
      // A native bridge call can stay pending forever (a proxy-override
      // completion that never fires, a bridge thread lost to java.lang.Error).
      // A try/catch cannot see that, so before CONNECT_TIMEOUT_MS existed this
      // screen sat on "正在连接网络…" with the button disabled and no exit.
      const onLogin = jest.fn(() => new Promise<void>(() => {}));

      let renderer: ReactTestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = createTracked(<LoginScreen onLogin={onLogin} onOpenServer={jest.fn()} />);
      });
      await act(async () => {
        renderer!.root.findByProps({testID: 'login-submit'}).props.onPress();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onLogin).toHaveBeenCalledTimes(1);
      const connectingText = () =>
        renderer!.root
          .findAllByType(Text)
          .map(node => node.props.children)
          .filter(child => typeof child === 'string')
          .join('|');
      expect(connectingText()).toContain('正在连接网络…');

      await act(async () => {
        jest.advanceTimersByTime(CONNECT_TIMEOUT_MS);
        await Promise.resolve();
      });

      expect(connectingText()).toContain('连接超时');
      // The exit is real: the button is enabled again and offers the retry.
      const button = renderer!.root.findByProps({testID: 'login-submit'});
      expect(button.props.disabled).not.toBe(true);
      expect(
        renderer!.root
          .findAllByType(Text)
          .some(node => node.props.children === '登录'),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
  // The identity provider hands off to its own app with a custom scheme. Treating
  // those as web navigations is what left users on a page that said the app could
  // not be launched, so the split is pinned here.
  test('separates app-hand-off schemes from ordinary web navigation', () => {
    expect(shouldHandOffToApp('feishu://open/abc')).toBe(true);
    expect(shouldHandOffToApp('lark://open/abc')).toBe(true);
    expect(shouldHandOffToApp('someapp://x')).toBe(true);
    expect(shouldHandOffToApp('https://accounts.feishu.cn/accounts/page/login')).toBe(false);
    expect(shouldHandOffToApp('http://sso.example.com/callback')).toBe(false);
    expect(shouldHandOffToApp('about:blank')).toBe(false);
    expect(shouldHandOffToApp('data:text/html,x')).toBe(false);
  });

  test('opens a custom scheme itself instead of letting the WebView ask permission', async () => {
    loginSSOMock.mockResolvedValue('https://sso.example/oauth2/auth');
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = createTracked(<LoginScreen onLogin={jest.fn()} onOpenServer={jest.fn()} />);
    });
    await act(async () => {
      renderer!.root.findByProps({testID: 'login-submit'}).props.onPress();
      await Promise.resolve();
    });
    expect(webViewProps).toHaveLength(1);

    // The library only calls our handler for URLs that pass originWhitelist, so
    // a scheme list here silently disables the whole hand-off. Pin it.
    expect(webViewProps[0].originWhitelist).toEqual(['*']);

    const shouldStart = webViewProps[0].onShouldStartLoadWithRequest as (r: {
      url: string;
    }) => boolean;
    expect(shouldStart({url: 'https://accounts.feishu.cn/accounts/page/login'})).toBe(true);
    expect(shouldStart({url: 'http://sso.example.com/callback?code=x'})).toBe(true);

    let allowed = false;
    await act(async () => {
      allowed = shouldStart({url: 'feishu://open/abc'});
      await Promise.resolve();
    });
    expect(allowed).toBe(false);
    expect(openURLSpy).toHaveBeenCalledWith('feishu://open/abc');

    // The scheme the provider actually used on a device, from the log line that
    // exposed this bug in the first place.
    await act(async () => {
      expect(
        shouldStart({url: 'lark://client/verify?qr_code=580l7fc3&_stamp=179'}),
      ).toBe(false);
      await Promise.resolve();
    });
    expect(openURLSpy).toHaveBeenCalledWith('lark://client/verify?qr_code=580l7fc3&_stamp=179');
  });

  /**
   * Coming back from the provider's app used to leave the sign-in page exactly as
   * it was: the WebView had no resume handling at all, while the workspace screen
   * has had it all along. The script is pinned here because it cannot be asserted
   * through a mocked WebView.
   */
  test('nudges the sign-in page awake when the reader returns from the provider app', () => {
    for (const event of ['visibilitychange', 'focus', 'online', 'pageshow']) {
      expect(RESUME_NUDGE_SCRIPT).toContain(event);
    }
    // react-native-webview requires the injected source to evaluate to a value.
    expect(RESUME_NUDGE_SCRIPT.trimEnd().endsWith('true;')).toBe(true);
    expect(RESUME_NUDGE_SCRIPT).toContain('try');
  });

  test('registers the resume listener only while the provider page is up', async () => {
    const addListener = jest.spyOn(AppState, 'addEventListener');
    loginSSOMock.mockResolvedValue('https://sso.example/oauth2/auth');
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = createTracked(<LoginScreen onLogin={jest.fn()} onOpenServer={jest.fn()} />);
    });
    const before = addListener.mock.calls.filter(call => call[0] === 'change').length;
    await act(async () => {
      renderer!.root.findByProps({testID: 'login-submit'}).props.onPress();
      await Promise.resolve();
    });
    const after = addListener.mock.calls.filter(call => call[0] === 'change').length;
    expect(after).toBeGreaterThan(before);
    addListener.mockRestore();
  });

  /**
   * A first-run reader whose fleet runs its own control plane has to be able to
   * say so here: the login screen is the only surface they see before the app
   * tries to enroll against an address that is not theirs. The editing itself
   * lives on the address screen (see ServerScreen), which is why the row
   * navigates instead of expanding in place.
   */
  test('names the server the next sign-in will enroll against', async () => {
    const onOpenServer = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = createTracked(<LoginScreen onLogin={jest.fn()} onOpenServer={onOpenServer} />);
    });

    // https already implies 443, so the row names the host and stops there.
    expect(screenText(renderer!)).toContain('服务器：netbird.example.com');
    expect(screenText(renderer!)).not.toContain(':443');

    await act(async () => {
      renderer!.root.findByProps({testID: 'login-server'}).props.onPress();
    });
    expect(onOpenServer).toHaveBeenCalledTimes(1);
  });

  test('marks a self-hosted address as the reader own choice', async () => {
    getServerConfigMock.mockResolvedValue(CUSTOM_SERVER);
    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = createTracked(<LoginScreen onLogin={jest.fn()} onOpenServer={jest.fn()} />);
    });

    // A non-default port is shown: there it is the only thing telling two
    // servers apart, and （自建） says the address is the reader's choice.
    expect(screenText(renderer!)).toContain('服务器：nb.corp.example:8443（自建）');
  });
});
