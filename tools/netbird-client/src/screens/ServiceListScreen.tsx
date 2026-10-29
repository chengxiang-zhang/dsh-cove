import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AppState,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  HARD_RESET_EVERY,
  ReconnectStreak,
  ServiceInfo,
  listServices,
  readConnectionDiagnostics,
  recordReconnectFailure,
  reconnectNotice,
  resetAndReconnect,
  resumePersistedConnection,
  shouldRefreshOnForeground,
  startReconnectStreak,
  withTimeout,
} from '../netbird';
import {ConnectionDiagnostics, NetBirdPortal} from '../NetBirdPortal';
import {Banner, Button, MIN_TOUCH_TARGET, SectionHeader, Skeleton, StatusDot} from '../theme/components';
import {useTheme} from '../theme/tokens';

/**
 * Non-empty marker meaning "the catalogue could not be loaded". The sentence
 * the user actually reads comes from reconnectNotice(), not from this string.
 */
const RECONNECT_PENDING = 'reconnect-pending';

/**
 * Ceilings for the two native reads behind the placeholder. Both are local calls
 * (`status()` is a snapshot; `listServices()` probes the accepted entries with a
 * 4s native budget each), so these only ever fire when a bridge call is wedged.
 * A pending promise used to leave `loading` true forever, with no retry armed
 * and no exit — the spinner variant of the same dead end.
 */
export const STATUS_READ_TIMEOUT_MS = 20_000;
export const SERVICES_READ_TIMEOUT_MS = 60_000;

/** Rows of placeholder geometry, matching the real row so nothing shifts. */
const SKELETON_ROWS = 3;

type Props = {
  onOpen: (service: ServiceInfo) => void;
  onAuthRequired: () => void;
  onLogout: () => Promise<void>;
  onOpenSettings: () => void;
  onServicesLoaded?: (services: ServiceInfo[]) => void;
};

