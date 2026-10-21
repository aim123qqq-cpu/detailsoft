import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { AnalyticsOverview } from '@df/types';
import { addDays, dayKey, dayOfMonth, longDay, money, orderStatuses } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Chip, Label, Loading, Notice, Screen } from '@/ui';
import { ComingSoon } from '@/ui/coming-soon';

// Two series, validated for the dark surface (dataviz palette, slots 1 and 2): bookings blue, orders orange.
const SERIES = { bookings: '#3987e5', orders: '#d95926' } as const;
const PERIODS = [7, 30, 90] as const;

export default function AnalyticsScreen() {
  const session = useSignedIn();
  if (!session.capabilities.viewAnalytics) return <ComingSoon title="Статистика" text="Сводка по записям и заказам центра." noAccess/>;
  return <Overview/>;
}

function Overview() {
  const { api } = useSession();
  const session = useSignedIn();
  const today = dayKey(new Date(), session.tenant.timezone);
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const { data, error, reload, refreshing } = useResource(useCallback((signal: AbortSignal) =>
    api.analytics(addDays(today, -days + 1), today, signal), [api, today, days]));

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} onRefresh={reload}/>}>
      <View style={styles.periods}>{PERIODS.map((value) => <Chip key={value} label={`${value} дней`} selected={days === value} onPress={() => setDays(value)}/>)}</View>
      {error ? <><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></> : null}
      {!data && !error ? <Loading label="Считаем показатели…"/> : null}
      {data ? <Content data={data}/> : null}
    </Screen>
  );
}

function Content({ data }: { data: AnalyticsOverview }) {
  const orders = data.orders;
  return (
    <>
      <View style={styles.tiles}>
        <Tile label="Заказы" value={String(orders.total)} note={`${orders.active} в работе`}/>
        <Tile label="Записи" value={String(data.bookings.total)} note={`${data.bookings.cancelled} отменено`}/>
        <Tile label="Закрыто" value={String(orders.closed)} note={`${orders.ready} готовы к выдаче`}/>
      </View>
      <View style={styles.hero}>
        <Text style={styles.heroLabel}>Согласовано по сметам</Text>
        <Text style={styles.heroValue}>{money(orders.approvedEstimateAmountMinor)}</Text>
        {orders.averageApprovedEstimateAmountMinor ? <Text style={styles.note}>в среднем {money(orders.averageApprovedEstimateAmountMinor)} за заказ</Text> : null}
      </View>
      <Activity daily={data.daily.slice(-14)}/>
      <Statuses items={data.orderStatuses} total={orders.total}/>
      <View style={styles.card}>
        <Label>Выполнение операций</Label>
        <Text style={styles.big}>{data.operations.completionPercent}%</Text>
        <Meter share={data.operations.completionPercent / 100} color={SERIES.bookings}/>
        <Text style={styles.note}>{data.operations.done} из {data.operations.total} выполнено{data.operations.blocked ? ` · ${data.operations.blocked} заблокировано` : ''}</Text>
      </View>
    </>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return <View style={styles.tile}><Text style={styles.tileLabel}>{label}</Text><Text style={styles.tileValue}>{value}</Text><Text style={styles.note}>{note}</Text></View>;
}

/** Bookings and orders per day, side by side; tapping a day reads out its numbers. */
function Activity({ daily }: { daily: AnalyticsOverview['daily'] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const max = Math.max(1, ...daily.map((day) => Math.max(day.bookings, day.orders)));
  const shown = daily.find((day) => day.date === picked) ?? daily.at(-1);
  const HEIGHT = 120;
  const bar = (value: number) => value ? Math.max(4, value / max * HEIGHT) : 2;
  return (
    <View style={styles.card}>
      <Label>Активность по дням</Label>
      <View style={styles.legend}>
        <Legend color={SERIES.bookings} label="записи"/>
        <Legend color={SERIES.orders} label="заказы"/>
      </View>
      {shown ? <Text style={styles.readout}>{longDay(shown.date)}: {shown.bookings} зап. · {shown.orders} зак.</Text> : null}
      <View style={[styles.chart, { height: HEIGHT + 22 }]}>
        {daily.map((day) => {
          const active = day.date === shown?.date;
          return (
            <Pressable key={day.date} style={styles.day} onPress={() => setPicked(day.date)} accessibilityRole="button"
              accessibilityLabel={`${longDay(day.date)}: записей ${day.bookings}, заказов ${day.orders}`}>
              <View style={[styles.bars, { height: HEIGHT }, active && styles.barsActive]}>
                <View style={[styles.bar, { height: bar(day.bookings), backgroundColor: day.bookings ? SERIES.bookings : colors.line }]}/>
                <View style={[styles.bar, { height: bar(day.orders), backgroundColor: day.orders ? SERIES.orders : colors.line }]}/>
              </View>
              <Text style={[styles.dayLabel, active && styles.dayLabelActive]}>{dayOfMonth(day.date)}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return <View style={styles.legendItem}><View style={[styles.swatch, { backgroundColor: color }]}/><Text style={styles.note}>{label}</Text></View>;
}

/** Orders by status: one series, so one colour; the numbers are written out. */
function Statuses({ items, total }: { items: AnalyticsOverview['orderStatuses']; total: number }) {
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <View style={styles.card}>
      <View style={styles.row}><Label>Заказы по статусам</Label><Text style={styles.count}>{total}</Text></View>
      {!items.length ? <Body muted>За этот период заказов нет.</Body> : items.map((item) => (
        <View key={item.status} style={styles.statusRow} accessible accessibilityLabel={`${orderStatuses[item.status].label}: ${item.count}`}>
          <Text style={styles.statusLabel}>{orderStatuses[item.status].label}</Text>
          <View style={{ flex: 1 }}><Meter share={item.count / max} color={SERIES.bookings}/></View>
          <Text style={styles.statusCount}>{item.count}</Text>
        </View>
      ))}
    </View>
  );
}

function Meter({ share, color }: { share: number; color: string }) {
  return <View style={styles.track}><View style={[styles.fill, { width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%`, backgroundColor: color }]}/></View>;
}

const styles = StyleSheet.create({
  periods: { flexDirection: 'row', gap: space.s },
  tiles: { flexDirection: 'row', gap: space.s },
  tile: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m, gap: 2 },
  tileLabel: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  tileValue: { color: colors.text, fontSize: 26, fontWeight: '800', fontVariant: ['tabular-nums'] },
  note: { color: colors.muted, fontSize: 13 },
  hero: { backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, gap: 2 },
  heroLabel: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  heroValue: { color: colors.text, fontSize: 30, fontWeight: '800', fontVariant: ['tabular-nums'] },
  card: { backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, gap: space.s },
  big: { color: colors.text, fontSize: 26, fontWeight: '800' },
  legend: { flexDirection: 'row', gap: space.l },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  readout: { color: colors.text, fontSize: 14, fontWeight: '700' },
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  day: { flex: 1, alignItems: 'center', gap: 4 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, borderRadius: 4, paddingHorizontal: 1 },
  barsActive: { backgroundColor: 'rgba(255,255,255,.06)' },
  bar: { width: 6, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  dayLabel: { color: colors.soft, fontSize: 11, fontVariant: ['tabular-nums'] },
  dayLabelActive: { color: colors.text, fontWeight: '800' },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  count: { color: colors.text, fontSize: 15, fontWeight: '800' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: 3 },
  statusLabel: { color: colors.text, fontSize: 14, width: 120 },
  statusCount: { color: colors.text, fontSize: 14, fontWeight: '800', width: 28, textAlign: 'right', fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 }
});
