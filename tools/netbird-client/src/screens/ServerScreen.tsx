/**
 * The management address as a screen of its own.
 *
 * It used to be a card that expanded in place, inside the login screen and again
 * inside settings: the only edit surface in two lists of read-only rows, grown
 * where it sat, carrying its own field, buttons, error line and reset row. That
 * is what put the field and the buttons under the keyboard twice (LoginScreen
 * records the measurements), and it left the settings side of it reachable only
 * after signing in.
 *
 * One screen instead: a header, a scrollable body, the editor, and room for the
 * probe that says whether the address exists before it is saved. Both entry
 * points navigate here, so there is one code path and the address can be
 * checked before sign-in - which is the state every fresh install starts in.
 */
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
import {ServerChange, ServerConfig} from '../NetBirdPortal';
import {readServerConfig} from '../netbird';
import ServerAddressEditor from '../components/ServerAddressEditor';
import {Card, MIN_TOUCH_TARGET} from '../theme/components';
import {useTheme} from '../theme/tokens';

type Props = {
  onBack: () => void;
  /**
   * Called after a save or a reset. `changed` means the enrollment was dropped
   * natively, so the caller has nothing left to be signed in as.
   */
  onSaved: (result: ServerChange) => void | Promise<void>;
};

export default function ServerScreen({onBack, onSaved}: Props) {
  const {c, space: sp, type: t} = useTheme();
  // undefined while the read is in flight. The editor prefills from the config
  // once, so mounting it before the answer arrives would leave the field empty
  // over the address it is meant to show.
  const [server, setServer] = useState<ServerConfig | null | undefined>(undefined);
  const readFailed = server === null;

  useEffect(() => {
    let alive = true;
    readServerConfig().then(config => {
      if (alive) {
        setServer(config);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  // Android's back button goes back one level, as it does on settings.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => subscription.remove();
  }, [onBack]);

  const handleSaved = useCallback(
    async (result: ServerChange) => {
      // Reported before leaving: a changed address dropped the old enrollment, and
      // only the caller knows where that leaves the app.
      await onSaved(result);
    },
    [onSaved],
  );

  return (
    <View style={[styles.container, {backgroundColor: c.bg}]}>
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
          testID="server-back"
          accessibilityRole="button"
          accessibilityLabel="返回"
          onPress={onBack}
          hitSlop={8}
          style={({pressed}) => [
            styles.headerControl,
            {backgroundColor: pressed ? c.surfaceAlt : 'transparent'},
          ]}>
          <Text style={[t.heading, {color: c.brand}]}>‹ 返回</Text>
        </Pressable>
        <Text style={[t.title, {color: c.text}]}>管理端地址</Text>
        {/* Spacer keeps the title centred against the back control. */}
        <View style={styles.headerControl} />
      </View>

      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={[styles.body, {padding: sp.lg, gap: sp.lg}]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag">
          <Text style={[t.caption, {color: c.textMuted}]}>
            这台手机登录到哪台 NetBird 管理端。
          </Text>
          {server === undefined ? (
            <Text testID="server-reading" style={[t.caption, {color: c.textMuted}]}>
              正在读取当前地址…
            </Text>
          ) : (
            <Card>
              <ServerAddressEditor
                config={server ?? {url: '', defaultUrl: '', isCustom: false}}
                onCancel={onBack}
                onSaved={handleSaved}
              />
            </Card>
          )}
          {readFailed && (
            <Text testID="server-read-failed" style={[t.caption, {color: c.danger}]}>
              读不到当前地址，可以直接填一个新的再保存。
            </Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
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
});