/**
 * Anywhere Work design tokens.
 *
 * GENERATED FILE - do not edit. The source of truth is
 * tools/dsh-netbird/brand/tokens.json; regenerate with
 * `node scripts/dsh-netbird-brand.mjs --write` from the repository root and let
 * `pnpm test:scripts` prove the three consumers agree.
 *
 * Colours arrive as `light` and `dark` records with identical keys, so a screen
 * can never reference a colour that only exists in one scheme. Every text pair
 * that ships is asserted against WCAG AA by scripts/dsh-netbird-brand.test.mjs.
 *
 * Identifiers - host names, URLs, ports, status codes, versions - use the mono
 * face: they are meant to be compared character by character, which a
 * proportional face makes hard.
 */
import {Platform, useColorScheme} from 'react-native';

export type Scheme = 'light' | 'dark';

export type SchemeColors = {
  bg: string;
  surface: string;
  surfaceAlt: string;
  surfaceHover: string;
  border: string;
  borderStrong: string;
  controlBorder: string;
  text: string;
  textMuted: string;
  textFaint: string;
  brand: string;
  brandFill: string;
  brandFillHover: string;
  onBrandFill: string;
  accent: string;
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
  dangerFill: string;
  onDangerFill: string;
  focus: string;
  overlay: string;
  shadow: string;
  shadowLifted: string;
};

export const light: SchemeColors = {
  bg: '#F6F8FC',
  surface: '#FFFFFF',
  surfaceAlt: '#EEF2F7',
  surfaceHover: '#EEF2F7',
  border: '#DCE3EC',
  borderStrong: '#C3CEDD',
  controlBorder: '#8494A8',
  text: '#0F1B2D',
  textMuted: '#4A5B70',
  textFaint: '#586A80',
  brand: '#2563EB',
  brandFill: '#2563EB',
  brandFillHover: '#1D4ED8',
  onBrandFill: '#FFFFFF',
  accent: '#06B6D4',
  success: '#0B7A55',
  successBg: '#E6F6EF',
  warning: '#8A5200',
  warningBg: '#FDF3E3',
  danger: '#C02626',
  dangerBg: '#FDECEC',
  dangerFill: '#C02626',
  onDangerFill: '#FFFFFF',
  focus: '#1D4ED8',
  overlay: 'rgba(15, 27, 45, 0.48)',
  shadow: 'rgba(15, 27, 45, 0.10)',
  shadowLifted: 'rgba(15, 27, 45, 0.16)',
};

export const dark: SchemeColors = {
  bg: '#080D17',
  surface: '#111A2B',
  surfaceAlt: '#1A2438',
  surfaceHover: '#0D1524',
  border: '#253148',
  borderStrong: '#33415C',
  controlBorder: '#5B6E8C',
  text: '#E9EFF8',
  textMuted: '#A3B3C9',
  textFaint: '#8C9DB4',
  brand: '#7EB0FF',
  brandFill: '#2F6FE4',
  brandFillHover: '#2559C4',
  onBrandFill: '#FFFFFF',
  accent: '#22D3EE',
  success: '#4ADE9B',
  successBg: '#0E2A22',
  warning: '#F5C24B',
  warningBg: '#2E2410',
  danger: '#FF8A8A',
  dangerBg: '#2E1417',
  dangerFill: '#FF8A8A',
  onDangerFill: '#080D17',
  focus: '#7EB0FF',
  overlay: 'rgba(3, 7, 14, 0.66)',
  shadow: 'rgba(0, 0, 0, 0.40)',
  shadowLifted: 'rgba(0, 0, 0, 0.55)',
};

/** 4-point spacing scale, in density-independent pixels. */
export const space = {
  '3xs': 2,
  '2xs': 4,
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 56,
  '6xl': 72,
} as const;

export const radius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

/** Durations in milliseconds, for Animated timing configs. */
export const motion = {
  instant: 90,
  fast: 160,
  base: 240,
  slow: 400,
  deliberate: 900,
} as const;

export const elevation = {
  raised: 2,
  lifted: 8,
} as const;

const sans = Platform.select({ios: 'System', android: 'sans-serif', default: 'System'});
const sansMedium = Platform.select({ios: 'System', android: 'sans-serif-medium', default: 'System'});
const mono = Platform.select({ios: 'Menlo', android: 'monospace', default: 'monospace'});

export const type = {
  display: {fontFamily: sansMedium, fontSize: 30, lineHeight: 36, fontWeight: '700' as const},
  title: {fontFamily: sansMedium, fontSize: 21, lineHeight: 27, fontWeight: '600' as const},
  heading: {fontFamily: sansMedium, fontSize: 17, lineHeight: 23, fontWeight: '600' as const},
  body: {fontFamily: sans, fontSize: 15, lineHeight: 22, fontWeight: '400' as const},
  label: {fontFamily: sansMedium, fontSize: 13, lineHeight: 18, fontWeight: '500' as const},
  caption: {fontFamily: sans, fontSize: 12, lineHeight: 16, fontWeight: '400' as const},
  mono: {fontFamily: mono, fontSize: 13, lineHeight: 18, fontWeight: '400' as const},
  monoSmall: {fontFamily: mono, fontSize: 11.5, lineHeight: 16, fontWeight: '400' as const},
} as const;

export function theme(scheme: Scheme | null | undefined) {
  return {c: scheme === 'dark' ? dark : light, space, radius, type, motion, elevation};
}

export function useTheme() {
  return theme(useColorScheme());
}
