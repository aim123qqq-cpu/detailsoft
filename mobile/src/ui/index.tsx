import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View, type PressableProps, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { Text, TextInput } from '@/ui/text';
import { cardShadow, floatShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { SyncBanner } from '@/features/sync-banner';
import { useTabBarSpace } from '@/ui/tab-bar';

// The base elements of the DetailFlow design system: a quiet ground, white cards with soft long shadows,
// black pill buttons; orange only for the brand action and the current step.

/** A scrolling screen body with the page margins; refresh control optional. */
export function Screen({ children, refreshControl, contentStyle }: { children: ReactNode; refreshControl?: React.ComponentProps<typeof ScrollView>['refreshControl']; contentStyle?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  const barSpace = useTabBarSpace();
  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.screenContent, barSpace ? { paddingBottom: barSpace + space.l } : null, contentStyle]} contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled" refreshControl={refreshControl}>
      <SyncBanner/>
      {children}
    </ScrollView>
  );
}

/** The screen's heading (h1): 30/36, thin and tight. */
export function Title({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.title} accessibilityRole="header">{children}</Text>;
}

/** A card or section heading (h2). */
export function Heading({ children, style }: { children: ReactNode; style?: StyleProp<any> }) {
  const styles = useStyles();
  return <Text style={[styles.heading, style]} accessibilityRole="header">{children}</Text>;
}

export function Body({ children, muted, style }: { children: ReactNode; muted?: boolean; style?: StyleProp<any> }) {
  const styles = useStyles();
  return <Text style={[styles.body, muted && styles.muted, style]}>{children}</Text>;
}

export function Label({ children, required }: { children: ReactNode; required?: boolean }) {
  const styles = useStyles();
  return <Text style={styles.label}>{children}{required ? <Text style={styles.required}> *</Text> : null}</Text>;
}

/** A white card; `tone="dark"` is the one dark accent card of a screen (the total, what needs a mark). */
export function Card({ children, style, tone }: { children: ReactNode; style?: StyleProp<ViewStyle>; tone?: 'dark' }) {
  const styles = useStyles();
  return <View style={[styles.card, tone === 'dark' && styles.darkCard, style]}>{children}</View>;
}

type ButtonTone = 'primary' | 'secondary' | 'brand' | 'raised' | 'danger' | 'quiet' | 'dangerQuiet';
type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  title: string;
  tone?: ButtonTone;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
  /** The text colour, for a button on a dark card that looks the same in both themes. */
  ink?: string;
};

/**
 * A pill button. primary: black (one per screen or card); secondary: soft, beside it; brand: orange,
 * only «Новая запись»; raised: white with a shadow on the ground; quiet: a text action; dangerQuiet: red text.
 */
export function Button({ title, tone = 'primary', busy, disabled, style, ink: inkColor, ...props }: ButtonProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const ink = inkColor ?? { primary: colors.pillInk, secondary: colors.ink, brand: colors.accentInk, raised: colors.ink, danger: '#FFFFFF', quiet: colors.ink, dangerQuiet: colors.sevHiText }[tone];
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled || busy), busy: Boolean(busy) }} disabled={disabled || busy}
      android_ripple={{ color: tone === 'primary' ? 'rgba(127,127,127,.25)' : 'rgba(127,127,127,.14)' }}
      style={({ pressed }) => [styles.button, styles[tone], (disabled || busy) && styles.disabled, pressed && styles.pressed, style]} {...props}>
      {busy ? <ActivityIndicator color={ink}/> : <Text style={[styles.buttonText, { color: ink }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, error, ref, style, required, ...props }: TextInputProps & { label: string; error?: string; required?: boolean; ref?: React.Ref<React.ComponentRef<typeof TextInput>> }) {
  const styles = useStyles();
  return (
    <View style={styles.field}>
      <Label required={required}>{label}</Label>
      <TextInput ref={ref} style={[styles.input, error ? styles.inputError : null, style]} {...props}/>
      {error ? <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text> : null}
    </View>
  );
}

/** A filter chip: the chosen one is a black pill, the rest white with a shadow. */
export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress: () => void }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: Boolean(selected) }} onPress={onPress}
      android_ripple={{ color: 'rgba(127,127,127,.14)', borderless: false }}
      style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A status chip. wait (peach): confirmed, at the customer's; work (sage): in work, intake, ready;
 * past (soft): closed, no-show, cancelled; attention (black): a time conflict. The words always say the status.
 */
