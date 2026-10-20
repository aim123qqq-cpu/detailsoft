import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type PressableProps, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { colors, radius, space } from '@/lib/theme';

/** A scrolling screen body with the page margins; refresh control optional. */
export function Screen({ children, refreshControl, contentStyle }: { children: ReactNode; refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl']; contentStyle?: StyleProp<ViewStyle> }) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.screenContent, contentStyle]} contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled" refreshControl={refreshControl}>
      {children}
    </ScrollView>
  );
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title} accessibilityRole="header">{children}</Text>;
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: StyleProp<any> }) {
  return <Text style={[styles.body, muted && styles.muted, style]}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  title: string;
  tone?: 'primary' | 'secondary' | 'danger' | 'quiet' | 'dangerQuiet';
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Button({ title, tone = 'primary', busy, disabled, style, ...props }: ButtonProps) {
  const ink = tone === 'primary' ? colors.primaryInk : tone === 'danger' ? '#fff' : tone === 'quiet' ? colors.primary : tone === 'dangerQuiet' ? '#ff8a80' : colors.text;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }} disabled={disabled || busy}
      android_ripple={{ color: tone === 'primary' ? 'rgba(27,17,13,.18)' : 'rgba(255,255,255,.08)' }}
      style={({ pressed }) => [styles.button, styles[tone], (disabled || busy) && styles.disabled, pressed && styles.pressed, style]} {...props}>
      {busy ? <ActivityIndicator color={ink}/> : <Text style={[styles.buttonText, { color: ink }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string }) {
  return (
    <View style={styles.field}>
      <Label>{label}</Label>
      <TextInput placeholderTextColor={colors.soft} selectionColor={colors.primary} cursorColor={colors.primary}
        style={[styles.input, error ? styles.inputError : null]} {...props}/>
      {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
    </View>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: Boolean(selected) }} onPress={onPress}
      android_ripple={{ color: 'rgba(255,255,255,.08)', borderless: false }}
      style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'accent' | 'ok' | 'warn' }) {
  const palette = { neutral: [colors.surfaceRaised, colors.muted], accent: ['rgba(255,121,57,.16)', '#ffb48a'], ok: ['rgba(54,201,150,.16)', '#7fe2bf'], warn: ['rgba(242,193,78,.16)', '#f0d27a'] }[tone];
  return <View style={[styles.pill, { backgroundColor: palette[0] }]}><Text style={[styles.pillText, { color: palette[1] }]}>{label}</Text></View>;
}

export function Notice({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' }) {
  return <View style={[styles.notice, tone === 'info' && styles.noticeInfo]} accessibilityLiveRegion="polite"><Text style={[styles.noticeText, tone === 'info' && styles.noticeInfoText]}>{children}</Text></View>;
}

export function Loading({ label }: { label: string }) {
  return <View style={styles.center}><ActivityIndicator color={colors.primary} size="large"/><Text style={[styles.body, styles.muted, { marginTop: space.m }]}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  screenContent: { padding: space.l, paddingBottom: space.xxl, gap: space.m },
  title: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.3 },
  body: { color: colors.text, fontSize: 16, lineHeight: 23 },
  muted: { color: colors.muted },
  label: { color: colors.muted, fontSize: 13, fontWeight: '700', marginBottom: 6 },
  card: { backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, gap: space.s },
  button: { minHeight: 52, borderRadius: radius.m, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.l, overflow: 'hidden' },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surfaceRaised },
  danger: { backgroundColor: colors.danger },
  quiet: { backgroundColor: 'transparent' },
  dangerQuiet: { backgroundColor: 'transparent' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.88 },
  buttonText: { fontSize: 16, fontWeight: '800' },
  field: { gap: 0 },
  input: { minHeight: 52, borderRadius: radius.m, backgroundColor: colors.surface, color: colors.text, fontSize: 17, paddingHorizontal: space.l, borderWidth: 1, borderColor: colors.line },
  inputError: { borderColor: colors.danger },
  error: { color: '#ff9b9b', fontSize: 14, marginTop: 6 },
  chip: { minHeight: 40, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  chipSelected: { backgroundColor: colors.primary },
  chipText: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  chipTextSelected: { color: colors.primaryInk },
  pill: { borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '800' },
  notice: { borderRadius: radius.m, padding: space.m, backgroundColor: 'rgba(217,71,64,.12)' },
  noticeInfo: { backgroundColor: 'rgba(255,121,57,.1)' },
  noticeText: { color: '#ffb3ae', fontSize: 14, lineHeight: 20 },
  noticeInfoText: { color: '#ffc6a8' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, backgroundColor: colors.ground }
});
