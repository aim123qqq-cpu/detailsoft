import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, type Theme } from 'expo-router';
import * as SecureStore from 'expo-secure-store';

// The palettes of the DetailFlow design system: a quiet light workshop and its dark twin.
// Colour carries meaning only where the design says so: orange for the brand and the current step,
// pastel tiles for figures, red-orange-yellow for damage.
const light = {
  ground: '#F3F3F1',
  surface: '#FFFFFF',
  soft: '#F1F1EF',
  line: '#ECECEA',
  ink: '#121212',
  // The design's #7B7D80 is below 4.5:1 for small text; its own advice is this shade.
  muted: '#6E7073',
  accent: '#EE6A22',
  accentInk: '#FFFFFF',
  pill: '#121212',
  pillInk: '#FFFFFF',
  tileSky: '#DCE6EA',
  tileSage: '#E3ECC4',
  tilePeach: '#FADFCD',
  tileInk: '#121212',
  darkCard: '#18191B',
  darkCardInk: '#F4F4F2',
  ok: '#2E9B5A',
  okText: '#23784A',
  warn: '#E08A00',
  warnText: '#A86400',
  sevHi: '#D9472F',
  sevMid: '#E5862C',
  sevLo: '#D8B43A',
  sevHiText: '#B8361F',
  carPanel: '#FFFFFF',
  carDraw: '#8F918E',
  carTintHi: '#F8D2CB',
  carTintMid: '#FADDC2',
  carTintLo: '#F1E7C1',
  carSelected: '#FCE1D2',
  carGlass: '#E3E7EA',
  carWheel: '#E6E6E3',
  carTail: '#F6DAD5',
  carTailLine: '#D4402F',
  sceneDot: '#DCDCD8',
  scrim: 'rgba(10,10,12,0.45)',
  shadow: '#121212'
};

export type Palette = typeof light & Legacy;

const dark: typeof light = {
  ground: '#0E0F10',
  surface: '#18191B',
  soft: '#222326',
  line: '#26272A',
  ink: '#F4F4F2',
  muted: '#97999D',
  accent: '#FF8A4C',
  accentInk: '#121212',
  pill: '#F4F4F2',
  pillInk: '#121212',
  tileSky: '#1E2A30',
  tileSage: '#262E17',
  tilePeach: '#352218',
  tileInk: '#F4F4F2',
  darkCard: '#18191B',
  darkCardInk: '#F4F4F2',
  ok: '#4FCB83',
  okText: '#4FCB83',
  warn: '#FFB340',
  warnText: '#FFB340',
  sevHi: '#F0604A',
  sevMid: '#F2953E',
  sevLo: '#E3C24A',
  sevHiText: '#FF9A88',
  carPanel: '#1F2022',
  carDraw: '#74777C',
  carTintHi: '#4B2420',
  carTintMid: '#47321C',
  carTintLo: '#3F3819',
  carSelected: '#45281A',
  carGlass: '#141517',
  carWheel: '#0B0B0C',
  carTail: '#3D201D',
  carTailLine: '#F0604A',
  sceneDot: '#222326',
  scrim: 'rgba(0,0,0,0.6)',
  shadow: '#000000'
};

/** The names the screens used before the redesign, so each screen can move to the new ones in its own time. */
type Legacy = { text: string; primary: string; primaryInk: string; surfaceRaised: string; faint: string; danger: string; okInk: string };
const withLegacy = (p: typeof light, okInk: string): Palette => ({
  ...p, text: p.ink, primary: p.accent, primaryInk: p.accentInk, surfaceRaised: p.soft, faint: p.muted, danger: p.sevHi, okInk
});

export const palettes = { light: withLegacy(light, '#FFFFFF'), dark: withLegacy(dark, '#0E2416') } as const;
export type Scheme = keyof typeof palettes;
export type ThemePreference = Scheme | 'system';

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;
export const radius = { xs: 5, s: 14, m: 20, l: 26, xl: 30, pill: 999 } as const;
/** The one typeface. The app embeds its faces under this family; the weight picks the face. */
export const font = 'Manrope';

/** The soft long shadow of a card; in the dark theme a thin light outline instead. */
export function cardShadow(scheme: Scheme) {
  return scheme === 'dark'
    ? { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.08)' }
    : { boxShadow: '0 1px 1px rgba(18,18,18,0.03), 0 18px 40px -12px rgba(18,18,18,0.10)' };
}
export function floatShadow(scheme: Scheme) {
  return { boxShadow: scheme === 'dark' ? '0 16px 40px -8px rgba(0,0,0,0.6)' : '0 16px 40px -8px rgba(18,18,18,0.18)' };
}

const STORED = 'detailflow.theme';
type ThemeState = { scheme: Scheme; colors: Palette; preference: ThemePreference; setPreference: (value: ThemePreference) => void };
const ThemeContext = createContext<ThemeState>({ scheme: 'light', colors: palettes.light, preference: 'system', setPreference: () => {} });

/** The theme of the phone, unless the person chose one in the profile. */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  useEffect(() => {
    SecureStore.getItemAsync(STORED).then((value) => { if (value === 'light' || value === 'dark') setPreferenceState(value); }).catch(() => {});
  }, []);
  const value = useMemo<ThemeState>(() => {
    const scheme: Scheme = preference === 'system' ? (system === 'dark' ? 'dark' : 'light') : preference;
    return {
      scheme, colors: palettes[scheme], preference,
      setPreference: (next) => {
        setPreferenceState(next);
        (next === 'system' ? SecureStore.deleteItemAsync(STORED) : SecureStore.setItemAsync(STORED, next)).catch(() => {});
      }
    };
  }, [preference, system]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

/** Styles that follow the theme: made once per theme (the builder calls StyleSheet.create), shared by every screen. */
export function makeStyles<T extends object>(build: (colors: Palette, scheme: Scheme) => T) {
  const made: Partial<Record<Scheme, T>> = {};
  return function useStyles(): T {
    const { scheme, colors } = useTheme();
    return (made[scheme] ??= build(colors, scheme));
  };
}

export function navigationTheme(scheme: Scheme): Theme {
  const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
  const colors = palettes[scheme];
  return {
    ...base,
    colors: { ...base.colors, primary: colors.accent, background: colors.ground, card: colors.ground, text: colors.ink, border: colors.line, notification: colors.accent }
  };
}
