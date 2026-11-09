import { useCallback, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { carLayout, normalizeBodyType } from '@df/shared/carLayouts';
import { CarDiagram } from '@/features/car-diagram';
import { useBookingDraft } from '@/lib/booking-draft';
import { bodyName, bookingStatuses, dayKey, dayOfMonth, duration, money, orderStatuses, shortDate, timeOf, vehicleName, weekday } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Heading, Loading, Notice, Pill, Screen } from '@/ui';
import { FlowHeader, RoundButton } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Plate } from '@/ui/plate';
import { ButtonPair, Sheet } from '@/ui/sheet';
import { Text } from '@/ui/text';

const plural = (count: number, one: string, few: string, many: string) => {
  const last = count % 10; const lastTwo = count % 100;
  return lastTwo >= 11 && lastTwo <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
};
const since = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '').replace(/^(\S+)/, (month) => ({ январь: 'января', февраль: 'февраля', март: 'марта', апрель: 'апреля', май: 'мая', июнь: 'июня', июль: 'июля', август: 'августа', сентябрь: 'сентября', октябрь: 'октября', ноябрь: 'ноября', декабрь: 'декабря' } as Record<string, string>)[month] ?? month);

/** A customer: contacts, cars (each can be booked), bookings and orders. Editing stays in the web version. */
export default function CustomerScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const session = useSignedIn();
  const timeZone = session.tenant.timezone;
  const { reset } = useBookingDraft();
  const { data, error, reload, refreshing } = useResource(useCallback((signal: AbortSignal) => api.customerProfile(id, signal), [api, id]));
  const [erasing, setErasing] = useState(false);
  const [eraseError, setEraseError] = useState('');
  const [confirm, setConfirm] = useState(false);

  if (!data && !error) return <Loading label="Загружаем клиента…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  const { customer, stats } = data;
  const canBook = session.capabilities.manageBookings && !customer.archived;
  const upcoming = data.bookings.filter((booking) => booking.status === 'CONFIRMED' && !booking.orderId);
  const history = data.bookings.filter((booking) => booking.status !== 'CONFIRMED').slice(0, 10);
  const [first, ...rest] = customer.name.split(/\s+/);
  const ordersOf = (vehicleId: string) => data.orders.filter((order) => order.vehicle.id === vehicleId).length;
  const bookCar = (vehicle: (typeof data.vehicles)[number]) => { reset({ customer, vehicle }); router.navigate('/new'); router.push('/new/services'); };
  const erase = async () => {
    setErasing(true); setEraseError('');
    try { await api.eraseCustomer(customer.id); setConfirm(false); reload(); }
    catch (failure) { setEraseError((failure as Error).message); setConfirm(false); }
    finally { setErasing(false); }
  };

  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18 }}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.ink} colors={[colors.accent]} progressBackgroundColor={colors.surface} onRefresh={reload}/>}>
      <FlowHeader title="Клиент" note={`с ${since(customer.createdAt)}`}/>
      <View style={styles.hero}>
        <View style={{ flex: 1, gap: 4 }}>
          {customer.archived ? <Pill label="Клиент в архиве" tone="past"/> : null}
          <Text style={styles.h1} accessibilityRole="header">{first}{rest.length ? `\n${rest.join(' ')}` : ''}</Text>
          <Text style={styles.meta}>{customer.phoneDisplay}{stats.lastVisitAt ? ` · последний визит ${shortDate(stats.lastVisitAt).split(',')[0]}` : ''}</Text>
        </View>
        <RoundButton icon="phone" label={`Позвонить ${customer.phoneDisplay}`} onPress={() => Linking.openURL(`tel:${customer.phoneDisplay.replace(/[^\d+]/g, '')}`)}/>
      </View>

      <View style={styles.tiles}>
        <Tile value={stats.openBookings} label="Записи" color={colors.tilePeach}/>
        <Tile value={stats.activeOrders} label="Заказы в работе" color={colors.tileSky}/>
        <Tile value={stats.closedOrders} label="Закрыто" color={colors.tileSage}/>
      </View>

      <View style={styles.sectionHead}><Heading>Автомобили</Heading><Text style={styles.meta}>{data.vehicles.length}</Text></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.cars} style={styles.bleed}>
        {data.vehicles.map((vehicle) => {
          const orders = ordersOf(vehicle.id);
          return (
            <Pressable key={vehicle.id} accessibilityRole="button" accessibilityLabel={`${vehicleName(vehicle)}, ${vehicle.plate}${canBook ? ', записать' : ''}`} disabled={!canBook}
              onPress={() => bookCar(vehicle)} style={styles.car}>
              <View style={styles.carPicture}><CarDiagram layout={carLayout(normalizeBodyType(vehicle.bodyType))} marks={new Map()} width={44}/></View>
              <Text style={styles.carName} numberOfLines={1}>{vehicleName(vehicle)}</Text>
              <Plate plate={vehicle.plate}/>
              <Text style={styles.small} numberOfLines={1}>{[bodyName(vehicle.bodyType), orders ? `${orders} ${plural(orders, 'заказ', 'заказа', 'заказов')}` : 'новый'].filter(Boolean).join(' · ')}</Text>
            </Pressable>
          );
        })}
        {canBook ? <Pressable accessibilityRole="button" onPress={() => { reset({ customer }); router.navigate('/new'); router.push('/new/vehicle'); }} style={styles.addCar}>
          <Icon name="plus" size={22}/>
          <Text style={styles.addCarText}>Добавить{'\n'}автомобиль</Text>
        </Pressable> : null}
      </ScrollView>
      {!data.vehicles.length && !canBook ? <Body muted>Автомобилей нет.</Body> : null}

      {upcoming.length ? <>
        <Heading style={{ marginTop: 4 }}>Предстоящие записи</Heading>
        {upcoming.map((booking) => {
          const key = dayKey(booking.startAt, timeZone);
          return (
            <Pressable key={booking.id} accessibilityRole="button" style={styles.item}
              onPress={() => router.navigate({ pathname: '/bookings/[id]', params: { id: booking.id, item: JSON.stringify({ ...booking, channel: '', customer: { id: customer.id, name: customer.name, phoneDisplay: customer.phoneDisplay } }) } })}>
              <View style={styles.when}><Text style={styles.whenTime}>{timeOf(booking.startAt, timeZone)}</Text><Text style={styles.small}>{weekday(key)} {dayOfMonth(key)}</Text></View>
              <View style={{ flex: 1, gap: 3 }}>
                <View style={styles.itemHead}><Text style={styles.itemTitle} numberOfLines={1}>{vehicleName(booking.vehicle)} · {booking.vehicle.plate}</Text><Pill label={bookingStatuses[booking.status].label} tone="wait"/></View>
                <Text style={styles.small}>{money(booking.preliminaryAmountMinor)} · {duration(booking.estimatedDurationMinutes)}</Text>
              </View>
            </Pressable>
          );
        })}
      </> : null}

      {data.orders.length ? <>
        <Heading style={{ marginTop: 4 }}>Заказы</Heading>
        <View style={styles.list}>
          {data.orders.map((order, index) => (
            <Pressable key={order.id} accessibilityRole="button" style={[styles.listRow, index > 0 && styles.listLine]}
              onPress={() => router.navigate({ pathname: '/orders/[id]', params: { id: order.id, title: order.vehicle.plate, bodyType: order.vehicle.bodyType ?? '', subtitle: `${vehicleName(order.vehicle)} · ${customer.name}` } })}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.itemTitle} numberOfLines={1}>{vehicleName(order.vehicle)} · {order.vehicle.plate}</Text>
                <Text style={styles.small}>{order.status === 'CLOSED' ? '' : 'открыт '}{shortDate(order.createdAt).split(',')[0]}{order.totalAmountMinor !== null ? ` · ${money(order.totalAmountMinor)}` : ''}</Text>
              </View>
              <Pill label={orderStatuses[order.status].label} tone={order.status === 'CLOSED' ? 'past' : 'work'}/>
            </Pressable>
          ))}
        </View>
      </> : null}

      {history.length ? <>
        <Heading style={{ marginTop: 4 }}>История записей</Heading>
        <View style={styles.list}>
          {history.map((booking, index) => (
            <View key={booking.id} style={[styles.listRow, index > 0 && styles.listLine]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.itemTitle} numberOfLines={1}>{vehicleName(booking.vehicle)} · {booking.vehicle.plate}</Text>
                <Text style={styles.small}>{shortDate(booking.startAt)}</Text>
              </View>
              <Pill label={bookingStatuses[booking.status].label} tone="past"/>
            </View>
          ))}
        </View>
      </> : null}

      <Text style={[styles.small, { paddingHorizontal: 4 }]}>Изменить имя, телефон, архив и владельца автомобиля можно в веб-версии.</Text>
      {eraseError ? <Notice>{eraseError}</Notice> : null}
      {session.capabilities.manageSettings && customer.name !== 'Удалённый клиент'
        ? <Button title="Удалить данные клиента" tone="dangerQuiet" busy={erasing} testID="erase-customer" onPress={() => setConfirm(true)}/> : null}

      <Sheet visible={confirm} title="Удалить персональные данные клиента?" note="Так исполняется просьба клиента удалить его данные." onClose={() => setConfirm(false)}>
        <View style={styles.columns}>
          <View style={[styles.column, { backgroundColor: colors.carTintHi }]}>
            <Text style={styles.columnTitle}>Удалим</Text>
            {['Имя и телефон', 'Госномера', 'Фото в заказах', 'Имя и подпись в актах'].map((line) => <Text key={line} style={styles.columnLine}>{line}</Text>)}
          </View>
          <View style={[styles.column, { backgroundColor: colors.soft }]}>
            <Text style={styles.columnTitle}>Останется</Text>
            {['Заказы', 'Суммы', 'Работы'].map((line) => <Text key={line} style={styles.columnLine}>{line}</Text>)}
            <Text style={styles.small}>без персональных данных</Text>
          </View>
        </View>
        <Text style={styles.warning}>Отменить нельзя.</Text>
        <ButtonPair>
          <Button title="Не удалять" tone="secondary" style={{ flex: 1 }} onPress={() => setConfirm(false)}/>
          <Button title="Удалить навсегда" tone="danger" style={{ flex: 1.2 }} busy={erasing} testID="erase-customer-confirm" onPress={() => void erase()}/>
        </ButtonPair>
      </Sheet>
    </Screen>
  );
}

