import { font, useTheme } from '@/lib/theme';

/** The header of every stack: the ground of the theme, no line under it, the title in Manrope. */
export function useStackOptions() {
  const { colors } = useTheme();
  return {
    headerStyle: { backgroundColor: colors.ground },
    headerTintColor: colors.ink,
    headerShadowVisible: false,
    headerTitleStyle: { fontFamily: font, fontWeight: '600' as const, fontSize: 17 },
    contentStyle: { backgroundColor: colors.ground }
  };
}
