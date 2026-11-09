import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { cardShadow, makeStyles, useTheme } from '@/lib/theme';
import { Icon, type IconName } from '@/ui/icons';
import { Text } from '@/ui/text';

/** The mark «Стекло»: a car from the front in one line, its windscreen in the brand orange. Readable down to 22 px. */
export function Mark({ size = 32, ink, glass }: { size?: number; ink?: string; glass?: string }) {
  const { colors } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="272 272 480 480" aria-hidden>
      <Path d="M370 400L340 480H684L654 400Z" fill={glass ?? colors.accent}/>
      <Path d="M322 582V488L366 368H658L702 488V582M322 536H702M393 536V582M632 536V582M370 655H393M632 655H655" fill="none"
        stroke={ink ?? colors.ink} strokeWidth={46} strokeLinecap="round" strokeLinejoin="round"/>
    </Svg>
  );
}

/** The mark on its white plate (rounded by 26 % of the side), as on the sign-in screen. */
export function MarkTile({ size = 112, faded }: { size?: number; faded?: boolean }) {
  const { scheme, colors } = useTheme();
  return (
    <View style={[{ width: size, height: size, borderRadius: Math.round(size * 0.27), backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', opacity: faded ? 0.45 : 1 }, cardShadow(scheme)]}>
      <Mark size={Math.round(size * 0.68)}/>
    </View>
  );
}

/** The soft light at the top of the main screens: peach, mint and lavender. The only gradient of the system. */
export function Wash({ height = 520 }: { height?: number }) {
  const { scheme } = useTheme();
  const image = scheme === 'dark'
    ? 'radial-gradient(120% 60% at 0% 0%, rgba(238,106,34,0.20) 0%, rgba(238,106,34,0) 55%), radial-gradient(90% 50% at 100% 0%, rgba(80,170,120,0.16) 0%, rgba(80,170,120,0) 55%), radial-gradient(80% 40% at 60% 22%, rgba(120,120,220,0.14) 0%, rgba(120,120,220,0) 60%)'
    : 'radial-gradient(120% 60% at 0% 0%, #FCE4D4 0%, rgba(252,228,212,0) 55%), radial-gradient(90% 50% at 100% 0%, #DCEFE3 0%, rgba(220,239,227,0) 55%), radial-gradient(80% 40% at 60% 22%, #E7E8F8 0%, rgba(231,232,248,0) 60%)';
  return <View pointerEvents="none" aria-hidden style={{ position: 'absolute', top: 0, left: 0, right: 0, height, experimental_backgroundImage: image }}/>;
}

/** A whole-screen step (sign-in, server, no connection): the soft light on top, a column filling the screen, room for the keyboard. */
export function FlowPage({ children }: { children: ReactNode }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Wash/>
      <ScrollView contentContainerStyle={[styles.column, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 28 }]} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** A round white button with an icon, for the head of a screen. */
export function RoundButton({ icon, label, onPress, style }: { icon: IconName; label: string; onPress: () => void; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={4} onPress={onPress} style={[styles.round, style]}>
      <Icon name={icon} size={19} strokeWidth={1.7}/>
    </Pressable>
  );
}

/** The head of a step: back on the left, the title and what it is about in the middle. */
export function FlowHeader({ title, note, onBack, right }: { title: string; note?: string; onBack?: () => void; right?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.head}>
      <RoundButton icon="back" label="Назад" onPress={onBack ?? (() => router.back())}/>
      <View style={styles.headText}>
        <Text style={styles.headTitle} accessibilityRole="header" numberOfLines={1}>{title}</Text>
        {note ? <Text style={styles.headNote} numberOfLines={1}>{note}</Text> : null}
      </View>
      <View style={styles.headSide}>{right}</View>
    </View>
  );
}

/** How far a step-by-step flow has gone: one bar per step, the done and current ones dark. */
export function StepBar({ step, total }: { step: number; total: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 4 }} accessibilityLabel={`Шаг ${step} из ${total}`}>
      {Array.from({ length: total }, (_, index) => <View key={index} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: index < step ? colors.ink : colors.line }}/>)}
    </View>
  );
}

/** A text action under the buttons: «Назад», «Демо-режим». */
export function TextLink({ title, onPress, tone = 'ink', testID }: { title: string; onPress: () => void; tone?: 'ink' | 'muted' | 'accent'; testID?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" hitSlop={6} onPress={onPress} testID={testID} style={styles.link}>
      <Text style={[styles.linkText, { color: { ink: colors.ink, muted: colors.muted, accent: colors.accent }[tone] }]}>{title}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ground },
  column: { flexGrow: 1, paddingHorizontal: 20, gap: 14 },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...cardShadow(scheme) },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headText: { flex: 1, alignItems: 'center' },
  headTitle: { fontSize: 15, fontWeight: '600' },
  headNote: { fontSize: 12, color: colors.muted },
  headSide: { width: 44, alignItems: 'flex-end' },
  link: { minHeight: 44, paddingHorizontal: 8, justifyContent: 'center', alignSelf: 'center' },
  linkText: { fontSize: 14, fontWeight: '700' }
}));
