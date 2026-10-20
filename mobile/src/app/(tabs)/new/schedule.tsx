import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { DateStrip, SlotGrid } from '@/features/booking-ui';
import { useBookingDraft } from '@/lib/booking-draft';
import { addDays, dayKey, duration, money, timeOf, vehicleName } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Label, Notice, Screen } from '@/ui';

/** Step 3: a day and a free start time, then the booking is made. */
export default function ScheduleScreen() {
  const { api } = useSession();
  const session = useSignedIn();
  const timeZone = session.tenant.timezone;
  const today = dayKey(new Date(), timeZone);
  const { draft, update } = useBookingDraft();
  const [day, setDay] = useState(() => addDays(today, 1));
  const [startAt, setStartAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // One key per attempt to book: a retry after a lost answer does not book twice.
  const [idempotencyKey] = useState(() => randomUUID());
  const minutes = draft.quote?.totalDurationMinutes ?? 0;
  const availability = useResource(useCallback((signal: AbortSignal) => api.availability(day, minutes, undefined, signal), [api, day, minutes]));

  if (!draft.customer || !draft.vehicle || !draft.quote) return <Screen><Body muted>Сначала выберите услуги.</Body><Button title="Назад" onPress={() => router.back()}/></Screen>;
  const { customer, vehicle, quote } = draft;

  const book = async () => {
    setSaving(true); setError('');
    try {
      const booking = await api.createBooking({ customerId: customer.id, vehicleId: vehicle.id, channel: draft.channel, startAt, selections: draft.selections }, idempotencyKey);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      update({ booking });
      router.replace('/new/done');
    } catch (failure) {
      setError((failure as Error).message);
      setSaving(false);
      availability.reload();
    }
  };

  return (
    <Screen>
      <View>
        <Label>День</Label>
        <DateStrip from={today} days={14} value={day} onChange={(key) => { setDay(key); setStartAt(''); }} today={today}/>
      </View>
      <View style={{ gap: space.s }}>
        <Label>Свободное время · {duration(minutes)}</Label>
        {availability.error ? <Notice>{availability.error}</Notice> : <SlotGrid availability={availability.data?.date === day ? availability.data : null} value={startAt} onChange={setStartAt}/>}
      </View>
      <Card>
        <Label>Запись</Label>
        <Text style={styles.main}>{customer.name} · {vehicle.plate}</Text>
        <Text style={styles.meta}>{vehicleName(vehicle)}</Text>
        {quote.lines.filter((line) => !line.excluded).map((line) => (
          <View key={`${line.type}-${line.id}`} style={styles.line}><Text style={styles.lineName}>{line.name}</Text><Text style={styles.amount}>{money(line.amountMinor)}</Text></View>
        ))}
        <View style={[styles.line, styles.total]}><Text style={styles.lineName}>Предварительно</Text><Text style={styles.totalAmount}>{money(quote.totalAmountMinor)}</Text></View>
      </Card>
      {error ? <Notice>{error}</Notice> : null}
      <Button title={startAt ? `Записать на ${timeOf(startAt, timeZone)}` : 'Выберите время'} busy={saving} disabled={!startAt} onPress={() => void book()}/>
    </Screen>
  );
}

const styles = StyleSheet.create({
  main: { color: colors.text, fontSize: 17, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 14 },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: space.m, paddingVertical: 3 },
  lineName: { color: colors.text, fontSize: 16, flex: 1 },
  amount: { color: colors.text, fontSize: 16, fontVariant: ['tabular-nums'] },
  total: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, marginTop: 4, paddingTop: space.s },
  totalAmount: { color: colors.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] }
});