function Tile({ value, label, color }: { value: number; label: string; color: string }) {
  const styles = useStyles();
  return <View style={[styles.tile, { backgroundColor: color }]}><Text style={styles.tileValue}>{value}</Text><Text style={styles.tileLabel}>{label}</Text></View>;
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  hero: { flexDirection: 'row', alignItems: 'flex-end', gap: space.m, paddingHorizontal: 4, paddingTop: 6 },
  h1: { fontSize: 32, lineHeight: 36, fontWeight: '500', letterSpacing: -1 },
  meta: { color: colors.muted, fontSize: 14 },
  small: { color: colors.muted, fontSize: 12 },
  tiles: { flexDirection: 'row', gap: space.s },
  tile: { flex: 1, borderRadius: radius.m, paddingVertical: space.m, paddingHorizontal: 14, gap: 2 },
  tileValue: { color: colors.tileInk, fontSize: 26, fontWeight: '500', letterSpacing: -0.5 },
  tileLabel: { color: colors.tileInk, fontSize: 12, fontWeight: '600', opacity: 0.75 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  bleed: { marginHorizontal: -space.l, flexGrow: 0 },
  cars: { gap: 10, paddingHorizontal: space.l, paddingVertical: 6 },
  car: { width: 158, borderRadius: 24, backgroundColor: colors.surface, padding: space.m, gap: 6, ...cardShadow(scheme) },
  carPicture: { height: 108, borderRadius: 18, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  carName: { fontSize: 15, fontWeight: '600' },
  addCar: { width: 120, borderRadius: 24, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.carDraw, alignItems: 'center', justifyContent: 'center', gap: 8, padding: space.m },
  addCarText: { fontSize: 13, fontWeight: '600', textAlign: 'center' },
  item: { flexDirection: 'row', gap: space.m, alignItems: 'center', borderRadius: radius.m, backgroundColor: colors.surface, padding: 14, ...cardShadow(scheme) },
  when: { width: 52 },
  whenTime: { fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.s },
  itemTitle: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  list: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, ...cardShadow(scheme) },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: 14 },
  listLine: { borderTopWidth: 1, borderTopColor: colors.line },
  columns: { flexDirection: 'row', gap: space.s },
  column: { flex: 1, borderRadius: radius.m, padding: 14, gap: 4 },
  columnTitle: { fontSize: 13, fontWeight: '700', marginBottom: 4 },
  columnLine: { fontSize: 14 },
  warning: { color: colors.sevHiText, fontSize: 13, fontWeight: '600', paddingHorizontal: 4 }
}));
