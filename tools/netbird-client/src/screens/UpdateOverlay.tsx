import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {
  DownloadProgress,
  UpdateCheckResult,
  cancelUpdateDownload,
  downloadAndInstall,
} from '../updater';
import {Button, MIN_TOUCH_TARGET} from '../theme/components';
import {useTheme} from '../theme/tokens';

type Phase = 'checking' | 'found' | 'downloading' | 'installing' | 'error';

type Props = {
  check: () => Promise<UpdateCheckResult | null>;
  visible: boolean;
  onClose: () => void;
};

/**
 * The update sheet.
 *
 * This was the last screen still built from hardcoded light values - a white
 * card carrying the previous brand blue regardless of the theme, so on a dark
 * phone the one place that asks for an install was also the one place that
 * ignored the reader's setting. (The literal value it used is recorded in
 * tokens.json's `retired` map, which the brand test sweeps for; repeating it here
 * would only teach the next reader a colour they must not use.) It now reads the same tokens as everything
 * else; the progress bar is the only determinate indicator in the app, because a
 * download has a known size.
 */
export default function UpdateOverlay({check, visible, onClose}: Props) {
  const {c, space: sp, radius: r, type: t} = useTheme();
  const [phase, setPhase] = useState<Phase>('checking');
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [error, setError] = useState('');
  const installTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (installTimer.current) {
        clearTimeout(installTimer.current);
        installTimer.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    if (!visible) {
      return;
    }
    setPhase('checking');
    setResult(null);
    setProgress(null);
    setError('');
    check()
      .then(found => {
        if (!found) {
          onClose();
          return;
        }
        setResult(found);
        setPhase('found');
      })
      .catch(e => {
        setError(e instanceof Error ? e.message : String(e));
        setPhase('error');
      });
  }, [visible, check, onClose]);

  const start = async () => {
    if (!result) {
      return;
    }
    setPhase('downloading');
    try {
      await downloadAndInstall(result.manifest, p => setProgress(p));
      setPhase('installing');
      installTimer.current = setTimeout(onClose, 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  const cancel = async () => {
    try {
      await cancelUpdateDownload();
    } catch (cancelError) {
      // The modal must still close: a failed cancel cannot trap the user here.
      console.warn('UPDATE_CANCEL_FAILED', cancelError);
    } finally {
      onClose();
    }
  };

  const requestClose = () => {
    // Backing out during a download has to cancel it, otherwise the transfer
    // keeps running invisibly and later opens the system installer on its own.
    if (phase === 'downloading') {
      cancel();
      return;
    }
    onClose();
  };

  const determinate = progress !== null && progress.total > 0;
  const megabytes = (bytes: number) => Math.round(bytes / 1024 / 1024);

  return (
    <Modal animationType="fade" onRequestClose={requestClose} transparent visible={visible}>
      <View style={[styles.backdrop, {backgroundColor: c.overlay, padding: sp["2xl"]}]}>
        <View
          accessibilityViewIsModal
          accessibilityLabel="应用更新"
          style={[
            styles.card,
            {
              backgroundColor: c.surface,
              borderColor: c.border,
              borderRadius: r.xl,
              padding: sp["2xl"],
              gap: sp.lg,
            },
          ]}>
          {phase === 'checking' && (
            <>
              <ActivityIndicator color={c.brandFill} />
              <Text style={[t.heading, styles.title, {color: c.text}]}>正在检查更新…</Text>
              <Text style={[t.caption, styles.detail, {color: c.textMuted}]}>正在查询更新通道</Text>
            </>
          )}

          {phase === 'found' && result && (
            <>
              <Text style={[t.title, styles.title, {color: c.text}]}>发现新版本</Text>
              <Text style={[t.mono, styles.detail, {color: c.textMuted}]}>
                {result.manifest.versionName}（v{result.manifest.versionCode}）
              </Text>
              <Text style={[t.body, styles.detail, {color: c.textMuted}]}>
                {result.manifest.notes || '更新内容见应用内提示'}
              </Text>
              <View style={[styles.row, {gap: sp.md}]}>
                <Button label="稍后" variant="quiet" onPress={onClose} style={styles.grow} />
                <Button label="立即更新" onPress={start} style={styles.grow} />
              </View>
            </>
          )}

          {phase === 'downloading' && (
            <>
              <Text style={[t.heading, styles.title, {color: c.text}]}>
                {determinate && progress ? `正在下载 ${progress.percent}%` : '正在下载安装包…'}
              </Text>
              <View style={[styles.barOuter, {backgroundColor: c.surfaceAlt, borderRadius: r.xs}]}>
                <View
                  style={[
                    styles.barInner,
                    {
                      backgroundColor: c.brandFill,
                      borderRadius: r.xs,
                      width: determinate && progress ? `${progress.percent}%` : '35%',
                    },
                  ]}
                />
              </View>
              <Text style={[t.caption, styles.detail, {color: c.textFaint}]}>
                {determinate && progress
                  ? `${megabytes(progress.bytes)} / ${megabytes(progress.total)} MB`
                  : '下载完成后会自动打开系统安装界面'}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="取消下载"
                onPress={cancel}
                hitSlop={8}
                style={styles.ghostCenter}>
                <Text style={[t.label, {color: c.danger, fontWeight: '600' as const}]}>
                  取消下载
                </Text>
              </Pressable>
            </>
          )}

          {phase === 'installing' && (
            <>
              <ActivityIndicator color={c.brandFill} />
              <Text style={[t.heading, styles.title, {color: c.text}]}>下载完成，正在安装…</Text>
              <Text style={[t.caption, styles.detail, {color: c.textMuted}]}>
                按系统提示完成安装，App 会自动重启
              </Text>
            </>
          )}

          {phase === 'error' && (
            <>
              <Text style={[t.heading, styles.title, {color: c.danger}]}>更新失败</Text>
              <Text style={[t.body, styles.detail, {color: c.textMuted}]}>{error}</Text>
              <Button label="关闭" variant="quiet" onPress={onClose} style={styles.grow} />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  card: {
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  title: {textAlign: 'center'},
  detail: {textAlign: 'center'},
  row: {flexDirection: 'row', marginTop: 6, alignSelf: 'stretch'},
  grow: {flex: 1},
  ghostCenter: {minHeight: MIN_TOUCH_TARGET, justifyContent: 'center'},
  barOuter: {width: '100%', height: 8, overflow: 'hidden'},
  barInner: {height: 8},
});