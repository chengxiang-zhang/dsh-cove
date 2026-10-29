import React, {useCallback, useEffect, useState} from 'react';
import {
  BackHandler,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {NetBirdPortal, ServerConfig} from '../NetBirdPortal';
import {readServerConfig, serverHostLabel, withTimeout} from '../netbird';
import {Button, Card, MIN_TOUCH_TARGET, SectionHeader, StatusDot} from '../theme/components';
import {useTheme} from '../theme/tokens';

/**
 * The bridge call that reads or writes the finished-run switch. Bounded because
 * a native call can stay pending forever (see `withTimeout`); the switch must
 * always be able to settle.
 */
const SWITCH_BRIDGE_TIMEOUT_MS = 3_000;

type Props = {
  /** Reachable machine count, or null while the catalogue is still loading. */
  machineCount: number | null;
  onBack: () => void;
  onCheckUpdate?: () => Promise<boolean>;
  onLogout: () => Promise<void>;
  /** Opens the management-address screen (see ServerScreen). */
  onOpenServer: () => void;
};

/**
 * Low-frequency actions live here rather than in the service-list footer, so
 * the footer stops competing with the one action that matters on that screen
 * (opening a machine).
 *
 * Rows are grouped into a connection group and an about group: a flat list made
 * "check for updates" and "sign out" look like peers, when one is a monthly
 * action and the other ends the session.
 */
export default function SettingsScreen({
  machineCount,
  onBack,
  onCheckUpdate,
  onLogout,
  onOpenServer,
}: Props) {
  const {c, space: sp, radius: r, type: t} = useTheme();
  const [version, setVersion] = useState('');
  const [checking, setChecking] = useState(false);
  const [upToDate, setUpToDate] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // Optimistic, matching the native default, so the row does not read as "off"
  // while the stored preference is still being read. A failed read leaves the
  // default in place rather than flipping the row behind the user's back.
  const [runNotifications, setRunNotifications] = useState(true);
  const [switchFailed, setSwitchFailed] = useState(false);
  // The control plane this install enrolls against, read from native: a row
  // printing a compiled default would keep naming the server the install stopped
  // using. Null means the bridge could not answer, which the row says out loud
  // instead of guessing a value.
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [serverReadFailed, setServerReadFailed] = useState(false);

  // Android's back button must go back one level, not close the app. Without
  // this the settings screen had no handler at all, so the system's default
  // finished the activity and the reader landed on the launcher.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const info = await NetBirdPortal.getAppVersion();
        if (alive) {
          setVersion(info.versionName);
        }
      } catch {
        // The version row is informational; an unreadable version is not an error.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

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

  const check = useCallback(async () => {
    if (!onCheckUpdate) {
      return;
    }
    setChecking(true);
    setCheckFailed(false);
    setUpToDate(false);
    try {
      const found = await onCheckUpdate();
      setUpToDate(!found);
    } catch {
      setCheckFailed(true);
    } finally {
      setChecking(false);
    }
  }, [onCheckUpdate]);

  // The stored choice, not a guess: the switch must show what the foreground
  // service will actually do on its next poll.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const enabled = await withTimeout(
          NetBirdPortal.getRunNotificationsEnabled(),
          SWITCH_BRIDGE_TIMEOUT_MS,
          '读取提醒设置超时',
        );
        if (alive) {
          setRunNotifications(enabled);
        }
      } catch {
        // An unreadable preference keeps the default (enabled) in place.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Turning this off must withdraw a notification that is already showing, and
   * turning it back on must start a fresh baseline - both of which happen on the
   * native side, because the foreground service owns the notification and the
   * watermark. The row shows the choice immediately and reverts if the write
   * fails, so the switch can never claim a setting that was not stored.
   */
  const toggleRunNotifications = useCallback(async () => {
    const next = !runNotifications;
    setRunNotifications(next);
    setSwitchFailed(false);
    try {
      await withTimeout(
        NetBirdPortal.setRunNotificationsEnabled(next),
        SWITCH_BRIDGE_TIMEOUT_MS,
        '保存提醒设置超时',
      );
    } catch {
      setRunNotifications(!next);
      setSwitchFailed(true);
    }
  }, [runNotifications]);

  const logout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await onLogout();
    } finally {
      setLoggingOut(false);
    }
  }, [onLogout]);


  const updateLabel = checking
    ? '检查中…'
    : checkFailed
    ? '检查失败，点此重试'
    : upToDate
    ? '已是最新'
    : '检查更新';

  const rowStyle = [styles.row, {borderBottomColor: c.border, paddingVertical: sp.lg}];

  const serverValue = serverReadFailed
    ? '读取失败，可重新设置'
    : server
    ? `${serverHostLabel(server.url)}${server.isCustom ? '（自建）' : '（默认）'}`
    : '读取中…';

  return (
    // The server editor lives inside this screen's scroll body, and the keyboard
    // otherwise covers the bottom of it - the editor's own buttons included (see
    // LoginScreen, where that was measured).
    <KeyboardAvoidingView
      style={[styles.container, {backgroundColor: c.bg}]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View
        style={[
          styles.header,
          {
            backgroundColor: c.surface,
            borderBottomColor: c.border,
            paddingHorizontal: sp.lg,
            paddingVertical: sp.md,
          },
        ]}>
        <Pressable
          testID="settings-back"
          accessibilityRole="button"
          accessibilityLabel="返回"
          onPress={onBack}
          hitSlop={8}
          style={({pressed}) => [
            styles.headerControl,
            {borderRadius: r.sm, backgroundColor: pressed ? c.surfaceAlt : 'transparent'},
          ]}>
          <Text style={[t.heading, {color: c.brand}]}>‹ 返回</Text>
        </Pressable>
        <Text style={[t.title, {color: c.text}]}>设置</Text>
        {/* Spacer keeps the title centred against the back control. */}
        <View style={styles.headerControl} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.body, {padding: sp.lg, gap: sp.xl}]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag">
        <View style={{gap: sp.sm}}>
          <SectionHeader title="连接" />
          <Card style={styles.flush}>
            <View style={rowStyle}>
              <Text style={[t.body, {color: c.text}]}>连接状态</Text>
              <View style={styles.valueRow}>
                <StatusDot
                  tone={machineCount ? 'success' : machineCount === null ? 'warning' : 'idle'}
                  pulsing={machineCount === null}
                />
                <Text style={[t.label, {color: c.textMuted}]}>
                  {machineCount === null
                    ? '连接中…'
                    : machineCount > 0
                    ? `已连接 · ${machineCount} 台机器可用`
                    : '已连接 · 没有可用机器'}
                </Text>
              </View>
            </View>

            <Pressable
              testID="settings-server"
              accessibilityRole="button"
              accessibilityLabel="登录服务器"
              accessibilityHint="切换这台手机连接的 NetBird 管理端地址"
              onPress={onOpenServer}
              style={[
                styles.row,
                {paddingVertical: sp.lg, borderBottomWidth: StyleSheet.hairlineWidth},
              ]}>
              <View style={styles.toggleCopy}>
                <Text style={[t.body, {color: c.text}]}>登录服务器</Text>
                <Text
                  numberOfLines={1}
                  style={[t.monoSmall, {color: serverReadFailed ? c.danger : c.textMuted}]}>
                  {serverValue}
                </Text>
              </View>
              <Text style={[t.label, {color: c.brand}]}>修改</Text>
            </Pressable>

            <Pressable
              testID="settings-check-update"
              accessibilityRole="button"
              accessibilityLabel="检查更新"
              accessibilityState={{disabled: checking, busy: checking}}
              disabled={checking}
              onPress={check}
              style={[
                styles.row,
                {paddingVertical: sp.lg, borderBottomWidth: StyleSheet.hairlineWidth},
              ]}>
              <Text style={[t.body, {color: c.text}]}>检查更新</Text>
              <Text style={[t.label, {color: checkFailed ? c.danger : c.brand}]}>{updateLabel}</Text>
            </Pressable>

            {/* The finished-run switch drives the Android foreground service's poller.
                iOS has neither that service nor the poller, so the switch would toggle a
                value nothing reads. */}
            {Platform.OS !== 'ios' && (
            <Pressable
              testID="settings-run-notifications"
              accessibilityRole="switch"
              accessibilityLabel="任务完成提醒"
              accessibilityState={{checked: runNotifications}}
              accessibilityHint="任务在本机机器上跑完后发通知提醒你"
              onPress={toggleRunNotifications}
              style={[styles.row, styles.lastRow, {paddingVertical: sp.lg}]}>
              <View style={styles.toggleCopy}>
                <Text style={[t.body, {color: c.text}]}>任务完成提醒</Text>
                <Text style={[t.caption, {color: switchFailed ? c.danger : c.textMuted}]}>
                  {switchFailed ? '设置没保存，请重试' : '从手机发起的任务跑完后提醒你'}
                </Text>
              </View>
              <View
                style={[
                  styles.toggleTrack,
                  {
                    backgroundColor: runNotifications ? c.brandFill : c.borderStrong,
                    borderColor: runNotifications ? c.brandFill : c.borderStrong,
                  },
                ]}>
                <View
                  style={[
                    styles.toggleKnob,
                    {
                      backgroundColor: c.surface,
                      transform: [{translateX: runNotifications ? 18 : 0}],
                    },
                  ]}
                />
              </View>
            </Pressable>
            )}
          </Card>
        </View>

        <View style={{gap: sp.sm}}>
          <SectionHeader title="关于" />
          <Card style={styles.flush}>
            <View style={[rowStyle, {borderBottomWidth: 0}]}>
              <Text style={[t.body, {color: c.text}]}>版本</Text>
              <Text style={[t.mono, {color: c.textMuted}]}>{version ? `v${version}` : '—'}</Text>
            </View>
          </Card>
        </View>

        <Button
          testID="settings-logout"
          label={loggingOut ? '退出中…' : '退出登录'}
          variant="danger"
          busy={loggingOut}
          onPress={logout}
          accessibilityHint="断开连接并清除本机保存的登录身份"
        />

        <Text style={[t.caption, styles.footnote, {color: c.textFaint}]}>
          Anywhere Work · 你的机器和班组
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1},
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerControl: {
    minWidth: 64,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: 'center',
  },
  body: {paddingBottom: 40},
  flush: {padding: 0, overflow: 'hidden'},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    gap: 12,
    minHeight: MIN_TOUCH_TARGET,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  lastRow: {borderBottomWidth: 0},
  valueRow: {flexDirection: 'row', alignItems: 'center', gap: 6},
  toggleCopy: {flex: 1, gap: 2},
  toggleTrack: {
    width: 46,
    height: 28,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 3,
    justifyContent: 'center',
  },
  toggleKnob: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  footnote: {textAlign: 'center'},
});
