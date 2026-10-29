/**
 * Shared presentation components.
 *
 * The three-tier token file (primitive -> semantic -> component) only pays off if
 * the component tier actually exists: before this, each screen built its own
 * button and banner out of literal StyleSheet values, which is how the product
 * ended up with the old brand blue in two screens and the new one in three.
 *
 * Everything here reads `useTheme()`, so a screen cannot accidentally hardcode a
 * colour, and every interactive element is at least 48dp tall (Android/Material
 * guidance, and comfortably over WCAG 2.2 SC 2.5.8's 24x24 CSS px minimum).
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type {StyleProp, ViewStyle} from 'react-native';
import {useTheme} from './tokens';

export const MIN_TOUCH_TARGET = 48;

/**
 * Respect the OS "remove animations" setting. Motion is decoration; when the
 * reader has asked for less of it, an opacity pulse on a status dot is still
 * information, but a looping animation is not worth the vestibular cost.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then(value => {
        if (alive) {
          setReduced(value);
        }
      })
      .catch(() => {
        // An unavailable platform query must not decide the layout.
      });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', value => {
      if (alive) {
        setReduced(value);
      }
    });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduced;
}

type ButtonProps = {
  label: string;
  onPress: () => void;
  testID?: string;
  variant?: 'primary' | 'quiet' | 'danger';
  /** Shows a spinner and blocks a second press while the work is in flight. */
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

export function Button({
  label,
  onPress,
  testID,
  variant = 'primary',
  busy = false,
  busyLabel,
  disabled = false,
  style,
  accessibilityLabel,
  accessibilityHint,
}: ButtonProps) {
  const {c, space: sp, radius: r, type: t} = useTheme();
  const inactive = disabled || busy;

  const palette = {
    primary: {bg: c.brandFill, pressed: c.brandFillHover, border: 'transparent', text: c.onBrandFill},
    quiet: {bg: c.surface, pressed: c.surfaceAlt, border: c.controlBorder, text: c.text},
    danger: {bg: c.surface, pressed: c.dangerBg, border: c.controlBorder, text: c.danger},
  }[variant];

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      // The control announces its own in-flight state rather than relying on the
      // label swap, which a screen reader may not be watching.
      accessibilityState={{disabled: inactive, busy}}
      disabled={inactive}
      onPress={onPress}
      style={({pressed}) => [
        styles.button,
        {
          backgroundColor: pressed && !inactive ? palette.pressed : palette.bg,
          borderColor: palette.border,
          borderRadius: r.md,
          paddingHorizontal: sp.xl,
          minHeight: MIN_TOUCH_TARGET,
        },
        inactive ? styles.disabled : null,
        style,
      ]}>
      {busy ? (
        <>
          <ActivityIndicator size="small" color={palette.text} />
          <Text style={[t.heading, {color: palette.text}]}>{busyLabel ?? label}</Text>
        </>
      ) : (
        <Text style={[t.heading, {color: palette.text}]}>{label}</Text>
      )}
    </Pressable>
  );
}

type BannerProps = {
  tone: 'danger' | 'warning' | 'success' | 'info';
  message: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * An inline, non-modal message. Errors name what failed and offer the next step
 * in the same place, instead of a bare red sentence with the recovery control
 * somewhere else on the screen.
 */
export function Banner({tone, message, detail, actionLabel, onAction, style}: BannerProps) {
  const {c, space: sp, radius: r, type: t} = useTheme();
  const palette = {
    danger: {bg: c.dangerBg, text: c.danger},
    warning: {bg: c.warningBg, text: c.warning},
    success: {bg: c.successBg, text: c.success},
    info: {bg: c.surfaceAlt, text: c.textMuted},
  }[tone];

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.banner,
        {
          backgroundColor: palette.bg,
          borderRadius: r.md,
          padding: sp.lg,
          gap: sp.xs,
        },
        style,
      ]}>
      <Text style={[t.label, {color: palette.text, fontWeight: '600' as const}]}>{message}</Text>
      {!!detail && <Text style={[t.caption, {color: c.textMuted}]}>{detail}</Text>}
      {!!actionLabel && !!onAction && (
        <Pressable
          accessibilityRole="button"
          onPress={onAction}
          hitSlop={8}
          style={styles.bannerAction}>
          <Text style={[t.label, {color: palette.text, fontWeight: '700' as const}]}>
            {actionLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

type StatusDotProps = {
  tone: 'success' | 'warning' | 'danger' | 'idle';
  /** A slow opacity pulse, used only while the app is genuinely waiting. */
  pulsing?: boolean;
};

export function StatusDot({tone, pulsing = false}: StatusDotProps) {
  const {c} = useTheme();
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  const colour = {
    success: c.success,
    warning: c.warning,
    danger: c.danger,
    idle: c.textFaint,
  }[tone];

  useEffect(() => {
    if (!pulsing || reduced) {
      opacity.setValue(1);
      return;
    }
    // Opacity on a 8dp dot rather than a scaling or sweeping element: large
    // scaling and panning are the named vestibular triggers.
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {toValue: 0.35, duration: 700, useNativeDriver: true}),
        Animated.timing(opacity, {toValue: 1, duration: 700, useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, pulsing, reduced]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[styles.dot, {backgroundColor: colour, opacity}]}
    />
  );
}

type SkeletonProps = {
  width: number | `${number}%`;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * Placeholder with the geometry of the row that is coming, so the list does not
 * jump when data lands. Used for the machine list, whose shape is known.
 */
export function Skeleton({width, height, radius, style}: SkeletonProps) {
  const {c, radius: r} = useTheme();
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(0.55)).current;

  useEffect(() => {
    if (reduced) {
      opacity.setValue(0.75);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {toValue: 1, duration: 600, useNativeDriver: true}),
        Animated.timing(opacity, {toValue: 0.55, duration: 600, useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduced]);

  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[
        {backgroundColor: c.surfaceAlt, width, height, borderRadius: radius ?? r.sm, opacity},
        style,
      ]}
    />
  );
}

/** Row shell used by the machine list and the settings groups. */
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const {c, space: sp, radius: r} = useTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: c.surface,
          borderColor: c.border,
          borderRadius: r.lg,
          padding: sp.lg,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

/** Section heading with an optional right-aligned count or action. */
export function SectionHeader({title, trailing}: {title: string; trailing?: React.ReactNode}) {
  const {c, space: sp, type: t} = useTheme();
  return (
    <View style={[styles.sectionHeader, {paddingBottom: sp.sm}]}>
      <Text style={[t.label, {color: c.textMuted, fontWeight: '600' as const}]}>{title}</Text>
      {trailing}
    </View>
  );
}

/** Hook for a press that should not fire twice while its effect is in flight. */
export function useSingleFlight(): [boolean, (run: () => Promise<void>) => void] {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const run = useCallback((action: () => Promise<void>) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    action()
      .catch(() => {
        // Callers own their error surface; this only releases the latch.
      })
      .finally(() => {
        inFlight.current = false;
        setBusy(false);
      });
  }, []);
  return [busy, run];
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  disabled: {opacity: 0.55},
  banner: {alignItems: 'flex-start'},
  bannerAction: {paddingVertical: 4},
  dot: {width: 8, height: 8, borderRadius: 4},
  card: {borderWidth: StyleSheet.hairlineWidth},
  sectionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
});