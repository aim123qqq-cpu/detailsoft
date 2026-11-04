import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { colors, radius, space } from '@/lib/theme';

const ROW = 40;
const VISIBLE = 5;
const MAX_MINUTES = 1440;

/** One drum of the wheel: scrolls and snaps to a row; a tap on a row works too. */
function Drum({ label, options, value, unit, onChange }: { label: string; options: number[]; value: number; unit: string; onChange: (value: number) => void }) {
  const list = useRef<ComponentRef<typeof ScrollView>>(null);
  const index = Math.max(0, options.indexOf(value));
  const [start] = useState({ x: 0, y: index * ROW });
  const afterDrag = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { list.current?.scrollTo({ y: index * ROW, animated: true }); }, [index]);
  useEffect(() => () => clearTimeout(afterDrag.current), []);
  const pick = (offset: number) => {
    const next = options[Math.min(options.length - 1, Math.max(0, Math.round(offset / ROW)))];
    if (next !== value) onChange(next);
  };
  const settle = (event: NativeSyntheticEvent<NativeScrollEvent>) => pick(event.nativeEvent.contentOffset.y);
  // When the finger lifts the drum may still be gliding: a row counts only where it stops.
  const lifted = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = event.nativeEvent.contentOffset.y;
    clearTimeout(afterDrag.current);
    afterDrag.current = setTimeout(() => pick(offset), 150);
  };
  return (
    <ScrollView ref={list} style={styles.drum} accessibilityLabel={label} nestedScrollEnabled showsVerticalScrollIndicator={false} snapToInterval={ROW} decelerationRate="fast"
      contentOffset={start} contentContainerStyle={styles.drumContent} onScrollEndDrag={lifted} onMomentumScrollBegin={() => clearTimeout(afterDrag.current)} onMomentumScrollEnd={settle}>
      {options.map((option) => (
        <Pressable key={option} accessibilityRole="button" accessibilityState={{ selected: option === value }} onPress={() => onChange(option)} style={styles.row}>
          <Text style={[styles.rowText, option === value && styles.rowSelected]}>{option} {unit}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export const durationText = (minutes: number) => [Math.floor(minutes / 60) && `${Math.floor(minutes / 60)} ч`, minutes % 60 && `${minutes % 60} мин`].filter(Boolean).join(' ') || '0 мин';

/** The time of a service as on an alarm clock: hours and minutes on two drums, nothing to mistype. */
export function DurationWheel({ minutes, onChange }: { minutes: number; onChange: (minutes: number) => void }) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  // Every 5 minutes, plus an exact value a service already has.
  const [minuteOptions] = useState(() => [...new Set([...Array.from({ length: 12 }, (_, at) => at * 5), rest])].sort((left, right) => left - right));
  const set = (nextHours: number, nextMinutes: number) => onChange(Math.min(MAX_MINUTES, nextHours * 60 + nextMinutes));
  return (
    <View style={styles.wheel}>
      <View style={styles.band} pointerEvents="none"/>
      <Drum label="Часы" unit="ч" options={Array.from({ length: 25 }, (_, at) => at)} value={hours} onChange={(value) => set(value, rest)}/>
      <Drum label="Минуты" unit="мин" options={minuteOptions} value={rest} onChange={(value) => set(hours, value)}/>
    </View>
  );
}

const styles = StyleSheet.create({
  wheel: { flexDirection: 'row', gap: space.xs, height: ROW * VISIBLE, paddingHorizontal: space.s, borderRadius: radius.m, backgroundColor: colors.surface, overflow: 'hidden' },
  band: { position: 'absolute', left: space.s, right: space.s, top: ROW * 2, height: ROW, borderRadius: radius.s, backgroundColor: 'rgba(255,121,57,.13)' },
  drum: { flex: 1 },
  drumContent: { paddingVertical: ROW * 2 },
  row: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  rowText: { color: colors.muted, fontSize: 18, fontWeight: '600' },
  rowSelected: { color: colors.text, fontWeight: '800' }
});