export type PillTone = 'wait' | 'work' | 'past' | 'attention' | 'neutral' | 'accent' | 'ok' | 'warn';
export function Pill({ label, tone = 'past' }: { label: string; tone?: PillTone }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const kind = ({ neutral: 'past', accent: 'wait', ok: 'work', warn: 'wait' } as const)[tone as 'neutral'] ?? tone;
  const [background, ink] = { wait: [colors.tilePeach, colors.tileInk], work: [colors.tileSage, colors.tileInk], past: [colors.soft, colors.muted], attention: [colors.pill, colors.pillInk] }[kind as 'wait'];
  return <View style={[styles.pill, { backgroundColor: background }]}><Text style={[styles.pillText, { color: ink }]}>{label}</Text></View>;
}

export function Notice({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' }) {
  const styles = useStyles();
  return <View style={[styles.notice, tone === 'info' && styles.noticeInfo]} accessibilityLiveRegion="polite"><Text style={[styles.noticeText, tone === 'info' && styles.noticeInfoText]}>{children}</Text></View>;
}

export function Loading({ label }: { label: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return <View style={styles.center}><ActivityIndicator color={colors.ink} size="large"/><Text style={[styles.body, styles.muted, { marginTop: space.m }]}>{label}</Text></View>;
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.ground },
  screenContent: { padding: space.l, paddingBottom: space.xxl, gap: 14 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: '500', letterSpacing: -0.9 },
  heading: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21 },
  muted: { color: colors.muted },
  label: { color: colors.muted, fontSize: 12, lineHeight: 16, fontWeight: '600', marginBottom: 6 },
  required: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  card: { backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, gap: space.m, ...cardShadow(scheme) },
  darkCard: { backgroundColor: colors.darkCard, borderWidth: 0, boxShadow: undefined },
  button: { minHeight: 52, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, overflow: 'hidden' },
  primary: { backgroundColor: colors.pill },
  secondary: { backgroundColor: colors.soft },
  brand: { backgroundColor: colors.accent },
  raised: { backgroundColor: colors.surface, ...cardShadow(scheme) },
  danger: { backgroundColor: colors.sevHi },
  quiet: { backgroundColor: 'transparent', minHeight: 44 },
  dangerQuiet: { backgroundColor: 'transparent', minHeight: 44 },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.85 },
  buttonText: { fontSize: 15, lineHeight: 20, fontWeight: '700', textAlign: 'center' },
  field: { gap: 0 },
  input: { minHeight: 52, borderRadius: radius.m, backgroundColor: colors.surface, fontSize: 16, paddingHorizontal: space.l, borderWidth: 1, borderColor: colors.line },
  inputError: { borderColor: colors.sevHi },
  error: { color: colors.sevHiText, fontSize: 13, lineHeight: 18, marginTop: 6 },
  chip: { minHeight: 40, paddingHorizontal: space.l, borderRadius: radius.pill, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', ...cardShadow(scheme) },
  chipSelected: { backgroundColor: colors.pill },
  chipText: { fontSize: 14, fontWeight: '600' },
  chipTextSelected: { color: colors.pillInk },
  pill: { height: 26, borderRadius: radius.pill, paddingHorizontal: 10, justifyContent: 'center', alignSelf: 'flex-start' },
  pillText: { fontSize: 12, fontWeight: '700' },
  notice: { borderRadius: radius.m, padding: space.m, backgroundColor: colors.carTintHi },
  noticeInfo: { backgroundColor: colors.tilePeach },
  noticeText: { color: colors.sevHiText, fontSize: 14, lineHeight: 20 },
  noticeInfoText: { color: colors.tileInk },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl, backgroundColor: colors.ground },
  float: { ...floatShadow(scheme) }
}));
