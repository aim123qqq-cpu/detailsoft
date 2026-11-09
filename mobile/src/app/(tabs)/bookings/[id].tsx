import { useCallback, useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BookingListItem } from '@df/types';
import { BookingStatus, DateStrip, SlotGrid, startIntake } from '@/features/booking-ui';
import { addDays, bodyName, channelLabel, dayKey, dayOfMonth, duration, longDay, money, monthShort, timeOf, vehicleName, weekday } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Heading, Notice, Screen } from '@/ui';
import { RoundButton } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Plate } from '@/ui/plate';
import { ButtonPair, Sheet } from '@/ui/sheet';
import { Text } from '@/ui/text';

/** One booking: who and what, then arrival (intake), moving, cancelling or a no-show. */
export default function BookingScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; item: string }>();
  const { api } = useSession();
  const session = useSignedIn();
  const timeZone = session.tenant.timezone;
  const today = dayKey(new Date(), timeZone);
  const [item, setItem] = useState<BookingListItem>(() => JSON.parse(params.item));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<'move' | 'noshow' | 'cancel' | null>(null);
  const [moveDay, setMoveDay] = useState(() => dayKey(item.startAt, timeZone) < today ? today : dayKey(item.startAt, timeZone));
  const [moveTo, setMoveTo] = useState('');
  // A no-show can be marked once the visit time has passed (as of opening the screen).
  const [openedAt] = useState(() => Date.now());

  const { data: booking } = useResource(useCallback((signal: AbortSignal) => api.getBooking(item.id, signal), [api, item.id]));
  const moving = sheet === 'move';
  const availability = useResource(useCallback((signal: AbortSignal) => moving
    ? api.availability(moveDay, item.estimatedDurationMinutes, item.id, signal) : Promise.resolve(null), [api, moving, moveDay, item.id, item.estimatedDurationMinutes]));

  const canManage = session.capabilities.manageBookings;
  const locked = Boolean(item.orderId) || item.status !== 'CONFIRMED';
  const started = Date.parse(item.startAt) <= openedAt;
  const day = dayKey(item.startAt, timeZone);
  const when = day === today ? 'Сегодня' : day === addDays(today, 1) ? 'Завтра' : `${dayOfMonth(day)} ${monthShort(day)}.`;
  const shortWhen = (iso: string) => { const key = dayKey(iso, timeZone); return `${weekday(key)}, ${dayOfMonth(key)} ${monthShort(key)}., ${timeOf(iso, timeZone)}`; };

  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key); setError('');
    try { await action(); }
    catch (failure) { setError((failure as Error).message); setSheet(null); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); }
    finally { setBusy(null); }
  };
  const change = (key: string, input: { startAt: string } | { status: 'CANCELLED' | 'NO_SHOW' }) => act(key, async () => {
    const updated = await api.updateBooking(item.id, input);
    setItem((current) => ({ ...current, startAt: updated.startAt, status: updated.status, pendingSync: updated.pendingSync, slotConflict: updated.slotConflict ?? false }));
    setSheet(null); setMoveTo('');
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  });
  const arrive = () => act('arrive', async () => {
    const order = await startIntake(api, item);
    setItem((current) => ({ ...current, orderId: order.id }));
  });
  const vehicleNote = [bodyName(item.vehicle.bodyType), item.vehicle.color].filter(Boolean).join(' · ');

  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18 }}>
      <View style={styles.top}><RoundButton icon="back" label="Назад" onPress={() => router.back()}/></View>
      <View style={styles.titleBlock}>
        <BookingStatus item={item}/>
        <Text style={styles.h1} accessibilityRole="header">{when} в {timeOf(item.startAt, timeZone)}</Text>
        <Text style={styles.meta}>{longDay(day).replace(/^(\S+),/, (_, name: string) => `${name.slice(0, 2)},`)} · {channelLabel(item.channel).toLowerCase()}</Text>
      </View>

      <Card>
        <View style={styles.person}>
          <Pressable accessibilityRole={session.capabilities.manageCustomers ? 'button' : undefined} disabled={!session.capabilities.manageCustomers} style={{ flex: 1, gap: 2 }}
            onPress={() => router.push({ pathname: '/customer/[id]', params: { id: item.customer.id } })}>
            <Text style={styles.name} numberOfLines={1}>{item.customer.name}</Text>
            <Text style={styles.meta}>{item.customer.phoneDisplay}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={`Позвонить ${item.customer.phoneDisplay}`} style={styles.call}
            onPress={() => Linking.openURL(`tel:${item.customer.phoneDisplay.replace(/[^\d+]/g, '')}`)}>
            <Icon name="phone" size={19}/>
          </Pressable>
        </View>
        <View style={styles.divider}/>
        <View style={styles.car}>
          <Plate plate={item.vehicle.plate}/>
          <Text style={styles.carName} numberOfLines={1}>{vehicleName(item.vehicle)}</Text>
          {vehicleNote ? <Text style={styles.meta} numberOfLines={1}>{vehicleNote}</Text> : null}
        </View>
      </Card>

      <View style={styles.tiles}>
        <Tile label="Начало" value={timeOf(item.startAt, timeZone)} color={colors.tilePeach}/>
        <Tile label="Длительность" value={duration(item.estimatedDurationMinutes)} color={colors.tileSky}/>
        <Tile label="Предварительно" value={money(item.preliminaryAmountMinor)} color={colors.tileSage}/>
      </View>

      {booking?.lines.length ? <>
        <Heading style={{ marginTop: 4 }}>Состав записи</Heading>
        <Card>
          {booking.lines.map((line) => (
            <View key={`${line.type}-${line.id}`} style={styles.line}>
              <Text style={[styles.lineName, line.excluded && styles.muted]}>{line.name}</Text>
              <Text style={[styles.lineAmount, line.excluded && styles.muted]}>{line.excluded ? 'в комплексе' : money(line.amountMinor)}</Text>
            </View>
          ))}
        </Card>
      </> : null}

      {item.slotConflict ? <Notice>Конфликт времени: запись сделали без связи с сервером, а это время за это время заняли. Перенесите её на свободное время.</Notice>
        : item.pendingSync ? <Notice tone="info">Сохранено на телефоне — отправится, когда появится связь.</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      {item.orderId ? <View style={styles.actions}>
        <Button title="Открыть заказ" onPress={() => router.navigate({ pathname: '/orders/[id]', params: { id: item.orderId!, title: item.vehicle.plate, bodyType: item.vehicle.bodyType ?? '', subtitle: `${vehicleName(item.vehicle)} · ${item.customer.name}` } })}/>
        <Body muted>По записи уже создан заказ: время и состав зафиксированы, дальше изменения идут через смету.</Body>
      </View> : null}

      {!locked ? <View style={styles.actions}>
        {session.capabilities.manageIntake ? <Button title="Клиент приехал — начать приёмку" busy={busy === 'arrive'} onPress={() => void arrive()}/> : null}
        {canManage ? <ButtonPair>
          <Button title="Перенести" tone="secondary" style={{ flex: 1 }} onPress={() => { setSheet('move'); setError(''); }}/>
          {started ? <Button title="Клиент не приехал" tone="secondary" style={{ flex: 1 }} onPress={() => setSheet('noshow')}/> : null}
        </ButtonPair> : null}
        {canManage ? <Button title="Отменить запись" tone="dangerQuiet" onPress={() => setSheet('cancel')}/> : null}
      </View> : null}

      <Sheet visible={sheet === 'noshow'} title="Отметить неявку?" note="Время освободится, запись останется в истории клиента." onClose={() => setSheet(null)}>
        <Summary item={item} when={shortWhen(item.startAt)}/>
        <ButtonPair>
          <Button title="Назад" tone="secondary" style={{ flex: 1 }} onPress={() => setSheet(null)}/>
          <Button title="Не приехал" style={{ flex: 1 }} busy={busy === 'noshow'} onPress={() => void change('noshow', { status: 'NO_SHOW' })}/>
        </ButtonPair>
      </Sheet>

      <Sheet visible={sheet === 'cancel'} title="Отменить запись?" note="Время освободится для других клиентов. Запись останется в истории." onClose={() => setSheet(null)}>
        <Summary item={item} when={shortWhen(item.startAt)}/>
        <ButtonPair>
          <Button title="Назад" tone="secondary" style={{ flex: 1 }} onPress={() => setSheet(null)}/>
          <Button title="Отменить запись" tone="danger" style={{ flex: 1 }} busy={busy === 'cancel'} onPress={() => void change('cancel', { status: 'CANCELLED' })}/>
        </ButtonPair>
      </Sheet>

      <Sheet visible={moving} title="Новое время" note={`Было: ${shortWhen(item.startAt)} · нужно ${duration(item.estimatedDurationMinutes)}`} onClose={() => { setSheet(null); setMoveTo(''); }}>
        <DateStrip from={today} days={14} value={moveDay} onChange={(key) => { setMoveDay(key); setMoveTo(''); }} today={today}/>
        {availability.error ? <Notice>{availability.error}</Notice> : <SlotGrid availability={availability.data} value={moveTo} onChange={setMoveTo}/>}
        <ButtonPair>
          <Button title="Назад" tone="secondary" style={{ flex: 1 }} onPress={() => { setSheet(null); setMoveTo(''); }}/>
          <Button title={moveTo ? `Перенести на ${shortWhen(moveTo)}` : 'Выберите время'} style={{ flex: 1.6 }} busy={busy === 'move'} disabled={!moveTo}
            onPress={() => void change('move', { startAt: moveTo })}/>
        </ButtonPair>
      </Sheet>
    </Screen>
  );
}

