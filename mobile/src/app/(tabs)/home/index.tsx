import { useCallback } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AnalyticsOverview, BookingListItem, OrderListItem } from '@df/types';
import { useUnread } from '@/features/notifications';
import { addDays, channelLabel, dayKey, dayTitle, duration, money, timeOf, vehicleName, weekday } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Button, Card, Heading, Notice, Screen } from '@/ui';
import { Icon } from '@/ui/icons';
import { Plate } from '@/ui/plate';
import { Text } from '@/ui/text';

// What waits for a decision: a car being taken in, an estimate to make, an approved order with no master.
const waitsForDecision = (order: OrderListItem) =>
  order.status === 'INTAKE' || order.status === 'ESTIMATE_DRAFT' || (order.status === 'APPROVED' && !order.masterMemberId);

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '·';
const greeting = (hour: number) => hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';
const plural = (count: number, one: string, few: string, many: string) => {
  const last = count % 10; const lastTwo = count % 100;
  return lastTwo >= 11 && lastTwo <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
};

/** The day at a glance: what waits for a decision, the next visit, the week. Statistics open from here. */
export default function HomeScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { api } = useSession();
  const session = useSignedIn();
  const { unread } = useUnread();
  const insets = useSafeAreaInsets();
  const can = session.capabilities;
  const timeZone = session.tenant.timezone;
  const today = dayKey(new Date(), timeZone);
  const seesBookings = can.manageBookings || can.manageIntake;

  const { data, error, reload, refresh, refreshing } = useResource(useCallback(async (signal: AbortSignal) => {
    const [orders, upcoming, analytics] = await Promise.all([
      api.listOrders(signal).then((result) => result.items).catch(() => null),
      seesBookings ? api.listBookings('upcoming', signal).then((result) => result.items).catch(() => null) : Promise.resolve(null),
      can.viewAnalytics ? api.analytics(addDays(today, -6), today, signal).catch(() => null) : Promise.resolve(null)
    ]);
    if (!orders && !upcoming && !analytics) throw new Error('Не удалось загрузить сводку. Потяните вниз, чтобы повторить.');
    return { orders, upcoming, analytics };
  }, [api, seesBookings, can.viewAnalytics, today]));
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const hour = Number(timeOf(new Date().toISOString(), timeZone).slice(0, 2));
  const orders = data?.orders ?? [];
  const deciding = orders.filter(waitsForDecision).length;
  const next = data?.upcoming?.find((item) => item.status === 'CONFIRMED' && !item.orderId) ?? null;

  return (
    <Screen contentStyle={{ paddingTop: insets.top + space.l, gap: 20 }}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.ink} colors={[colors.accent]} progressBackgroundColor={colors.surface} onRefresh={reload}/>}>
      <View style={styles.top}>
        <View style={styles.avatar}><Text style={styles.avatarText}>{initials(session.actor.displayName)}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>{greeting(hour)}</Text>
          <Text style={styles.name} numberOfLines={1}>{session.actor.displayName}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={unread ? `Уведомления, новых: ${unread}` : 'Уведомления'} onPress={() => router.navigate('/profile/notifications')} style={styles.round}>
          <Icon name="bell" size={19}/>
          {unread ? <View style={styles.dot}/> : null}
        </Pressable>
      </View>

      {data?.orders ? (
        <Text style={styles.h1} accessibilityRole="header">
          {deciding
            ? <><Text style={styles.h1Accent}>{deciding} {plural(deciding, 'заказ ждёт', 'заказа ждут', 'заказов ждут')}</Text>{'\n'}<Text style={styles.h1Muted}>вашего решения</Text></>
            : <><Text style={styles.h1}>Решений не ждёт</Text>{'\n'}<Text style={styles.h1Muted}>ни один заказ</Text></>}
        </Text>
      ) : <Text style={styles.h1} accessibilityRole="header">{session.tenant.name}</Text>}

      {error ? <Notice>{error}</Notice> : null}
      {data ? <Tiles orders={data.orders} analytics={data.analytics}/> : null}

      {seesBookings ? <>
        <View style={styles.sectionHead}>
          <Heading>Ближайшая запись</Heading>
          <Pressable accessibilityRole="link" hitSlop={8} onPress={() => router.navigate('/bookings')}><Text style={styles.link}>Все записи</Text></Pressable>
        </View>
        {next ? <NextVisit item={next} today={today} timeZone={timeZone}/>
          : data ? <Card><Text style={styles.muted}>Подтверждённых записей впереди нет.</Text>
            {can.manageBookings ? <Button title="Новая запись" tone="secondary" onPress={() => router.navigate('/new')}/> : null}</Card> : null}
      </> : null}

      {data?.analytics ? <Week analytics={data.analytics}/> : null}
    </Screen>
  );
}

