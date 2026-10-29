import React, {useRef, useState} from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {WebView} from 'react-native-webview';
import type {
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
} from 'react-native-webview/lib/WebViewTypes';
import {NetBirdPortal} from '../NetBirdPortal';
import {ServiceInfo, hasBundledBrowserContainer} from '../netbird';
import {POLYFILL_PATCH, TZ_PATCH} from '../webviewInjections';
import {MIN_TOUCH_TARGET} from '../theme/components';
import {useTheme} from '../theme/tokens';

type Props = {
  service: ServiceInfo;
  services: ServiceInfo[];
  onBack: () => void;
  onSwitch: (service: ServiceInfo) => void;
};

/**
 * The machine workspace: a toolbar wrapped around the embedded page.
 *
 * This screen is where a reader spends nearly all of their time, and it was the
 * one screen that never called `useTheme()` at all - every colour was a literal
 * light value (including the previous brand blue), so a dark phone got a bright
 * toolbar above a dark page. "Clear cache" also used to sit in the toolbar next
 * to "Switch", which put a rare destructive-ish action one mis-tap away from the
 * one people actually use; it now lives at the foot of the machine switcher.
 */
export default function ServiceWebViewScreen({service, services, onBack, onSwitch}: Props) {
  const {c, space: sp, radius: r, type: t} = useTheme();
  const webviewRef = useRef<WebView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [loadError, setLoadError] = useState('');
  // What the web view loads. On a platform whose view can be pointed at the forward proxy
  // this is the service's own address; where it cannot (iOS), the engine serves the page
  // from loopback and this becomes that origin.
  const [pageOrigin, setPageOrigin] = useState(service.url);

  const describeError = (event: WebViewErrorEvent) => {
    const description = event.nativeEvent.description?.trim();
    return description
      ? `页面加载失败：${description}`
      : '页面加载失败：内网可能未连接，或该机器暂时不可达';
  };

  const describeHttpError = (event: WebViewHttpErrorEvent) =>
    `该机器返回 HTTP ${event.nativeEvent.statusCode}，页面没有打开`;

  React.useEffect(() => {
    if (hasBundledBrowserContainer()) {
      setPageOrigin(service.url);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    NetBirdPortal.startPageProxy(service.url)
      .then(origin => {
        if (!cancelled) {
          setPageOrigin(origin);
        }
      })
      .catch(error => {
        if (!cancelled) {
          setLoaded(true);
          setLoadError(`页面加载失败：${String(error?.message ?? error)}`);
        }
      });
    return () => {
      cancelled = true;
      // The origin only lives as long as this screen: leaving it up would keep serving a
      // private page to a view that is no longer showing one.
      NetBirdPortal.stopPageProxy().catch(() => {});
    };
  }, [service.url]);

  React.useEffect(() => {
    let backgroundedAt = 0;
    const appStateSub = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        backgroundedAt = Date.now();
        return;
      }
      if (backgroundedAt > 0 && Date.now() - backgroundedAt >= 1500) {
        webviewRef.current?.injectJavaScript(
          "window.dispatchEvent(new Event('offline')); setTimeout(function () { window.dispatchEvent(new Event('online')); }, 50); true;",
        );
      }
      backgroundedAt = 0;
    });
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => {
      appStateSub.remove();
      sub.remove();
    };
  }, [onBack]);

  const others = services.filter(item => item.name !== service.name);

  const clearCacheReload = async () => {
    setSwitcherOpen(false);
    try {
      await NetBirdPortal.clearWebViewCache();
    } catch {
      // best effort; reload below is the real fix
    }
    setLoaded(false);
    if (webviewRef.current) {
      webviewRef.current.reload();
    }
  };

  return (
    <View style={[styles.container, {backgroundColor: c.bg}]}>
      <View
        style={[
          styles.toolbar,
          {
            backgroundColor: c.surface,
            borderBottomColor: c.border,
            paddingHorizontal: sp.md,
            paddingVertical: sp.sm,
          },
        ]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="返回机器列表"
          onPress={onBack}
          hitSlop={8}
          style={({pressed}) => [
            styles.toolbarControl,
            {borderRadius: r.sm, backgroundColor: pressed ? c.surfaceAlt : 'transparent'},
          ]}>
          <Text style={[t.label, {color: c.brand, fontWeight: '600' as const}]}>‹ 机器</Text>
        </Pressable>
        <Text
          numberOfLines={1}
          accessibilityRole="header"
          style={[t.heading, styles.serviceName, {color: c.text}]}>
          {service.name}
        </Text>
        {others.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="切换机器"
            accessibilityState={{expanded: switcherOpen}}
            onPress={() => setSwitcherOpen(open => !open)}
            hitSlop={8}
            style={({pressed}) => [
              styles.toolbarControl,
              {borderRadius: r.sm, backgroundColor: pressed ? c.surfaceAlt : 'transparent'},
            ]}>
            <Text style={[t.label, {color: c.brand, fontWeight: '600' as const}]}>
              {switcherOpen ? '收起' : '切换'}
            </Text>
          </Pressable>
        ) : (
          <View style={styles.toolbarControl} />
        )}
      </View>

      {switcherOpen && (
        <View
          style={[
            styles.switcher,
            {
              backgroundColor: c.surface,
              borderColor: c.border,
              borderRadius: r.md,
              shadowColor: c.shadowLifted,
              right: sp.md,
            },
          ]}>
          <FlatList
            data={others}
            keyExtractor={item => item.name}
            ListHeaderComponent={
              <Text
                style={[
                  t.caption,
                  styles.switcherHeader,
                  {color: c.textFaint, paddingHorizontal: sp.lg, paddingTop: sp.md},
                ]}>
                切换到
              </Text>
            }
            ListEmptyComponent={
              <Text
                style={[
                  t.caption,
                  {color: c.textMuted, paddingHorizontal: sp.lg, paddingVertical: sp.md},
                ]}>
                没有其它机器
              </Text>
            }
            renderItem={({item}) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`切换到 ${item.name}`}
                onPress={() => {
                  setSwitcherOpen(false);
                  onSwitch(item);
                }}
                style={({pressed}) => [
                  styles.switcherItem,
                  {
                    backgroundColor: pressed ? c.surfaceAlt : 'transparent',
                    paddingHorizontal: sp.lg,
                  },
                ]}>
                <Text style={[t.body, {color: c.text}]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={[t.monoSmall, {color: c.textFaint}]} numberOfLines={1}>
                  {item.url}
                </Text>
              </Pressable>
            )}
            ListFooterComponent={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="清缓存并重新加载"
                onPress={clearCacheReload}
                style={({pressed}) => [
                  styles.switcherItem,
                  styles.switcherFooter,
                  {
                    backgroundColor: pressed ? c.surfaceAlt : 'transparent',
                    borderTopColor: c.border,
                    paddingHorizontal: sp.lg,
                  },
                ]}>
                <Text style={[t.label, {color: c.textMuted}]}>清缓存并重新加载</Text>
              </Pressable>
            }
          />
        </View>
      )}

      <View style={styles.webviewWrap}>
        {!!loadError && (
          <View
            accessibilityLiveRegion="polite"
            style={[
              styles.errorBanner,
              {
                backgroundColor: c.warningBg,
                gap: sp.md,
                paddingHorizontal: sp.lg,
                paddingVertical: sp.md,
              },
            ]}>
            <Text style={[t.caption, {color: c.warning, flex: 1}]}>{loadError}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="重新加载"
              onPress={clearCacheReload}
              hitSlop={8}>
              <Text style={[t.label, {color: c.warning, fontWeight: '700' as const}]}>重试</Text>
            </Pressable>
          </View>
        )}
        <WebView
          ref={node => {
            webviewRef.current = node as WebView | null;
          }}
          domStorageEnabled
          injectedJavaScriptBeforeContentLoaded={POLYFILL_PATCH + TZ_PATCH}
          javaScriptEnabled
          onError={event => {
            // Without this the spinner overlay covered the page forever and the
            // user only saw "nothing happens".
            setLoaded(true);
            setLoadError(describeError(event));
          }}
          onHttpError={event => {
            setLoaded(true);
            setLoadError(describeHttpError(event));
          }}
          onLoadEnd={() => {
            setLoaded(true);
            console.info('SERVICE_WEBVIEW_RENDERED', service.url);
          }}
          onLoadStart={() => {
            setLoadError('');
          }}
          originWhitelist={['http://*', 'https://*']}
          source={{uri: pageOrigin}}
          style={styles.webview}
        />
        {!loaded && (
          <View
            style={[styles.loadingOverlay, {backgroundColor: c.bg, gap: sp.md}]}
            pointerEvents="none">
            <ActivityIndicator size="large" color={c.brandFill} />
            <Text style={[t.caption, {color: c.textMuted}]}>正在打开 {service.name}…</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toolbarControl: {
    minWidth: 64,
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: 8,
    justifyContent: 'center',
  },
  serviceName: {flex: 1, textAlign: 'center'},
  switcher: {
    position: 'absolute',
    top: 60,
    zIndex: 10,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: 300,
    width: 260,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: {width: 0, height: 4},
    elevation: 6,
  },
  switcherHeader: {textTransform: 'none'},
  switcherItem: {minHeight: MIN_TOUCH_TARGET, justifyContent: 'center', gap: 2, paddingVertical: 8},
  switcherFooter: {borderTopWidth: StyleSheet.hairlineWidth, alignItems: 'center'},
  webviewWrap: {flex: 1},
  webview: {flex: 1},
  errorBanner: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  loadingOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});