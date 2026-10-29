import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AppState,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {WebView} from 'react-native-webview';
import type {ShouldStartLoadRequest, WebViewErrorEvent} from 'react-native-webview/lib/WebViewTypes';
import {NetBirdPortal, ServerConfig, SSOStatus} from '../NetBirdPortal';
import {readServerConfig, serverHostLabel, withTimeout} from '../netbird';
import {Banner, Button, MIN_TOUCH_TARGET} from '../theme/components';
import {useTheme} from '../theme/tokens';

type Props = {
  onLogin: () => Promise<void>;
  /** Opens the management-address screen (see ServerScreen). */
  onOpenServer: () => void;
};

const STATUS_POLL_MS = 1200;
const STATUS_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Last-resort ceiling for the connecting phase.
 *
 * The ordinary path is bounded natively: 45s for the service to report a
 * connected management stream plus up to 90s inside the tunnel fetch. This
 * exists only for the case a bridge call never settles at all (a proxy-override
 * completion that never fires, a bridge thread lost to `java.lang.Error`), which
 * a try/catch cannot see. Without it the button stays disabled and the screen
 * never reaches an error or an exit — the dead end this app must never have.
 */
export const CONNECT_TIMEOUT_MS = 150_000;

export function isSafeAuthUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname;
  } catch {
    return false;
  }
}

function loginPageError(event: WebViewErrorEvent): string {
  const description = event.nativeEvent.description?.trim();
  return description
    ? `登录页加载失败：${description}`
    : '登录页加载失败，请检查网络后重试';
}

/**
 * The sign-in page hands off to the identity provider's own app - Feishu, in our
 * case - by navigating to a custom scheme. Observed on a device:
 *
 *   W ReactNativeJS: Can't open url: lark://client/verify?qr_code=...
 *
 * That warning comes from react-native-webview's own handling, and it explains
 * why the provider's page gave up with "Failed to launch": the library asks
 * `Linking.canOpenURL` before `openURL`, and on Android 11+ that query is
 * filtered by package visibility, so it answers false even on a phone that has
 * Feishu installed.
 *
 * `openURL` is not restricted that way - starting an activity is not filtered,
 * only querying for one is - so the hand-off is done here instead: a real failure
 * becomes a message the reader can act on rather than a silent dead end.
 *
 * This handler only runs because `originWhitelist` is `['*']`; the library skips
 * it entirely for URLs outside the whitelist, which is how the first attempt at
 * this fix ended up never being called. The predicate below is therefore the
 * security boundary: only web schemes are allowed to load in the WebView.
 */
/**
 * Drains the sign-in page's waiting state after a trip to the provider's app.
 * The page polls for a result that may already have arrived while we were
 * backgrounded and its timers were paused.
 */
export const RESUME_NUDGE_SCRIPT =
  "(function(){try{" +
  "document.dispatchEvent(new Event('visibilitychange'));" +
  "window.dispatchEvent(new Event('focus'));" +
  "window.dispatchEvent(new Event('online'));" +
  "window.dispatchEvent(new Event('pageshow'));" +
  "}catch(e){}})(); true;";

export function shouldHandOffToApp(url: string): boolean {
  return !/^(https?|about|data|blob):/i.test(url)
}

export async function beginNetBirdLogin(): Promise<string> {
  // OAuth is a public Internet flow. A proxy left behind by a stopped
  // runtime makes the system WebView fail before the login page.
  await NetBirdPortal.clearWebViewProxy();
  return NetBirdPortal.loginSSO();
}

