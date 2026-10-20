import { useCallback, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { BookingListItem } from '@df/types';
import { DateStrip, SlotGrid, startIntake } from '@/features/booking-ui';
import { bookingStatuses, channelLabel, dayKey, dayTitle, duration, money, timeOf, vehicleName } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Label, Notice, Pill, Screen } from '@/ui';

/** One booking: who and what, then arrival (intake), moving, cancelling or a no-show. */
export default function BookingScreen() {
  const params = useLocalSearchParams<{ id: string; item: string }>();
  const { api } = useSession();
  const session = useSignedIn();
  const timeZone = session.tenant.timezone;
  const today = dayKey(new Date(), timeZone);
  const [item, setItem] = useState<BookingListItem>(() => JSON.parse(params.item));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [moving, setMoving] = useState(false);
  const [moveDay, setMoveDay] = useState(() => dayKey(item.startAt, timeZone) < today ? today : dayKey(item.startAt, timeZone));
  const [moveTo, setMoveTo] = useState('');
  // A no-show can be marked once the visit time has passed (as of opening the screen).
  const [openedAt] = useState(() => Date.now());

  const { data: booking } = useResource(useCallback((signal: AbortSignal) => api.getBooking(item.id, signal), [api, item.id]));
  const availability = useResource(useCallback((signal: AbortSignal) => moving
    ? api.availability(moveDay, item.estimatedDurationMinutes, item.id, signal) : Promise.resolve(null), [api, moving, moveDay, item.id, item.estimatedDurationMinutes]));

  const canManage = session.capabilities.manageBookings;
  const locked = Boolean(item.orderId) || item.status !== 'CONFIRMED';
  const status = bookingStatuses[item.status];
  const started = Date.parse(item.startAt) <= openedAt;

  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError('');
    try { await action(); }
    catch (failure) { setError((failure as Error).message); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); }
    finally { setBusy(null); }
  };
  const change = (key: string, input: { startAt: string } | { status: 'CANCELLED' | 'NO_SHOW' }) => act(key, async () => {
    const updated = await api.updateBooking(item.id, input);
    setItem((current) => ({ ...current, startAt: updated.startAt, status: updated.status }));
    setMoving(false); setMoveTo('');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  });
  const arrive = () => act('arrive', async () => {
    const order = await startIntake(api, item);
    setItem((current) => ({ ...current, orderId: order.id }));
  });

  return (
    <Screen>
      <Stack.Screen options={{ title: `${dayTitle(dayKey(item.startAt, timeZone), today)}, ${timeOf(item.startAt, timeZone)}` }}/>
      <Card>
        <View style={styles.row}><Pill label={item.orderId ? 'Заказ открыт' : status.label} tone={item.orderId ? 'ok' : status.tone}/><Text style={styles.meta}>{channelLabel(item.channel)}</Text></View>
        <Text style={styles.name}>{item.customer.name}</Text>
        <Pressable accessibilityRole="link" onPress={() => Linking.openURL(`tel:${item.customer.phoneDisplay.replace(/[^\d+]/g, '')}`)}>
          <Text style={styles.phone}>{item.customer.phoneDisplay}</Text>
        </Pressable>
        {session.capabilities.manageCustomers ? <Button title="Карточка клиента" tone="quiet" style={styles.link}
          onPress={() => router.push({ pathname: '/customer/[id]', params: { id: item.customer.id } })}/> : null}
      </Card>

      <Card>
        <Text style={styles.plate}>{item.vehicle.plate}</Text>
        <Text style={styles.vehicle}>{vehicleName(item.vehicle)}</Text>
        <Text style={styles.meta}>{item.vehicle.color}</Text>
      </Card>

      <View style={styles.grid}>
        <Fact label="Начало" value={timeOf(item.startAt, timeZone)}/>
        <Fact label="Длительность" value={duration(item.estimatedDurationMinutes)}/>
        <Fact label="Предварительно" value={money(item.preliminaryAmountMinor)}/>
      </View>

      {booking?.lines.length ? <Card>
        <Label>Состав записи</Label>
        {booking.lines.map((line) => (
          <View key={`${line.type}-${line.id}`} style={styles.line}>
            <Text style={[styles.lineName, line.excluded && styles.excluded]}>{line.name}</Text>
            <Text style={styles.lineAmount}>{line.excluded ? 'в комплексе' : money(line.amountMinor)}</Text>
          </View>
        ))}
      </Card> : null}

      {error ? <Notice>{error}</Notice> : null}

      {item.orderId ? <>
        <Button title="Открыть заказ" onPress={() => router.navigate({ pathname: '/orders/[id]', params: { id: item.orderId!, title: item.vehicle.plate, bodyType: item.vehicle.bodyType ?? '', subtitle: `${vehicleName(item.vehicle)} · ${item.customer.name}` } })}/>
        <Body muted>По записи уже создан заказ: время и состав зафиксированы, дальше изменения идут через смету.</Body>
      </> : null}

      {!locked && !moving ? <View style={styles.actions}>
        {session.capabilities.manageIntake ? <Button title="Клиент приехал — начать приёмку" busy={busy === 'arrive'} onPress={() => void arrive()}/> : null}
        {canManage ? <Button title="Перенести" tone="secondary" onPress={() => { setMoving(true); setError(''); }}/> : null}
        {canManage && started ? <Button title="Клиент не приехал" tone="secondary" busy={busy === 'noshow'} onPress={() => Alert.alert('Отметить неявку?', 'Время освободится, запись останется в истории клиента.', [
          { text: 'Назад', style: 'cancel' }, { text: 'Не приехал', style: 'destructive', onPress: () => void change('noshow', { status: 'NO_SHOW' }) }
        ])}/> : null}
        {canManage ? <Button title="Отменить запись" tone="dangerQuiet" busy={busy === 'cancel'} onPress={() => Alert.alert('Отменить запись?', 'Время освободится для других клиентов.', [
          { text: 'Назад', style: 'cancel' }, { text: 'Отменить запись', style: 'destructive', onPress: () => void change('cancel', { status: 'CANCELLED' }) }
        ])}/> : null}
      </View> : null}

      {moving ? <View style={styles.actions}>
        <Label>Новое время</Label>
        <DateStrip from={today} days={14} value={moveDay} onChange={(key) => { setMoveDay(key); setMoveTo(''); }} today={today}/>
        {availability.error ? <Notice>{availability.error}</Notice> : <SlotGrid availability={availability.data} value={moveTo} onChange={setMoveTo}/>}
        <Button title="Перенести запись" busy={busy === 'move'} disabled={!moveTo} onPress={() => void change('move', { startAt: moveTo })}/>
        <Button title="Не переносить" tone="quiet" onPress={() => { setMoving(false); setMoveTo(''); }}/>
      </View> : null}
    </Screen>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <View style={styles.fact}><Text style={styles.factLabel}>{label}</Text><Text style={styles.factValue}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: space.s },
  phone: { color: colors.primary, fontSize: 17, fontWeight: '700' },
  link: { alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: 0 },
  plate: { color: colors.primary, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
  vehicle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 14 },
  grid: { flexDirection: 'row', gap: space.s },
  fact: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m, gap: 2 },
  factLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  factValue: { color: colors.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: space.m, paddingVertical: 3 },
  lineName: { color: colors.text, fontSize: 16, flex: 1 },
  excluded: { color: colors.muted },
  lineAmount: { color: colors.text, fontSize: 16, fontVariant: ['tabular-nums'] },
  actions: { gap: space.s }
});