function Summary({ item, when }: { item: BookingListItem; when: string }) {
  const styles = useStyles();
  return (
    <View style={styles.summary}>
      <Plate plate={item.vehicle.plate}/>
      <View style={{ flex: 1 }}>
        <Text style={styles.summaryName} numberOfLines={1}>{item.customer.name}</Text>
        <Text style={styles.meta}>{when}</Text>
      </View>
    </View>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  const styles = useStyles();
  return (
    <View style={[styles.tile, { backgroundColor: color }]}>
      <Text style={styles.tileLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{label}</Text>
      <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  top: { flexDirection: 'row' },
  titleBlock: { gap: 6, paddingHorizontal: 4, paddingTop: 6 },
  h1: { fontSize: 40, lineHeight: 44, fontWeight: '500', letterSpacing: -1.4 },
  meta: { color: colors.muted, fontSize: 13 },
  muted: { color: colors.muted },
  person: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  name: { fontSize: 17, fontWeight: '600' },
  call: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...cardShadow(scheme) },
  divider: { height: 1, backgroundColor: colors.line },
  car: { flexDirection: 'row', alignItems: 'center', gap: space.m, flexWrap: 'wrap' },
  carName: { fontSize: 15, fontWeight: '600' },
  tiles: { flexDirection: 'row', gap: space.s },
  tile: { flex: 1, borderRadius: radius.m, paddingVertical: space.m, paddingHorizontal: 10, gap: 2 },
  tileLabel: { color: colors.tileInk, fontSize: 11, fontWeight: '600', opacity: 0.75 },
  tileValue: { color: colors.tileInk, fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: space.m },
  lineName: { fontSize: 15, flex: 1 },
  lineAmount: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  actions: { gap: space.s, marginTop: 6 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.m, paddingHorizontal: 14, borderRadius: radius.m, backgroundColor: colors.soft },
  summaryName: { fontSize: 15, fontWeight: '600' }
}));
