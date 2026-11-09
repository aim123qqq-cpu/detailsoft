import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBookingDraft } from '@/lib/booking-draft';
import { addDays, channelLabel, dayKey, duration, longDay, money, timeOf, vehicleName } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { makeStyles, radius, space } from '@/lib/theme';
import { Body, Button, Card, Notice, Screen } from '@/ui';
import { RoundButton } from '@/ui/brand';
import { Plate } from '@/ui/plate';
import { ButtonPair } from '@/ui/sheet';
import { Text } from '@/ui/text';

/** The booking is made: its time and what next (intake now, another booking, the schedule). */
export default function DoneScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const session = useSignedIn();
  const timeZone = session.tenant.timezone;
  const { draft, reset } = useBookingDraft();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { booking, customer, vehicle } = draft;

  const again = () => { reset({ channel: draft.channel }); router.dismissTo('/new'); };
  const toSchedule = () => { reset({ channel: draft.channel }); router.dismissTo('/new'); router.navigate('/bookings'); };
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

  const today = dayKey(new Date(), timeZone);
  const day = dayKey(booking.startAt, timeZone);
  const when = day === today ? 'Сегодня' : day === addDays(today, 1) ? 'Завтра' : longDay(day).split(', ')[1];
  const end = new Date(Date.parse(booking.startAt) + booking.estimatedDurationMinutes * 60_000).toISOString();
  const services = booking.lines.filter((line) => !line.excluded).map((line) => line.name).join(', ');

  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18 }}>
      <View style={styles.top}><RoundButton icon="close" label="Закрыть" onPress={again}/></View>
      <View style={styles.titleBlock}>
        <Text style={styles.kicker}>{booking.pendingSync ? 'Запись сохранена на телефоне' : 'Запись подтверждена'}</Text>
        <Text style={styles.h1} accessibilityRole="header">{when}{'\n'}в {timeOf(booking.startAt, timeZone)}</Text>
        <Text style={styles.meta}>{longDay(day)} · до {timeOf(end, timeZone)}</Text>
      </View>
      <View style={styles.dark}>
        <Plate plate={vehicle.plate}/>
        <Text style={styles.darkTitle} numberOfLines={1}>{vehicleName(vehicle)}</Text>
        <Text style={styles.darkNote} numberOfLines={1}>{customer.name} · {customer.phoneDisplay}</Text>
      </View>
      <Card style={{ gap: 6 }}>
        {services ? <Row label="Услуги" value={services}/> : null}
        <Row label="Канал" value={channelLabel(booking.channel)}/>
        <Row label="Длительность" value={duration(booking.estimatedDurationMinutes)}/>
        <View style={styles.divider}/>
        <Row label="Предварительно" value={money(booking.preliminaryAmountMinor)}/>
      </Card>
      <Body muted style={{ fontSize: 13, paddingHorizontal: 4 }}>{booking.pendingSync
        ? 'Нет связи с сервером. Запись отправится сама, когда связь появится. Если это время за это время займут, запись сохранится с пометкой «конфликт времени».'
        : 'Запись уже в расписании центра'}</Body>
      {error ? <Notice>{error}</Notice> : null}
      <View style={styles.actions}>
        {session.capabilities.manageIntake ? <Button title="Клиент на месте — начать приёмку" busy={busy} onPress={() => void intake()}/> : null}
        <ButtonPair>
          <Button title="Новая запись" tone="secondary" style={{ flex: 1 }} onPress={again}/>
          <Button title="К расписанию" tone="secondary" style={{ flex: 1 }} onPress={toSchedule}/>
        </ButtonPair>
      </View>
    </Screen>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return <View style={styles.row}><Text style={styles.label}>{label}</Text><Text style={styles.value}>{value}</Text></View>;
}

const useStyles = makeStyles((colors) => StyleSheet.create({
  top: { flexDirection: 'row', justifyContent: 'flex-end' },
  titleBlock: { gap: 4, paddingHorizontal: 4, paddingTop: 8 },
  kicker: { color: colors.okText, fontSize: 14, fontWeight: '700' },
  h1: { fontSize: 40, lineHeight: 44, fontWeight: '500', letterSpacing: -1.4 },
  meta: { color: colors.muted, fontSize: 14 },
  dark: { borderRadius: radius.l, backgroundColor: colors.darkCard, padding: space.l, gap: 6 },
  darkTitle: { color: colors.darkCardInk, fontSize: 18, fontWeight: '600', marginTop: 4 },
  darkNote: { color: colors.darkCardInk, fontSize: 13, opacity: 0.7 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.m },
  label: { color: colors.muted, fontSize: 14 },
  value: { fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  actions: { gap: space.s, marginTop: 6 }
}));
