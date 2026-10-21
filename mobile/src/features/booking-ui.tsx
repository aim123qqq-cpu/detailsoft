import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { BookingAvailability, BookingListItem } from '@df/types';
import type { Api } from '@/lib/api';
import type { DraftVehicle } from '@/lib/booking-draft';
import { addDays, bookingStatuses, dayOfMonth, duration, money, monthShort, timeOf, vehicleName, weekday } from '@/lib/format';
import { colors, radius, space } from '@/lib/theme';
import { Body, Pill } from '@/ui';

/** Two to four options side by side (list or day, phone or plate). */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (value: T) => void }) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((option) => (
        <Pressable key={option.value} accessibilityRole="tab" accessibilityState={{ selected: value === option.value }} onPress={() => onChange(option.value)}
          style={[styles.segment, value === option.value && styles.segmentSelected]}>
          <Text style={[styles.segmentText, value === option.value && styles.segmentTextSelected]}>{option.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** A row of days to pick from; `counts` adds a small number under a day (bookings that day). */
export function DateStrip({ from, days, value, onChange, today, counts }: {
  from: string; days: number; value: string; onChange: (key: string) => void; today: string; counts?: Record<string, number>;
}) {
  const keys = Array.from({ length: days }, (_, index) => addDays(from, index));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip} style={styles.bleed}>
      {keys.map((key) => {
        const selected = key === value;
        return (
          <Pressable key={key} accessibilityRole="button" accessibilityState={{ selected }} accessibilityLabel={`${dayOfMonth(key)} ${monthShort(key)}`}
            onPress={() => onChange(key)} style={[styles.day, selected && styles.daySelected]}>
            <Text style={[styles.dayWeek, selected && styles.dayInk]}>{key === today ? 'сегодня' : key === addDays(today, 1) ? 'завтра' : weekday(key)}</Text>
            <Text style={[styles.dayNumber, selected && styles.dayInk]}>{dayOfMonth(key)}</Text>
            <Text style={[styles.dayWeek, selected && styles.dayInk]}>{counts ? (counts[key] ? `${counts[key]} зап.` : '—') : monthShort(key)}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** The center's free start times for a day; taken ones are shown greyed out. */
export function SlotGrid({ availability, value, onChange }: { availability: BookingAvailability | null; value: string; onChange: (startAt: string) => void }) {
  if (!availability) return <Body muted>Проверяем график…</Body>;
  if (availability.closed) return <Body muted>В этот день центр не работает.</Body>;
  if (!availability.slots.some((slot) => slot.available)) return <Body muted>Свободного времени на этот день нет.</Body>;
  return (
    <View style={styles.slots}>
      {availability.slots.map((slot) => {
        const selected = slot.startAt === value;
        return (
          <Pressable key={slot.startAt} accessibilityRole="button" accessibilityState={{ selected, disabled: !slot.available }} disabled={!slot.available}
            onPress={() => onChange(slot.startAt)} style={[styles.slot, selected && styles.slotSelected, !slot.available && styles.slotTaken]}>
            <Text style={[styles.slotText, selected && styles.dayInk, !slot.available && styles.slotTakenText]}>{slot.time}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A booking in a list; opens its details. */
export function BookingRow({ item, timeZone }: { item: BookingListItem; timeZone: string }) {
  const status = bookingStatuses[item.status];
  const end = new Date(Date.parse(item.startAt) + item.estimatedDurationMinutes * 60_000).toISOString();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${timeOf(item.startAt, timeZone)}, ${item.customer.name}, ${item.vehicle.plate}`}
      onPress={() => router.push({ pathname: '/bookings/[id]', params: { id: item.id, item: JSON.stringify(item) } })}
      android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={styles.row}>
      <View style={styles.time}>
        <Text style={styles.timeStart}>{timeOf(item.startAt, timeZone)}</Text>
        <Text style={styles.timeEnd}>{timeOf(end, timeZone)}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.name} numberOfLines={1}>{item.customer.name}</Text>
        <Text style={styles.meta} numberOfLines={1}>{item.vehicle.plate} · {vehicleName(item.vehicle)}</Text>
        <View style={styles.rowBottom}>
          {item.slotConflict ? <Pill label="Конфликт времени" tone="warn"/> : item.pendingSync ? <Pill label="На телефоне" tone="neutral"/>
            : item.orderId ? <Pill label="Заказ открыт" tone="ok"/> : item.status !== 'CONFIRMED' ? <Pill label={status.label} tone={status.tone}/> : <Text style={styles.meta}>{duration(item.estimatedDurationMinutes)}</Text>}
          <Text style={styles.amount}>{money(item.preliminaryAmountMinor)}</Text>
        </View>
      </View>
    </Pressable>
  );
}

/** A car to book: plate, model, colour and price class. */
export function VehicleRow({ vehicle, onPress, disabled }: { vehicle: DraftVehicle; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${vehicle.plate}, ${vehicleName(vehicle)}`} disabled={disabled} onPress={onPress}
      android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={[styles.vehicle, disabled && { opacity: 0.5 }]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.plate}>{vehicle.plate}</Text>
        <Text style={styles.vehicleName}>{vehicleName(vehicle)}</Text>
        <Text style={styles.meta}>{[vehicle.color, vehicle.tenantClass].filter(Boolean).join(' · ')}</Text>
      </View>
      <Text style={styles.cta}>Записать ›</Text>
    </Pressable>
  );
}

/** Opens intake for a booking: creates its order (or gets the existing one) and goes to the inspection. */
export async function startIntake(api: Api, booking: { id: string; vehicle: { plate: string; bodyType?: string | null } }) {
  const order = await api.createOrder(booking.id);
  router.push({ pathname: '/orders/intake/[id]', params: { id: order.id, title: booking.vehicle.plate, bodyType: booking.vehicle.bodyType ?? '' } });
  return order;
}

const styles = StyleSheet.create({
  bleed: { marginHorizontal: -space.l, flexGrow: 0 },
  segmented: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.m, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 40, borderRadius: radius.s, alignItems: 'center', justifyContent: 'center' },
  segmentSelected: { backgroundColor: colors.surfaceRaised },
  segmentText: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  segmentTextSelected: { color: colors.text },
  strip: { gap: space.s, paddingHorizontal: space.l },
  day: { width: 64, paddingVertical: 10, borderRadius: radius.m, backgroundColor: colors.surface, alignItems: 'center', gap: 2 },
  daySelected: { backgroundColor: colors.primary },
  dayWeek: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  dayNumber: { color: colors.text, fontSize: 22, fontWeight: '800' },
  dayInk: { color: colors.primaryInk },
  slots: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  slot: { width: '23%', minHeight: 44, borderRadius: radius.m, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  slotSelected: { backgroundColor: colors.primary },
  slotTaken: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.line },
  slotText: { color: colors.text, fontSize: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  slotTakenText: { color: colors.soft, textDecorationLine: 'line-through' },
  row: { flexDirection: 'row', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, overflow: 'hidden' },
  time: { width: 52, alignItems: 'flex-start' },
  timeStart: { color: colors.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  timeEnd: { color: colors.soft, fontSize: 13, fontVariant: ['tabular-nums'] },
  rowBody: { flex: 1, gap: 2 },
  name: { color: colors.text, fontSize: 17, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 14 },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  amount: { color: colors.text, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  vehicle: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.surfaceRaised, borderRadius: radius.m, padding: space.m, overflow: 'hidden' },
  plate: { color: colors.primary, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  vehicleName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  cta: { color: colors.primary, fontSize: 15, fontWeight: '800' }
});
