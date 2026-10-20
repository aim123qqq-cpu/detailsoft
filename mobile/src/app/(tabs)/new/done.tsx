import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useBookingDraft } from '@/lib/booking-draft';
import { channelLabel, dayKey, dayTitle, duration, money, timeOf, vehicleName } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, space } from '@/lib/theme';
import { Body, Button, Card, Notice, Screen } from '@/ui';

/** The booking is made: its time and what next (intake now, another booking, the schedule). */
export default function DoneScreen() {
  const { api } = useSession();
  const session = useSignedIn();
  const timeZone = session.tenant.timezone;
  const { draft, reset } = useBookingDraft();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { booking, customer, vehicle } = draft;

  const again = () => { reset({ channel: draft.channel }); router.dismissTo('/new'); };
  if (!booking || !customer || !vehicle) return <Screen><Button title="Новая запись" onPress={again}/></Screen>;

  const intake = async () => {
    setBusy(true); setError('');
    try {
      const order = await api.createOrder(booking.id);
      // The new-booking tab starts over; intake opens on the orders tab.
      reset({ channel: draft.channel });
      router.dismissTo('/new');
      router.push({ pathname: '/orders/intake/[id]', params: { id: order.id, title: vehicle.plate, bodyType: vehicle.bodyType ?? '' } });
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.mark}><Text style={styles.markText}>✓</Text></View>
        <Text style={styles.kicker}>Запись подтверждена</Text>
        <Text style={styles.when}>{dayTitle(dayKey(booking.startAt, timeZone), dayKey(new Date(), timeZone))}, {timeOf(booking.startAt, timeZone)}</Text>
      </View>
      <Card>
        <Row label="Клиент" value={customer.name}/>
        <Row label="Автомобиль" value={`${vehicle.plate} · ${vehicleName(vehicle)}`}/>
        <Row label="Канал" value={channelLabel(booking.channel)}/>
        <Row label="Длительность" value={duration(booking.estimatedDurationMinutes)}/>
        <Row label="Предварительно" value={money(booking.preliminaryAmountMinor)}/>
      </Card>
      <Body muted>Запись уже в расписании центра.</Body>
      {error ? <Notice>{error}</Notice> : null}
      {session.capabilities.manageIntake ? <Button title="Клиент на месте — начать приёмку" busy={busy} onPress={() => void intake()}/> : null}
      <Button title="Новая запись" tone="secondary" onPress={again}/>
      <Button title="К расписанию" tone="quiet" onPress={() => { reset({ channel: draft.channel }); router.dismissTo('/new'); router.navigate('/bookings'); }}/>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <View style={styles.row}><Text style={styles.label}>{label}</Text><Text style={styles.value}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space.s, paddingVertical: space.l },
  mark: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.ok, alignItems: 'center', justifyContent: 'center' },
  markText: { color: colors.okInk, fontSize: 32, fontWeight: '900' },
  kicker: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  when: { color: colors.text, fontSize: 26, fontWeight: '800', textAlign: 'center' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.m, paddingVertical: 4 },
  label: { color: colors.muted, fontSize: 15 },
  value: { color: colors.text, fontSize: 15, fontWeight: '700', flexShrink: 1, textAlign: 'right' }
});