export default function ServiceListScreen({
  onOpen,
  onAuthRequired,
  onLogout,
  onOpenSettings,
  onServicesLoaded,
}: Props) {
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [streak, setStreak] = useState<ReconnectStreak>(startReconnectStreak);
  const [diagnostics, setDiagnostics] = useState<ConnectionDiagnostics | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryAttempt = useRef(0);
  const authRequiredNotified = useRef(false);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors `streak` so a retry can decide synchronously whether the engine
  // needs a rebuild before React has re-rendered.
  const streakRef = useRef<ReconnectStreak>(startReconnectStreak());
  // When the catalogue was last read, so returning to the foreground re-reads it
  // without probing the whole fleet on every quick app switch.
  const lastLoadAt = useRef(0);

  const load = useCallback(
    async (asRefresh: boolean, options?: {hardReset?: boolean; background?: boolean}) => {
      const background = options?.background === true;
      if (asRefresh) {
        setRefreshing(true);
      } else if (!background) {
        setLoading(true);
      }
      if (!background) {
        setError('');
      }
      try {
        const status = await withTimeout(
          NetBirdPortal.status(),
          STATUS_READ_TIMEOUT_MS,
          '连接引擎没有在预期时间内回应',
        );
        if (!status.managementConnected) {
          throw new Error('management connection is still recovering');
        }
        // Only the registered DSH services come back from the native registry.
        const found = await withTimeout(
          listServices(),
          SERVICES_READ_TIMEOUT_MS,
          '读取服务清单超时',
        );
        retryAttempt.current = 0;
        authRequiredNotified.current = false;
        streakRef.current = startReconnectStreak();
        setStreak(streakRef.current);
        setDiagnostics(null);
        setError('');
        setServices(found);
        onServicesLoaded?.(found);
      } catch {
        // The native foreground service owns reconnection. A transient outage
        // keeps the saved login; only its explicit auth-required transition is
        // allowed to return to the login screen. What this screen must never do
        // again is sit on a message with no way forward.
        let persisted = true;
        try {
          persisted = await NetBirdPortal.hasPersistedConfig();
        } catch {
          // An unavailable native query is also transient.
        }
        if (!persisted) {
          if (!authRequiredNotified.current) {
            authRequiredNotified.current = true;
            onAuthRequired();
          }
          return;
        }
        streakRef.current = recordReconnectFailure(streakRef.current, Date.now());
        setStreak(streakRef.current);
        setDiagnostics(await readConnectionDiagnostics());
        // `resumePersistedConnection()` cannot revive a wedged engine: the
        // native `Portal.start()` is a no-op while an instance exists
        // (`native/portal.go:51-56`), so once the streak escalates the engine
        // gets rebuilt instead of waiting another round.
        // A rebuild is expensive, so background retries only rebuild every
        // HARD_RESET_EVERY failures; the manual button always rebuilds.
        const hardReset =
          options?.hardReset === true ||
          streakRef.current.failures % HARD_RESET_EVERY === 0;
        try {
          if (hardReset) {
            await resetAndReconnect();
          } else {
            await resumePersistedConnection();
          }
        } catch {
          // Service start can race with Android process startup; the next
          // backoff pass retries both the service and the catalogue.
        }
        setError(RECONNECT_PENDING);
      } finally {
        lastLoadAt.current = Date.now();
        setLoading(false);
        setRefreshing(false);
      }
    },
    [onAuthRequired, onServicesLoaded],
  );

  useEffect(() => {
    load(false);
    return () => {
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current);
        noticeTimer.current = null;
      }
    };
  }, [load]);

  // Coming back to the foreground is the moment the world may have changed: a machine
  // joined the fleet, one went away, or a reachability flipped while the app was
  // backgrounded - none of it is pushed, so the list has to be read again. Android may
  // also have throttled the backoff timers while backgrounded, which is the other reason
  // not to wait for the next tick. A failing list is already retrying, so it refreshes
  // immediately; a healthy one is throttled so an app switch does not probe the fleet.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        return;
      }
      if (
        shouldRefreshOnForeground({
          lastLoadAt: lastLoadAt.current,
          now: Date.now(),
          failures: streakRef.current.failures,
        })
      ) {
        load(false, {background: true});
      }
    });
    return () => subscription.remove();
  }, [load]);

  useEffect(() => {
    if (!error || services.length > 0) {
      return;
    }
    const delay = Math.min(30000, 3000 * 2 ** retryAttempt.current);
    retryAttempt.current += 1;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      // Background pass: keep the current screen (and its reason line) visible
      // instead of flashing the full-screen placeholder every backoff step.
      load(false, {background: true});
    }, delay);
    return () => {
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
    // `streak.failures` is what keeps the chain alive: the error marker itself
    // never changes, so depending on it alone stopped the retries after the
    // first one while the screen kept claiming it was still retrying.
  }, [error, load, services.length, streak.failures]);

  const logout = async () => {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    try {
      await onLogout();
    } catch (logoutError) {
      // The caller already returns to the login screen; this only keeps the
      // rejection from surfacing as an unhandled promise.
      console.warn('PORTAL_LOGOUT_FAILED', logoutError);
    } finally {
      setLoggingOut(false);
    }
  };

  const {c, space: sp, radius: r, type: t} = useTheme();

  const machineCount = services.length;
  const settled = error === '' && services.length > 0;

  return (
    <View style={[styles.container, {backgroundColor: c.bg}]}>
      <View
        style={[
          styles.header,
          {
            backgroundColor: c.surface,
            borderBottomColor: c.border,
            paddingHorizontal: sp.lg,
            paddingTop: sp.md,
            paddingBottom: sp.md,
          },
        ]}>
        <Image
          source={require('../../assets/brand/icon.png')}
          style={styles.headerLogo}
          resizeMode="contain"
        />
        <View style={styles.headerText}>
          <Text style={[t.title, {color: c.text}]}>Anywhere Work</Text>
          <View style={styles.statusRow}>
            <StatusDot
              tone={settled ? 'success' : error ? 'warning' : 'idle'}
              pulsing={!settled}
            />
            <Text style={[t.label, {color: c.textMuted}]}>
              {settled
                ? `已连接 · ${machineCount} 台机器可用`
                : error
                ? '正在重新连接内网'
                : '正在确认连接状态'}
            </Text>
          </View>
        </View>
        <Pressable
          testID="service-list-settings"
          accessibilityRole="button"
          accessibilityLabel="设置"
          accessibilityHint="查看连接状态、检查更新、退出登录"
          onPress={onOpenSettings}
          hitSlop={8}
          style={({pressed}) => [
            styles.headerAction,
            {
              borderRadius: r.sm,
              backgroundColor: pressed ? c.surfaceAlt : 'transparent',
            },
          ]}>
          <Text style={[t.label, {color: c.brand, fontWeight: '600' as const}]}>设置</Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={[styles.list, {padding: sp.lg, gap: sp.md}]}>
          <Skeleton width="34%" height={14} />
          {Array.from({length: SKELETON_ROWS}).map((_, index) => (
            <View
              key={index}
              style={[
                styles.card,
                {
                  backgroundColor: c.surface,
                  borderColor: c.border,
                  borderRadius: r.lg,
                  padding: sp.lg,
                  gap: sp.sm,
                },
              ]}>
              <Skeleton width="48%" height={18} />
              <Skeleton width="72%" height={13} />
            </View>
          ))}
          <Text style={[t.caption, {color: c.textFaint, textAlign: 'center'}]}>
            正在连接内网、检查已登记的机器…
          </Text>
        </View>
      ) : error && services.length === 0 ? (
        <View style={[styles.errorWrap, {padding: sp['2xl'], gap: sp.lg}]}>
          {(() => {
            const notice = reconnectNotice(streak, diagnostics);
            return (
              <>
                <View style={[styles.errorHead, {gap: sp.sm}]}>
                  <Text style={[t.title, styles.centred, {color: c.text}]}>{notice.message}</Text>
                  {!!notice.detail && (
                    <Text style={[t.body, styles.centred, {color: c.textMuted}]}>
                      {notice.detail}
                    </Text>
                  )}
                </View>
                <Banner
                  tone="warning"
                  message={`已自动重试 ${streak.failures} 次`}
                  detail="后台会继续重试；也可以立刻重建连接，或重新登录换一个身份。"
                />
                <View style={[styles.errorActions, {gap: sp.md}]}>
                  <Button
                    testID="service-list-retry"
                    label="重试"
                    onPress={() => load(false, {hardReset: true})}
                    style={styles.grow}
                  />
                  <Button
                    testID="service-list-relogin"
                    label={loggingOut ? '退出中…' : '重新登录'}
                    variant="quiet"
                    busy={loggingOut}
                    onPress={logout}
                    style={styles.grow}
                  />
                </View>
              </>
            );
          })()}
        </View>
      ) : (
        <FlatList
          contentContainerStyle={[styles.list, {padding: sp.lg, gap: sp.md}]}
          data={services}
          keyExtractor={item => item.name}
          ListHeaderComponent={
            <SectionHeader
              title="我的机器"
              trailing={
                <Text style={[t.caption, {color: c.textFaint}]}>
                  {machineCount > 0 ? `${machineCount} 台` : ''}
                </Text>
              }
            />
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => load(true)}
              tintColor={c.textMuted}
              colors={[c.brandFill]}
            />
          }
          ListEmptyComponent={
            <View style={[styles.empty, {gap: sp.lg}]}>
              <Text style={[t.body, styles.centred, {color: c.text}]}>
                还没有可以打开的机器
              </Text>
              <Text style={[t.caption, styles.centred, {color: c.textMuted}]}>
                这台设备是当前身份的第一台，或者那台机器还没装好入口。装好第二台设备后，两台会互相出现。
              </Text>
              <Button
                label="重新检查"
                variant="quiet"
                onPress={() => load(false, {hardReset: true})}
              />
            </View>
          }
          renderItem={({item}) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name}，${item.url}，${
                item.needsLogin ? '需要登录' : `状态 ${item.statusCode}`
              }`}
              accessibilityHint="在 App 内打开这台机器的工作区"
              onPress={() => onOpen(item)}
              style={({pressed}) => [
                styles.card,
                styles.row,
                {
                  backgroundColor: pressed ? c.surfaceAlt : c.surface,
                  borderColor: c.border,
                  borderRadius: r.lg,
                  padding: sp.lg,
                },
              ]}>
              <View style={styles.cardText}>
                <Text style={[t.heading, {color: c.text}]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={[t.monoSmall, {color: c.textFaint}]} numberOfLines={1}>
                  {item.url}
                </Text>
              </View>
              <View style={styles.badgeRow}>
                {item.needsLogin && (
                  <View
                    style={[
                      styles.badge,
                      {backgroundColor: c.warningBg, borderRadius: r.xs},
                    ]}>
                    <Text style={[t.caption, {color: c.warning, fontWeight: '600' as const}]}>
                      需登录
                    </Text>
                  </View>
                )}
                <Text style={[t.monoSmall, {color: c.textMuted}]}>{item.statusCode}</Text>
                <Text style={[t.heading, {color: c.textFaint}]} accessibilityElementsHidden>
                  ›
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerLogo: {width: 40, height: 40},
  headerText: {flex: 1, gap: 2},
  headerAction: {
    minHeight: MIN_TOUCH_TARGET,
    minWidth: MIN_TOUCH_TARGET,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  list: {flexGrow: 1},
  card: {borderWidth: StyleSheet.hairlineWidth},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: 64,
  },
  cardText: {flex: 1, gap: 4},
  badgeRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  badge: {paddingHorizontal: 8, paddingVertical: 3},
  empty: {paddingVertical: 40, paddingHorizontal: 8, alignItems: 'center', alignSelf: 'stretch'},
  errorWrap: {flex: 1, justifyContent: 'center'},
  errorHead: {alignItems: 'center'},
  errorActions: {flexDirection: 'row', alignItems: 'center'},
  grow: {flex: 1},
  centred: {textAlign: 'center'},
});