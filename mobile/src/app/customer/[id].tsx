import { useCallback } from 'react';
import { Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { VehicleRow } from '@/features/booking-ui';
import { useBookingDraft } from '@/lib/booking-draft';
import { bookingStatuses, dayKey, dayTitle, money, orderStatuses, shortDate, timeOf, vehicleName, visits } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Label, Loading, Notice, Pill, Screen } from '@/ui';

/** A customer: contacts, cars (each can be booked), bookings and orders. Editing stays in the web version. */
export default function CustomerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const session = useSignedIn();
  const timeZone = session.tenant.timezone;
  const today = dayKey(new Date(), timeZone);
  const { reset } = useBookingDraft();
  const { data, error, reload, refreshing } = useResource(useCallback((signal: AbortSignal) => api.customerProfile(id, signal), [api, id]));

  if (!data && !error) return <Loading label="Загружаем клиента…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  const { customer, stats } = data;
  const canBook = session.capabilities.manageBookings && !customer.archived;
  const upcoming = data.bookings.filter((booking) => booking.status === 'CONFIRMED' && !booking.orderId);

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} onRefresh={reload}/>}>
      <Stack.Screen options={{ title: customer.name }}/>
      <Card>
        {customer.archived ? <Pill label="Клиент в архиве" tone="warn"/> : null}
        <Text style={styles.name}>{customer.name}</Text>
        <Pressable accessibilityRole="link" onPress={() => Linking.openURL(`tel:${customer.phoneDisplay.replace(/[^\d+]/g, '')}`)}>
          <Text style={styles.phone}>{customer.phoneDisplay}</Text>
        </Pressable>
        <Text style={styles.meta}>{visits(stats.closedOrders)}{stats.lastVisitAt ? ` · последний ${shortDate(stats.lastVisitAt)}` : ''}</Text>
      </Card>

      <View style={styles.stats}>
        <Stat label="Записи" value={stats.openBookings}/>
        <Stat label="Заказы в работе" value={stats.activeOrders}/>
        <Stat label="Закрыто" value={stats.closedOrders}/>
      </View>

      <View style={styles.group}>
        <Label>Автомобили</Label>
        {data.vehicles.length ? data.vehicles.map((vehicle) => (
          <VehicleRow key={vehicle.id} vehicle={vehicle} disabled={!canBook} onPress={() => {
            reset({ customer, vehicle });
            router.navigate('/new');
            router.push('/new/services');
          }}/>
        )) : <Body muted>Автомобилей нет.</Body>}
        {canBook ? <Button title="＋ Добавить автомобиль" tone="quiet" onPress={() => { reset({ customer }); router.navigate('/new'); router.push('/new/vehicle'); }}/> : null}
      </View>

      {upcoming.length ? <View style={styles.group}>
        <Label>Предстоящие записи</Label>
        {upcoming.map((booking) => (
          <Pressable key={booking.id} accessibilityRole="button" style={styles.item}
            onPress={() => router.navigate({ pathname: '/bookings/[id]', params: { id: booking.id, item: JSON.stringify({ ...booking, channel: '', customer: { id: customer.id, name: customer.name, phoneDisplay: customer.phoneDisplay } }) } })}>
            <Text style={styles.itemTitle}>{dayTitle(dayKey(booking.startAt, timeZone), today)}, {timeOf(booking.startAt, timeZone)}</Text>
            <Text style={styles.meta}>{booking.vehicle.plate} · {money(booking.preliminaryAmountMinor)}</Text>
          </Pressable>
        ))}
      </View> : null}

      {data.orders.length ? <View style={styles.group}>
        <Label>Заказы</Label>
        {data.orders.map((order) => (
          <Pressable key={order.id} accessibilityRole="button" style={styles.item}
            onPress={() => router.navigate({ pathname: '/orders/[id]', params: { id: order.id, title: order.vehicle.plate, bodyType: order.vehicle.bodyType ?? '', subtitle: `${vehicleName(order.vehicle)} · ${customer.name}` } })}>
            <View style={styles.itemHead}><Text style={styles.itemTitle}>{order.vehicle.plate}</Text><Pill label={orderStatuses[order.status].label} tone={order.status === 'CLOSED' ? 'neutral' : 'accent'}/></View>
            <Text style={styles.meta}>{shortDate(order.createdAt)}{order.totalAmountMinor !== null ? ` · ${money(order.totalAmountMinor)}` : ''}</Text>
          </Pressable>
        ))}
      </View> : null}

      {data.bookings.some((booking) => booking.status !== 'CONFIRMED') ? <View style={styles.group}>
        <Label>История записей</Label>
        {data.bookings.filter((booking) => booking.status !== 'CONFIRMED').slice(0, 10).map((booking) => (
          <Text key={booking.id} style={styles.meta}>{shortDate(booking.startAt)} · {booking.vehicle.plate} · {bookingStatuses[booking.status].label}</Text>
        ))}
      </View> : null}

      <Body muted>Изменить имя, телефон, архив и владельца автомобиля можно в веб-версии.</Body>
    </Screen>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  name: { color: colors.text, fontSize: 24, fontWeight: '800' },
  phone: { color: colors.primary, fontSize: 17, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 14 },
  stats: { flexDirection: 'row', gap: space.s },
  stat: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '800' },
  statLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  group: { gap: space.s },
  item: { backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m, gap: 2 },
  itemHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  itemTitle: { color: colors.text, fontSize: 16, fontWeight: '700' }
});
