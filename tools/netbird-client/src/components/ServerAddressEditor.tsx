/**
 * The management-server field, shared by the login screen and settings.
 *
 * Both surfaces need the same three things and nothing else differs between
 * them: the address in force, one place to type another, and the honest
 * consequence of saving it. Keeping one component means the login screen cannot
 * grow a second, laxer validation path - the rule lives natively
 * (`NetBirdServerAddress.kt`) and this only displays what it answers.
 *
 * Saving an address that differs from the one in force drops the local
 * enrollment, because the identity belongs to the old control plane. The hint
 * says so before the press, and the parent decides where to go afterwards.
 *
 * Measured on a device: the field arrives prefilled with the address in force,
 * so tapping it put the caret at the end of a 30-character URL and the next
 * keystroke appended to it. Replacing the address meant holding backspace
 * first. The field now selects its whole content on focus and carries its own
 * clear button, so the first keystroke replaces the old address - which is what
 * someone who just tapped "修改" is about to do.
 *
 * The keyboard also has to be dismissible from the field itself: the actions sit
 * below it, and on a short screen the keyboard covers them (LoginScreen owns
 * that layout fix). The IME action is "done" and drops the keyboard, so there is
 * always a one-gesture way back to the buttons.
 */
import React, {useCallback, useRef, useState} from 'react';
import {ActivityIndicator, Keyboard, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import {ServerConfig} from '../NetBirdPortal';
import {
  ManagementProbe,
  chooseServer,
  probeManagementServer,
  restoreDefaultServer,
  serverDisplayUrl,
  serverHostLabel,
} from '../netbird';
import {Button, MIN_TOUCH_TARGET} from '../theme/components';
import {useTheme} from '../theme/tokens';

type Props = {
  /** The address in force, plus the default a reset would return to. */
  config: ServerConfig;
  /** Leaves the editor without saving. */
  onCancel: () => void;
  /** Called after a save or a reset; `changed` means the session was ended. */
  onSaved: (result: {url: string; changed: boolean}) => void | Promise<void>;
};

export default function ServerAddressEditor({config, onCancel, onSaved}: Props) {
  const {c, space: sp, radius: r, type: t} = useTheme();
  // Prefilled with the address in force: "change the server" starts from what it
  // is now, and the default is one press away in the same field.
  // Prefilled with the address in force, in the form a person reads: the port is
  // left out when https already implies it. Saving it unchanged is a no-op
  // natively, which compares canonical addresses rather than strings.
  const [value, setValue] = useState(serverDisplayUrl(config.url));
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ManagementProbe | null>(null);
  // The ref is typed by the instance rather than by the imported component:
  // `useRef<TextInput>` resolves to a props type that has no `focus()`.
  const inputRef = useRef<React.ComponentRef<typeof TextInput>>(null);
  const busy = saving || resetting;

  const run = useCallback(
    async (work: () => Promise<{url: string; changed: boolean}>) => {
      setError('');
      try {
        const result = await work();
        // Awaited so the caller's follow-up (re-reading the address, ending the
        // session) finishes inside the same press rather than after it.
        await onSaved(result);
      } catch (failure) {
        // A rejected address explains itself in the field it came from; the
        // message is the native rule's own wording.
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [onSaved],
  );

  const save = useCallback(async () => {
    setSaving(true);
    try {
      await run(() => chooseServer(value));
    } finally {
      setSaving(false);
    }
  }, [run, value]);

  const reset = useCallback(async () => {
    setResetting(true);
    try {
      await run(() => restoreDefaultServer());
    } finally {
      setResetting(false);
    }
  }, [run]);

  const test = useCallback(async () => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await probeManagementServer(value));
    } finally {
      setProbing(false);
    }
  }, [value]);

  const clear = useCallback(() => {
    setValue('');
    setError('');
    setProbe(null);
    // Tapping the clear control may be the first touch on a keyboard-less
    // screen, so hand the field the focus the user is about to type into.
    inputRef.current?.focus();
  }, []);

  return (
    <View style={{gap: sp.md}}>
      <View style={styles.field}>
        <TextInput
          ref={inputRef}
          testID="server-editor-input"
          accessibilityLabel="管理端地址"
          accessibilityHint="例如 https://netbird.example.com，只填主机；端口不是 443 时才需要写"
          value={value}
          onChangeText={text => {
            setValue(text);
            // A verdict belongs to the address it was measured against: keeping
            // it after an edit would describe an address the reader is no longer
            // looking at.
            setProbe(null);
          }}
          editable={!busy}
          // Replacing the address is the whole point of opening this field, and
          // it arrives prefilled: selecting it all makes the first keystroke
          // replace it instead of appending to it.
          selectTextOnFocus
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
          keyboardType="url"
          returnKeyType="done"
          // The actions are below this field and the keyboard covers them on a
          // short screen, so "done" has to put the buttons back in reach.
          onSubmitEditing={() => Keyboard.dismiss()}
          placeholder={serverDisplayUrl(config.defaultUrl)}
          placeholderTextColor={c.textFaint}
          style={[
            t.mono,
            styles.input,
            {
              borderColor: c.controlBorder,
              backgroundColor: c.surface,
              color: c.text,
              borderRadius: r.sm,
              paddingHorizontal: sp.md,
              paddingRight: MIN_TOUCH_TARGET + sp.md,
            },
          ]}
        />
        {value.length > 0 && !busy && (
          <Pressable
            testID="server-editor-clear"
            accessibilityRole="button"
            accessibilityLabel="清空管理端地址"
            onPress={clear}
            hitSlop={8}
            style={styles.clear}>
            <Text style={[t.body, {color: c.textFaint}]}>×</Text>
          </Pressable>
        )}
      </View>
      <Text style={[t.caption, {color: c.textFaint}]}>
        填你自己那台 NetBird 管理端的地址，只填主机和端口。换成别的服务器会清除本机登录，需要重新登录。
      </Text>
      {!!error && (
        <Text testID="server-editor-error" style={[t.caption, {color: c.danger}]}>
          {error}
        </Text>
      )}
      <View style={[styles.probeRow, {gap: sp.md}]}>
        <Button
          testID="server-editor-test"
          label="测试连接"
          variant="quiet"
          busy={probing}
          busyLabel="测试中…"
          disabled={busy}
          onPress={test}
          accessibilityHint="用手机自己的网络探测这个地址是不是 NetBird 管理端"
        />
        {probe && (
          <Text
            testID="server-editor-verdict"
            numberOfLines={2}
            style={[
              t.caption,
              styles.grow,
              {color: probe.reachable ? c.textMuted : c.danger},
            ]}>
            {probeSummary(probe)}
          </Text>
        )}
        {!probe && probing && (
          <ActivityIndicator testID="server-editor-test-progress" size="small" color={c.textMuted} />
        )}
      </View>
      <View style={[styles.actions, {gap: sp.md}]}>
        <Button
          testID="server-editor-save"
          label="保存"
          busy={saving}
          busyLabel="保存中…"
          onPress={save}
          style={styles.grow}
        />
        <Button
          testID="server-editor-cancel"
          label="取消"
          variant="quiet"
          disabled={busy}
          onPress={onCancel}
        />
      </View>
      {busy && (
        // Saving a changed address stops the old connection first, which can take
        // tens of seconds when that connection is mid-retry (measured on a device:
        // ~40s). An unexplained spinner that long reads as a hang.
        <Text testID="server-editor-progress" style={[t.caption, {color: c.textMuted}]}>
          {resetting ? '正在恢复默认地址并清除旧登录…' : '正在断开旧连接并清除旧登录…'}
        </Text>
      )}
      {config.isCustom && (
        <Pressable
          testID="server-editor-reset"
          accessibilityRole="button"
          accessibilityLabel={`恢复默认服务器 ${serverHostLabel(config.defaultUrl)}`}
          disabled={busy}
          onPress={reset}
          style={styles.reset}>
          <Text style={[t.caption, {color: busy ? c.textFaint : c.brand}]}>
            {resetting ? '恢复中…' : `恢复默认（${serverHostLabel(config.defaultUrl)}）`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/** One line for the reader: what answered, or why nothing did. */
function probeSummary(probe: ManagementProbe): string {
  if (probe.verdict === 'management') {
    // 401 is the expected answer to an unauthenticated call, not a failure.
    return `可连接 · NetBird 管理端（HTTP ${probe.statusCode}）`;
  }
  if (probe.verdict === 'answering') {
    // The host and its certificate are fine; the address is just not this
    // product's control plane, which is what the install would enroll against.
    return `可连接，但这里不是 NetBird 管理端（HTTP ${probe.statusCode}）`;
  }
  return `连不上 · ${probe.detail}`;
}

const styles = StyleSheet.create({
  field: {justifyContent: 'center'},
  probeRow: {flexDirection: 'row', alignItems: 'center'},
  input: {
    minHeight: MIN_TOUCH_TARGET,
    borderWidth: StyleSheet.hairlineWidth,
  },
  // Inside the field's right edge, over the input's own padding, so the whole
  // control stays one 48dp row instead of growing a second one.
  clear: {
    position: 'absolute',
    right: 0,
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {flexDirection: 'row', alignItems: 'center'},
  grow: {flex: 1},
  reset: {minHeight: MIN_TOUCH_TARGET, justifyContent: 'center', alignItems: 'center'},
});