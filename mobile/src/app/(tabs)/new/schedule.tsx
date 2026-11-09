import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { randomUUID } from 'expo-crypto';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DateStrip, SlotGrid } from '@/features/booking-ui';
import { useBookingDraft } from '@/lib/booking-draft';
import { addDays, channelLabel, dayKey, duration, money, timeOf, vehicleName } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { makeStyles, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Heading, Notice, Screen } from '@/ui';
import { FlowHeader, StepBar } from '@/ui/brand';
import { DOCK_SPACE, Dock } from '@/ui/sheet';
import { Text } from '@/ui/text';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

/** Step 4: a day and a free start time, then the booking is made. */
export default function ScheduleScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
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
    <View style={styles.root}>
      <Screen contentStyle={{ paddingTop: insets.top + 18, paddingBottom: DOCK_SPACE + insets.bottom }}>
        <FlowHeader title="Время" note="Шаг 4 из 4"/>
        <StepBar step={4} total={4}/>
        <View style={styles.monthRow}>
          <Text style={styles.month}>{MONTHS[Number(day.slice(5, 7)) - 1]}</Text>
          <Text style={styles.meta}>на 2 недели вперёд</Text>
        </View>
        <DateStrip from={today} days={14} value={day} onChange={(key) => { setDay(key); setStartAt(''); }} today={today} raised/>
        <View style={styles.sectionHead}>
          <Heading>Свободное время</Heading>
          <Text style={styles.meta}>нужно {duration(minutes)}</Text>
        </View>
        {availability.error ? <Notice>{availability.error}</Notice> : <SlotGrid availability={availability.data?.date === day ? availability.data : null} value={startAt} onChange={setStartAt} raised/>}
        <Heading style={{ marginTop: 4 }}>Запись</Heading>
        <Card>
          <View style={{ gap: 2 }}>
            <Text style={styles.main}>{customer.name} · {vehicle.plate}</Text>
            <Text style={styles.meta}>{vehicleName(vehicle)} · {channelLabel(draft.channel).toLowerCase()}</Text>
          </View>
          <View style={styles.divider}/>
          {quote.lines.filter((line) => !line.excluded).map((line) => (
            <View key={`${line.type}-${line.id}`} style={styles.line}><Text style={styles.lineName}>{line.name}</Text><Text style={styles.amount}>{money(line.amountMinor)}</Text></View>
          ))}
        </Card>
        {error ? <Notice>{error}</Notice> : null}
      </Screen>
      <Dock>
        <View style={{ flex: 1 }}>
          <Text style={styles.meta}>Предварительно</Text>
          <Text style={styles.total} numberOfLines={1} adjustsFontSizeToFit>{money(quote.totalAmountMinor)}</Text>
        </View>
        <Button title={startAt ? `Записать на ${timeOf(startAt, timeZone)}` : 'Выберите время'}
          style={{ flex: 1.2 }} busy={saving} disabled={!startAt} onPress={() => void book()}/>
      </Dock>
    </View>
  );
}

const useStyles = makeStyles((colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  monthRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: 4 },
  month: { fontSize: 26, fontWeight: '500', letterSpacing: -0.5 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  meta: { color: colors.muted, fontSize: 13 },
  main: { fontSize: 16, fontWeight: '600' },
  divider: { height: 1, backgroundColor: colors.line },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: space.m },
  lineName: { fontSize: 15, flex: 1 },
  amount: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  total: { fontSize: 24, fontWeight: '500', letterSpacing: -0.5, fontVariant: ['tabular-nums'] }
}));