export default function LoginScreen({onLogin, onOpenServer}: Props) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'auth' | 'connecting' | 'error'>(
    'idle',
  );
  const [authUrl, setAuthUrl] = useState('');
  const [error, setError] = useState('');
  const webviewRef = useRef<WebView | null>(null);
  // Typed by the instance: `useRef<ScrollView>` resolves to the component type,
  // which has no `scrollToEnd`.
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  // The status poller can tick again while `onLogin()` is still connecting, and
  // a second `ensureConnected()` would race the first one in the native service.
  const finishing = useRef(false);
  // The control plane this install will enroll against. First-run users whose
  // fleet is not the one the app ships with have to be able to say so before
  // signing in, so the entry lives here as well as in settings.
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [serverReadFailed, setServerReadFailed] = useState(false);
  const [keyboardUp, setKeyboardUp] = useState(false);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const finishAuth = useCallback(async () => {
    if (finishing.current) {
      return;
    }
    finishing.current = true;
    stopPolling();
    setPhase('connecting');
    try {
      await withTimeout(
        onLogin(),
        CONNECT_TIMEOUT_MS,
        '连接超时：内网没有在预期时间内就绪。请重试，或检查本机网络。',
      );
    } catch (e) {
      finishing.current = false;
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [onLogin, stopPolling]);

  const pollStatus = useCallback(() => {
    const startedAt = Date.now();
    stopPolling();
    pollTimer.current = setInterval(async () => {
      let status: SSOStatus;
      try {
        status = await NetBirdPortal.ssoStatus();
      } catch {
        if (Date.now() - startedAt > STATUS_TIMEOUT_MS) {
          stopPolling();
          setError('登录超时，请重试');
          setPhase('error');
        }
        return;
      }
      if (status.state === 'done') {
        finishAuth();
      } else if (status.state === 'error') {
        stopPolling();
        setError(status.error || '登录失败，请重试');
        setPhase('error');
      } else if (Date.now() - startedAt > STATUS_TIMEOUT_MS) {
        stopPolling();
        setError('登录超时，请重试');
        setPhase('error');
      }
    }, STATUS_POLL_MS);
  }, [finishAuth, stopPolling]);

  const start = useCallback(async () => {
    setPhase('starting');
    setError('');
    finishing.current = false;
    try {
      const url = await beginNetBirdLogin();
      if (!url) {
        // Already authenticated with a persisted session — connect directly.
        finishAuth();
        return;
      }
      if (!isSafeAuthUrl(url)) {
        throw new Error('服务端没有返回有效的登录地址，请重试');
      }
      setAuthUrl(url);
      setPhase('auth');
      pollStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [finishAuth, pollStatus]);

  useEffect(() => stopPolling, [stopPolling]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const config = await readServerConfig();
      if (alive) {
        setServer(config);
        setServerReadFailed(config === null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * The server editor is the last block on this screen, so "the end of the
   * content" is exactly "the whole editor". Measured on a device: the
   * ScrollView on its own only lifted the focused field above the keyboard and
   * left the 保存/取消 row at y=1457-1583 while the window ended at 1517, so
   * half of each button sat under the keyboard.
   *
   * Scrolling to the end when the keyboard shows is not enough on its own:
   * `keyboardDidShow` arrives before the KeyboardAvoidingView has shrunk the
   * viewport, so at that moment the content may still fit and the scroll is a
   * no-op (measured: the offset stayed at 0 and the buttons stayed cut). The
   * reveal is therefore repeated on every layout and content-size change while
   * the keyboard is up, so whichever of the two settles last is the one that
   * positions the editor.
   */
  const revealEditor = useCallback(() => {
    if (keyboardUp) {
      scrollRef.current?.scrollToEnd({animated: true});
    }
  }, [keyboardUp]);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setKeyboardUp(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardUp(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const {c, space: sp, type: t} = useTheme();
  const busy = phase === 'starting' || phase === 'connecting';
  // The connecting label is the one the acceptance test reads, so it stays
  // exactly as written here.
  const label =
    phase === 'starting' ? '正在打开登录页…' : phase === 'connecting' ? '正在连接网络…' : '登录';
  const serverValue = server
    ? `服务器：${serverHostLabel(server.url)}${server.isCustom ? '（自建）' : ''}`
    : serverReadFailed
    ? '服务器：读取失败，可重新设置'
    : '服务器：读取中…';

  /**
   * The provider's page hands the authorization to its own app and then waits for
   * that app to confirm the session, which means our Activity goes to the
   * background and its WebView timers are paused. Coming back, the page can sit
   * waiting for a result that already arrived - the workspace screen already
   * nudges its page on resume, and the sign-in WebView had nothing at all.
   *
   * This is a best effort on the return leg: it cannot make a provider app that
   * never confirms the session confirm it, and it was not verifiable without a
   * real provider identity, so it is written to be harmless if the page ignores it.
   */
  useEffect(() => {
    if (phase !== 'auth') {
      return;
    }
    let backgroundedAt = 0;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        backgroundedAt = Date.now();
        return;
      }
      const away = backgroundedAt > 0 ? Date.now() - backgroundedAt : 0;
      backgroundedAt = 0;
      if (away < 1000) {
        return;
      }
      webviewRef.current?.injectJavaScript(RESUME_NUDGE_SCRIPT);
    });
    return () => subscription.remove();
  }, [phase]);

  const handleHandOff = useCallback(
    (request: ShouldStartLoadRequest): boolean => {
      const url = request.url;
      if (!shouldHandOffToApp(url)) {
        return true;
      }
      Linking.openURL(url).catch(() => {
        // Only reachable when nothing on the device claims the scheme. Say what
        // happened, name the alternatives, and leave the WebView usable so the
        // page's own "more sign-in methods" links still work.
        setError(
          '这台手机上没有能响应飞书 App 跳转的应用（或系统拦住了跳转）。' +
            '请在飞书页面里改用「更多登录方式」或「扫码登录」，' +
            '也可以返回后用账号密码登录。',
        );
      });
      return false;
    },
    [],
  );

  if (phase === 'auth' && authUrl) {
    return (
      <View style={[styles.webviewWrap, {backgroundColor: c.bg}]}>
        {/* A failed app hand-off happens while this page is up, so the message
            has to live here - and it needs a way out that does not depend on the
            provider's page offering one. */}
        {!!error && (
          <Banner
            tone="danger"
            message={error}
            detail="飞书页面里的「更多登录方式」和「扫码登录」都能完成同一次授权。"
            actionLabel="返回重新选择"
            onAction={() => {
              stopPolling();
              setAuthUrl('');
              setError('');
              setPhase('idle');
            }}
            style={[styles.banner, {margin: sp.lg}]}
          />
        )}
        {/*
          '*' rather than a scheme list: react-native-webview only calls
          onShouldStartLoadWithRequest for URLs that pass this whitelist, and for
          anything else it does its own visibility-gated canOpenURL. The identity
          provider's app hand-off uses a custom scheme (`lark://`), so a scheme
          list here meant our handler never ran at all and the hand-off silently
          failed. Everything now reaches the handler, which is the only thing
          allowed to decide what loads.
        */}
        <WebView
          ref={node => {
            webviewRef.current = node as WebView | null;
          }}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['*']}
          onShouldStartLoadWithRequest={request => handleHandOff(request)}
          source={{uri: authUrl}}
          onError={event => {
            stopPolling();
            setAuthUrl('');
            setError(loginPageError(event));
            setPhase('error');
          }}
          onLoadStart={() => setError('')}
          style={styles.webview}
        />
      </View>
    );
  }

  return (
    // The sign-in action, the server row and the editor that expands under it are
    // all anchored at the bottom of this screen, and the soft keyboard covers the
    // bottom of it. Measured on a device: tapping the address field left the
    // layout exactly where it was with the keyboard over it, so "保存" sat under
    // the keyboard and could not be pressed, and the address being typed was
    // hidden by the thing it was being typed with.
    //
    // The ScrollView lifts the editor above the keyboard, and
    // `keyboardShouldPersistTaps` keeps the first tap on a button a press -
    // without it that tap only dismisses the keyboard, and the button then has to
    // be pressed a second time.
    <KeyboardAvoidingView
      style={[styles.screen, {backgroundColor: c.bg}]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView
        ref={scrollRef}
        onLayout={revealEditor}
        onContentSizeChange={revealEditor}
        style={styles.scroll}
        contentContainerStyle={[
          styles.container,
          {
            paddingHorizontal: sp['2xl'],
            paddingTop: sp['4xl'],
            paddingBottom: sp['2xl'],
          },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        {/* Brand anchored at the top, action anchored in thumb reach: the old
            layout centred both and left the lower third of the screen empty. */}
        <View style={styles.brand}>
          <Image
            source={require('../../assets/brand/icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={[t.display, {color: c.text}]} numberOfLines={1} adjustsFontSizeToFit>
            Anywhere Work
          </Text>
          <Text style={[t.body, styles.centred, {color: c.textMuted}]}>
            登录后接入你自己的机器工作区
          </Text>
        </View>

        {/* A tall phone leaves a lot of room between the brand and the action.
            Filling it with what the product actually does is worth more than
            stretching the two ends apart. */}
        <View style={[styles.capabilities, {gap: sp.lg}]}>
          {[
            '只看得到你自己的机器，别人看不到、也连不上',
            '手机和电脑共用同一份工作现场',
            '默认飞书登录，也可以切到账号 + 密码',
          ].map(text => (
            <View key={text} style={[styles.capability, {gap: sp.md}]}>
              <View style={[styles.bullet, {backgroundColor: c.brand}]} />
              <Text style={[t.body, {color: c.textMuted, flex: 1}]}>{text}</Text>
            </View>
          ))}
        </View>

        <View style={styles.action}>
          {!!error && (
            <Banner
              tone="danger"
              message={error}
              detail="再次点击登录可以重新发起授权。"
              style={styles.banner}
            />
          )}

          <Button
            testID="login-submit"
            label={label}
            busyLabel="正在连接网络…"
            busy={busy}
            onPress={start}
            accessibilityHint="会打开浏览器或登录页，用公司账号完成授权"
          />

          <Pressable
            testID="login-server"
            accessibilityRole="button"
            accessibilityLabel="登录服务器"
            onPress={onOpenServer}
            accessibilityHint="打开管理端地址页，可以填自建 NetBird 的地址并先测试能不能连上"
            style={styles.serverRow}>
            <Text
              numberOfLines={1}
              style={[t.caption, {color: serverReadFailed ? c.danger : c.textMuted}]}>
              {serverValue}
            </Text>
            <Text style={[t.caption, {color: c.brand}]}>修改</Text>
          </Pressable>

          <Text style={[t.caption, styles.centred, {color: c.textFaint}]}>
            登录成功后自动建立只属于你的分组，不需要审批
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1},
  scroll: {flex: 1},
  // flexGrow rather than flex: this is a scroll content container, and it has to
  // hold the ends apart exactly as the plain View did while nothing is scrolled.
  container: {flexGrow: 1, justifyContent: 'space-between'},
  brand: {gap: 6, alignItems: 'center'},
  logo: {width: 76, height: 76, marginBottom: 12},
  centred: {textAlign: 'center'},
  action: {gap: 12},
  // The server row is a way out of a wrong default, not a second call to action:
  // it stays a quiet one-liner with a 48dp target.
  serverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: 4,
  },
  banner: {width: '100%'},
  capabilities: {paddingHorizontal: 4},
  capability: {flexDirection: 'row', alignItems: 'flex-start'},
  bullet: {width: 6, height: 6, borderRadius: 3, marginTop: 8},
  webviewWrap: {flex: 1},
  webview: {flex: 1},
});