function Tiles({ orders, analytics }: { orders: OrderListItem[] | null; analytics: AnalyticsOverview | null }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const active = orders?.filter((order) => order.status !== 'CLOSED' && order.status !== 'READY') ?? [];
  const working = active.filter((order) => order.status === 'IN_PROGRESS' || order.status === 'QC').length;
  const ready = orders?.filter((order) => order.status === 'READY') ?? [];
  const tiles = [
    analytics ? { label: 'Согласовано', value: money(analytics.orders.approvedEstimateAmountMinor), note: 'за 7 дней', color: colors.tileSky } : null,
    orders ? { label: 'В работе', value: `${working} / ${active.length}`, note: plural(active.length, 'заказ', 'заказа', 'заказов'), color: colors.tileSage } : null,
    orders ? { label: 'К выдаче', value: String(ready.length), note: ready.length === 1 ? vehicleName(ready[0].vehicle) : ready.length ? 'автомобиля' : 'нет готовых', color: colors.tilePeach,
      onPress: ready.length ? () => router.navigate('/orders') : undefined } : null
  ].filter((tile) => tile !== null);
  if (!tiles.length) return null;
  return (
    <View style={styles.tiles}>
      {tiles.map((tile) => (
        <Pressable key={tile.label} disabled={!tile.onPress} onPress={tile.onPress} accessibilityRole={tile.onPress ? 'button' : undefined}
          style={[styles.tile, { backgroundColor: tile.color }]}>
          <Text style={styles.tileLabel}>{tile.label}</Text>
          <View>
            <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>{tile.value}</Text>
            <Text style={styles.tileNote} numberOfLines={1}>{tile.note}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function NextVisit({ item, today, timeZone }: { item: BookingListItem; today: string; timeZone: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const day = dayKey(item.startAt, timeZone);
  const open = () => router.navigate({ pathname: '/bookings/[id]', params: { id: item.id } });
  return (
    <Card style={{ gap: 14 }}>
      <View style={styles.row}>
        <View style={[styles.avatarSmall, { backgroundColor: colors.tileSky }]}><Text style={styles.avatarSmallText}>{initials(item.customer.name)}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={styles.strong} numberOfLines={1}>{item.customer.name}</Text>
          <Text style={styles.meta} numberOfLines={1}>{item.customer.phoneDisplay}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Открыть запись" onPress={open} style={styles.openButton}><Icon name="chevronRight" size={18}/></Pressable>
      </View>
      <View style={styles.dashed}>
        <Text style={styles.meta}>Запись</Text>
        <Text style={styles.when}>{[item.services?.length ? item.services.join(', ') : null, `${dayTitle(day, today).replace(/^./, (letter) => letter.toLowerCase())}, ${timeOf(item.startAt, timeZone)}`].filter(Boolean).join(' · ')}</Text>
      </View>
      <View style={styles.amountRow}>
        <Text style={styles.amount}>{money(item.preliminaryAmountMinor)}</Text>
        <View style={styles.row}><Icon name="clock" size={15} color={colors.muted}/><Text style={styles.meta}>{duration(item.estimatedDurationMinutes)}</Text></View>
      </View>
      <View style={styles.facts}>
        <View style={styles.fact}>
          <Text style={styles.meta}>Машина</Text>
          <Text style={styles.factValue} numberOfLines={1}>{vehicleName(item.vehicle)}</Text>
          <Plate plate={item.vehicle.plate}/>
        </View>
        <View style={styles.fact}>
          <Text style={styles.meta}>Канал</Text>
          <Text style={styles.factValue} numberOfLines={1}>{channelLabel(item.channel)}</Text>
          <Text style={styles.metaSmall}>подтверждена</Text>
        </View>
      </View>
      <View style={styles.buttons}>
        <Button title="Перенести" tone="secondary" style={{ flex: 1 }} onPress={open}/>
        <Button title="Клиент приехал" style={{ flex: 1.6 }} onPress={open}/>
      </View>
    </Card>
  );
}

/** Orders by day of the last week; the busiest day is dark and named. */
function Week({ analytics }: { analytics: AnalyticsOverview }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const days = analytics.daily.slice(-7);
  const top = Math.max(1, ...days.map((day) => day.orders));
  const busiest = days.reduce((best, day) => (day.orders > best.orders ? day : best), days[0]);
  const total = days.reduce((sum, day) => sum + day.orders, 0);
  return (
    <Card style={{ gap: 14 }}>
      <View style={styles.sectionHead}>
        <View><Heading>Заказы за неделю</Heading><Text style={styles.meta}>{`${days[0]?.date.slice(8)}.${days[0]?.date.slice(5, 7)} – ${days.at(-1)?.date.slice(8)}.${days.at(-1)?.date.slice(5, 7)}`}</Text></View>
        <View style={styles.count}><Text style={styles.countText}>{total} всего</Text></View>
      </View>
      <View style={styles.bars} accessibilityLabel={`Заказов за неделю: ${total}`}>
        {days.map((day) => {
          const on = busiest && day.date === busiest.date && day.orders > 0;
          return (
            <View key={day.date} style={styles.barColumn}>
              {on ? <Text style={styles.barTip}>{day.orders}</Text> : null}
              <View style={[styles.bar, { height: Math.max(12, (day.orders / top) * 96), backgroundColor: on ? colors.pill : colors.tileSage }]}/>
              <Text style={styles.metaSmall}>{weekday(day.date)}</Text>
            </View>
          );
        })}
      </View>
      <Button title="Вся статистика" tone="secondary" onPress={() => router.navigate('/analytics')}/>
    </Card>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  avatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: colors.tilePeach, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.tileInk, fontSize: 15, fontWeight: '700' },
  hello: { color: colors.muted, fontSize: 12 },
  name: { fontSize: 16, fontWeight: '600' },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...cardShadow(scheme) },
  dot: { position: 'absolute', top: 10, right: 11, width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  h1: { fontSize: 30, lineHeight: 36, fontWeight: '500', letterSpacing: -0.9 },
  h1Accent: { color: colors.accent },
  h1Muted: { color: colors.muted, fontWeight: '400' },
  tiles: { flexDirection: 'row', gap: space.s },
  tile: { flex: 1, height: 112, borderRadius: 22, padding: 14, justifyContent: 'space-between' },
  tileLabel: { color: colors.tileInk, fontSize: 12, fontWeight: '600', opacity: 0.75 },
  tileValue: { color: colors.tileInk, fontSize: 22, fontWeight: '500', letterSpacing: -0.4, fontVariant: ['tabular-nums'] },
  tileNote: { color: colors.tileInk, fontSize: 11, opacity: 0.75 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { color: colors.muted, fontSize: 13 },
  muted: { color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatarSmall: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarSmallText: { color: colors.tileInk, fontSize: 13, fontWeight: '700' },
  strong: { fontSize: 15, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 13 },
  metaSmall: { color: colors.muted, fontSize: 11 },
  openButton: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  dashed: { gap: 2, paddingTop: space.m, borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: colors.line },
  when: { fontSize: 18, fontWeight: '500' },
  amountRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  amount: { fontSize: 32, fontWeight: '500', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  facts: { flexDirection: 'row', gap: space.s },
  fact: { flex: 1, borderRadius: 18, backgroundColor: colors.soft, paddingVertical: 10, paddingHorizontal: space.m, gap: 3 },
  factValue: { fontSize: 14, fontWeight: '600' },
  buttons: { flexDirection: 'row', gap: space.s },
  count: { height: 30, paddingHorizontal: space.m, borderRadius: radius.pill, backgroundColor: colors.soft, justifyContent: 'center' },
  countText: { fontSize: 12, fontWeight: '600' },
  bars: { height: 150, flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  barColumn: { flex: 1, alignItems: 'center', gap: space.s },
  bar: { width: 26, borderRadius: 13 },
  barTip: { fontSize: 12, fontWeight: '700' }
}));
