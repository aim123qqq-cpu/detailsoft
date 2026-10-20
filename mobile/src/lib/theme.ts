import { DarkTheme, type Theme } from 'expo-router';

/** The web app's palette, so both clients look like one product. */
export const colors = {
  ground: '#0b1016',
  surface: '#141c24',
  surfaceRaised: '#1d2730',
  line: '#26313b',
  text: '#eef1f3',
  muted: '#95a2af',
  soft: '#6f7c87',
  primary: '#ff7939',
  primaryInk: '#1b110d',
  ok: '#36c996',
  okInk: '#06281c',
  warn: '#f2c14e',
  danger: '#d94740'
} as const;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 } as const;
export const radius = { s: 8, m: 12, l: 16, pill: 999 } as const;

export const navigationTheme: Theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.primary,
    background: colors.ground,
    card: colors.ground,
    text: colors.text,
    border: colors.line,
    notification: colors.primary
  }
};
