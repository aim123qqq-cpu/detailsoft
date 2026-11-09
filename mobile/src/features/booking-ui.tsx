import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import type { BookingAvailability, BookingListItem } from '@df/types';
import type { Api } from '@/lib/api';
import type { DraftVehicle } from '@/lib/booking-draft';
import { addDays, bookingStatuses, dayOfMonth, money, monthShort, timeOf, vehicleName, weekday } from '@/lib/format';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { Body, Pill } from '@/ui';
import { Icon } from '@/ui/icons';
import { Plate } from '@/ui/plate';
import { Text } from '@/ui/text';

/** Two or three options side by side (list or day, phone or plate): a soft track, the chosen one white. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  const styles = useStyles();
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((option) => (
        <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected: value === option.value }} onPress={() => onChange(option.value)}
          style={[styles.segment, value === option.value && styles.segmentSelected]}>
          <Text style={[styles.segmentText, value === option.value && styles.segmentTextSelected]} numberOfLines={1}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A row of days to pick from (moving a booking, a new one); the chosen day is black. */
export function DateStrip({ from, days, value, onChange, today, counts }: {
  from: string; days: number; value: string; onChange: (key: string) => void; today: string; counts?: Record<string, number>;
}) {
  const styles = useStyles();
  const keys = Array.from({ length: days }, (_, index) => addDays(from, index));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip} style={styles.bleed}>
      {keys.map((key) => {
        const selected = key === value;
        return (
          <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${weekday(key)}, ${dayOfMonth(key)} ${monthShort(key)}`}
            onPress={() => onChange(key)} style={[styles.day, selected && styles.daySelected]}>
            <Text style={[styles.dayWeek, selected && styles.dayInk]}>{key === today ? 'сег' : weekday(key)}</Text>
            <Text style={[styles.dayNumber, selected && styles.dayInk]}>{dayOfMonth(key)}</Text>
            {counts ? <Text style={[styles.dayWeek, selected && styles.dayInk]}>{counts[key] ? `${counts[key]} зап.` : '—'}</Text> : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A week of seven days in one row, with a dot for each booking (up to four); arrows move by a week. */
export function WeekStrip({ from, value, onChange, today, counts, onShift }: {
  from: string; value: string; onChange: (key: string) => void; today: string; counts: Record<string, number>; onShift: (days: number) => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const keys = Array.from({ length: 7 }, (_, index) => addDays(from, index));
  return (
    <View style={{ gap: space.s }}>
      <View style={styles.weekBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Предыдущая неделя" hitSlop={6} onPress={() => onShift(-7)} style={styles.weekArrow}><Icon name="back" size={20}/></Pressable>
        <Text style={styles.weekTitle}>{dayOfMonth(keys[0])} {monthShort(keys[0])} – {dayOfMonth(keys[6])} {monthShort(keys[6])}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Следующая неделя" hitSlop={6} onPress={() => onShift(7)} style={styles.weekArrow}><Icon name="chevronRight" size={20}/></Pressable>
      </View>
      <View style={styles.week}>
        {keys.map((key) => {
          const selected = key === value;
          const count = counts[key] ?? 0;
          return (
            <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${weekday(key)}, ${dayOfMonth(key)} ${monthShort(key)}, записей: ${count}`}
              onPress={() => onChange(key)} style={[styles.weekDay, selected && styles.daySelected]}>
              <Text style={[styles.weekDayName, selected && styles.dayInk, key === today && !selected && { color: colors.accent, opacity: 1 }]}>{weekday(key)}</Text>
              <Text style={[styles.weekDayNumber, selected && styles.dayInk]}>{dayOfMonth(key)}</Text>
              <View style={styles.dots}>
                {Array.from({ length: Math.min(4, count) }, (_, index) => <View key={index} style={[styles.dot, { backgroundColor: selected ? colors.pillInk : colors.accent }]}/>)}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** The center's free start times for a day; taken ones are struck through. */
export function SlotGrid({ availability, value, onChange }: { availability: BookingAvailability | null; value: string; onChange: (startAt: string) => void }) {
  const styles = useStyles();
  if (!availability) return <Body muted>Проверяем график…</Body>;
  if (availability.closed) return <Body muted>В этот день центр не работает.</Body>;
  if (!availability.slots.some((slot) => slot.available)) return <Body muted>Свободного времени на этот день нет.</Body>;
  return (
    <View style={styles.slots}>
      {availability.slots.map((slot) => {
        const selected = slot.startAt === value;
        return (
          <Pressable key={slot.startAt} accessibilityRole="button" accessibilityState={{ selected, disabled: !slot.available }} disabled={!slot.available}
            onPress={() => onChange(slot.startAt)} style={[styles.slot, selected && styles.daySelected]}>
            <Text style={[styles.slotText, selected && styles.dayInk, !slot.available && styles.slotTakenText]}>{slot.time}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const openBooking = (item: BookingListItem) => router.push({ pathname: '/bookings/[id]', params: { id: item.id, item: JSON.stringify(item) } });

/** The status chip of a booking in a list: a time conflict and an unsent booking first. */
export function BookingStatus({ item }: { item: BookingListItem }) {
  const status = bookingStatuses[item.status];
  if (item.slotConflict) return <Pill label="Конфликт времени" tone="attention"/>;
  if (item.pendingSync) return <Pill label="На телефоне" tone="past"/>;
  if (item.orderId) return <Pill label="Заказ открыт" tone="work"/>;
  return <Pill label={status.label} tone={status.tone}/>;
}

/** A booking in a list: its time beside the card; who, which car, what and for how much. */
export function BookingRow({ item, timeZone }: { item: BookingListItem; timeZone: string }) {
  const styles = useStyles();
  const end = new Date(Date.parse(item.startAt) + item.estimatedDurationMinutes * 60_000).toISOString();
  const what = [item.services?.length ? item.services.join(', ') : null, money(item.preliminaryAmountMinor)].filter(Boolean).join(' · ');
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${timeOf(item.startAt, timeZone)}, ${item.customer.name}, ${item.vehicle.plate}`}
      onPress={() => openBooking(item)} style={styles.row}>
      <View style={styles.time}>
        <Text style={styles.timeStart}>{timeOf(item.startAt, timeZone)}</Text>
        <Text style={styles.timeEnd}>{timeOf(end, timeZone)}</Text>
      </View>
      <View style={styles.rowCard}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>{item.customer.name}</Text>
          <BookingStatus item={item}/>
        </View>
        <Text style={styles.meta} numberOfLines={1}>{vehicleName(item.vehicle)} · {item.vehicle.plate}</Text>
        <Text style={styles.what} numberOfLines={2}>{what}</Text>
        {item.slotConflict ? <Text style={styles.warning}>Время заняли, пока не было связи. Перенесите.</Text>
          : item.pendingSync ? <Text style={styles.metaSmall}>Отправится, когда появится связь</Text> : null}
      </View>
    </Pressable>
  );
}

const HOUR = 62;
/** One day as a timeline: hour lines, the bookings as blocks (side by side when they overlap), a line for now. */
export function DayTimeline({ items, timeZone, isToday }: { items: BookingListItem[]; timeZone: string; isToday: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const minutesOf = (iso: string) => { const [h, m] = timeOf(iso, timeZone).split(':').map(Number); return h * 60 + m; };
  const blocks = items.filter((item) => item.status !== 'CANCELLED').map((item) => {
    const start = minutesOf(item.startAt);
    return { item, start, end: start + Math.max(15, item.estimatedDurationMinutes), column: 0, columns: 1 };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  // Overlapping bookings share the width: each group of overlaps gets as many columns as it needs.
  let group: typeof blocks = [];
  let groupEnd = -1;
  const close = () => { const count = Math.max(1, ...group.map((block) => block.column + 1)); for (const block of group) block.columns = count; group = []; };
  for (const block of blocks) {
    if (block.start >= groupEnd) { close(); groupEnd = -1; }
    const taken = new Set(group.filter((other) => other.end > block.start).map((other) => other.column));
    while (taken.has(block.column)) block.column += 1;
    group.push(block);
    groupEnd = Math.max(groupEnd, block.end);
  }
  close();
  const first = Math.min(9, ...blocks.map((block) => Math.floor(block.start / 60)));
  const last = Math.max(19, ...blocks.map((block) => Math.ceil(block.end / 60)));
  const hours = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  // Every position 8 px down, so the first hour label is not cut off.
  const top = (minutes: number) => (minutes / 60 - first) * HOUR + 8;
  const tints = [colors.tilePeach, colors.tileSky, colors.tileSage];
  const now = minutesOf(new Date().toISOString());
  const lane = Math.max(0, width - 52);
  return (
    <View style={[styles.timeline, { height: (last - first) * HOUR + 20 }]} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {hours.map((hour) => (
        <View key={hour} style={[styles.hourRow, { top: (hour - first) * HOUR }]} pointerEvents="none">
          <Text style={styles.hourLabel}>{hour}:00</Text>
          <View style={styles.hourLine}/>
        </View>
      ))}
      {blocks.map((block, index) => {
        const height = Math.max(34, top(block.end) - top(block.start) - 4);
        const columnWidth = lane / block.columns;
        return (
          <Pressable key={block.item.id} accessibilityRole="button" accessibilityLabel={`${timeOf(block.item.startAt, timeZone)}, ${block.item.customer.name}`}
            onPress={() => openBooking(block.item)}
            style={[styles.block, { top: top(block.start) + 2, height, left: 52 + block.column * columnWidth, width: columnWidth - 4, backgroundColor: block.item.slotConflict ? colors.pill : tints[index % tints.length] }]}>
            <Text style={[styles.blockTitle, block.item.slotConflict && { color: colors.pillInk }]} numberOfLines={1}>{timeOf(block.item.startAt, timeZone)} · {block.item.customer.name}</Text>
            {height > 44 ? <Text style={[styles.blockNote, block.item.slotConflict && { color: colors.pillInk }]} numberOfLines={Math.max(1, Math.floor((height - 30) / 16))}>
              {[block.item.vehicle.model, block.item.services?.join(', '), money(block.item.preliminaryAmountMinor)].filter(Boolean).join(' · ')}
            </Text> : null}
          </Pressable>
        );
      })}
      {isToday && now >= first * 60 && now <= last * 60 ? <>
        <View pointerEvents="none" style={[styles.nowLine, { top: top(now) }]}/>
        <View pointerEvents="none" style={[styles.nowDot, { top: top(now) - 4 }]}/>
      </> : null}
    </View>
  );
}

/** A car to book: plate, model, colour and price class. */
export function VehicleRow({ vehicle, onPress, disabled }: { vehicle: DraftVehicle; onPress: () => void; disabled?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${vehicle.plate}, ${vehicleName(vehicle)}`} disabled={disabled} onPress={onPress}
      android_ripple={{ color: 'rgba(127,127,127,.12)' }} style={[styles.vehicle, disabled && { opacity: 0.5 }]}>
      <View style={{ flex: 1, gap: 4 }}>
        <Plate plate={vehicle.plate}/>
        <Text style={styles.vehicleName}>{vehicleName(vehicle)}</Text>
        <Text style={styles.meta}>{[vehicle.color, vehicle.tenantClass].filter(Boolean).join(' · ')}</Text>
      </View>
      <Text style={styles.cta}>Записать</Text>
      <Icon name="chevronRight" size={18} color={colors.muted}/>
    </Pressable>
  );
}

/** Opens intake for a booking: creates its order (or gets the existing one) and goes to the inspection. */
export async function startIntake(api: Api, booking: { id: string; vehicle: { plate: string; bodyType?: string | null } }) {
  const order = await api.createOrder(booking.id);
  router.push({ pathname: '/orders/intake/[id]', params: { id: order.id, title: booking.vehicle.plate, bodyType: booking.vehicle.bodyType ?? '' } });
  return order;
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  bleed: { marginHorizontal: -space.l, flexGrow: 0 },
  segmented: { flexDirection: 'row', backgroundColor: colors.soft, borderRadius: 24, padding: 4 },
  segment: { flex: 1, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  segmentSelected: { backgroundColor: colors.surface, ...cardShadow(scheme) },
  segmentText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  segmentTextSelected: { color: colors.ink },
  strip: { gap: space.s, paddingHorizontal: space.l },
  day: { width: 54, minHeight: 66, paddingVertical: 8, borderRadius: 18, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center', gap: 2 },
  daySelected: { backgroundColor: colors.pill },
  dayWeek: { fontSize: 11, opacity: 0.7 },
  dayNumber: { fontSize: 18, fontWeight: '600' },
  dayInk: { color: colors.pillInk, opacity: 1 },
  weekBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  weekArrow: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  weekTitle: { fontSize: 14, fontWeight: '600' },
  week: { flexDirection: 'row', gap: 4 },
  weekDay: { flex: 1, height: 74, borderRadius: 18, alignItems: 'center', justifyContent: 'center', gap: 3 },
  weekDayName: { fontSize: 11, opacity: 0.6 },
  weekDayNumber: { fontSize: 18, fontWeight: '600' },
  dots: { flexDirection: 'row', gap: 2, height: 4 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  slots: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  slot: { width: '23%', height: 44, borderRadius: 15, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  slotText: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  slotTakenText: { color: colors.muted, textDecorationLine: 'line-through', fontWeight: '400' },
  row: { flexDirection: 'row', gap: space.m },
  time: { width: 48, paddingTop: space.l },
  timeStart: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  timeEnd: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  rowCard: { flex: 1, minWidth: 0, borderRadius: 22, backgroundColor: colors.surface, paddingVertical: 14, paddingHorizontal: space.l, gap: 6, ...cardShadow(scheme) },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.s },
  name: { flex: 1, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 13 },
  metaSmall: { color: colors.muted, fontSize: 12 },
  what: { fontSize: 13 },
  warning: { color: colors.warnText, fontSize: 12, fontWeight: '600' },
  timeline: { position: 'relative', marginTop: space.s },
  hourRow: { position: 'absolute', left: 0, right: 0, height: 16, flexDirection: 'row', alignItems: 'center' },
  hourLabel: { width: 52, fontSize: 12, color: colors.muted },
  hourLine: { flex: 1, height: 1, backgroundColor: colors.line },
  block: { position: 'absolute', borderRadius: 18, paddingVertical: 8, paddingHorizontal: 12, overflow: 'hidden', gap: 2 },
  blockTitle: { color: colors.tileInk, fontSize: 13, fontWeight: '600' },
  blockNote: { color: colors.tileInk, fontSize: 12, opacity: 0.75 },
  nowLine: { position: 'absolute', left: 44, right: 0, height: 2, backgroundColor: colors.accent },
  nowDot: { position: 'absolute', left: 40, width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
  vehicle: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.soft, borderRadius: radius.m, padding: 14, overflow: 'hidden' },
  vehicleName: { fontSize: 15, fontWeight: '600' },
  cta: { fontSize: 14, fontWeight: '700' }
}));
