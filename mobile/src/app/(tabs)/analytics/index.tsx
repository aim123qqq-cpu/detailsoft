import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AnalyticsOverview } from '@df/types';
import { addDays, dayKey, dayOfMonth, money, orderStatuses } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Chip, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { ComingSoon } from '@/ui/coming-soon';
import { Text } from '@/ui/text';

const PERIODS = [7, 30, 90] as const;
type Block = 'approved' | 'counts' | 'top' | 'activity' | 'statuses' | 'operations';
// Which blocks a person folded away: kept on this phone only. Operations start folded, as in the design.
const HIDDEN = 'detailflow.analytics.hidden';
const HIDDEN_BY_DEFAULT: Block[] = ['operations'];
const LIGHT = '#F4F4F2';

const dayMonth = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayName = (key: string) => dayMonth.format(new Date(`${key}T00:00:00Z`));
const times = (count: number) => `${count} ${count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'раза' : 'раз'}`;

export default function AnalyticsScreen() {
  const session = useSignedIn();
  if (!session.capabilities.viewAnalytics) return <ComingSoon title="Статистика" text="Сводка по записям и заказам центра." noAccess/>;
  return <Overview/>;
}

function useHiddenBlocks() {
  const [hidden, setHidden] = useState<Block[]>(HIDDEN_BY_DEFAULT);
  useEffect(() => {
    SecureStore.getItemAsync(HIDDEN).then((value) => { if (value) setHidden(JSON.parse(value) as Block[]); }).catch(() => {});
  }, []);
  const toggle = useCallback((block: Block) => setHidden((list) => {
    const next = list.includes(block) ? list.filter((item) => item !== block) : [...list, block];
    SecureStore.setItemAsync(HIDDEN, JSON.stringify(next)).catch(() => {});
    return next;
  }), []);
  return { hidden, toggle };
}

function Overview() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const session = useSignedIn();
  const today = dayKey(new Date(), session.tenant.timezone);
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30);
  const { data, error, reload, refreshing } = useResource(useCallback((signal: AbortSignal) =>
    api.analytics(addDays(today, -days + 1), today, signal), [api, today, days]));

  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 18 }}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.ink} colors={[colors.accent]} progressBackgroundColor={colors.surface} onRefresh={reload}/>}>
      <FlowHeader title="Статистика" note={session.tenant.name} onBack={() => router.navigate('/home')}/>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bleed} contentContainerStyle={styles.chips}>
        {PERIODS.map((value) => <Chip key={value} label={`${value} дней`} selected={days === value} onPress={() => setDays(value)}/>)}
      </ScrollView>
      {error ? <><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></> : null}
      {!data && !error ? <Loading label="Считаем показатели…"/> : null}
      {data ? <Content data={data} days={days}/> : null}
    </Screen>
  );
}

function Content({ data, days }: { data: AnalyticsOverview; days: number }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { hidden, toggle } = useHiddenBlocks();
  const orders = data.orders;
  const fold = (block: Block) => ({ hidden: hidden.includes(block), onToggle: () => toggle(block) });
  return (
    <>
      <Section title="Согласовано по сметам" dark {...fold('approved')}>
        <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit>{money(orders.approvedEstimateAmountMinor)}</Text>
        <Text style={styles.heroNote}>{orders.averageApprovedEstimateAmountMinor ? `в среднем ${money(orders.averageApprovedEstimateAmountMinor)} за заказ` : 'согласованных смет пока нет'}</Text>
      </Section>

      <Section title="Заказы и записи" bare {...fold('counts')}>
        <View style={styles.tiles}>
          <Tile label="Заказы" value={orders.total} note={`${orders.active} в работе`} color={colors.tilePeach}/>
          <Tile label="Записи" value={data.bookings.total} note={`${data.bookings.cancelled} отменено`} color={colors.tileSky}/>
          <Tile label="Закрыто" value={orders.closed} note={`${orders.ready} к выдаче`} color={colors.tileSage}/>
        </View>
      </Section>

      <Section title="Топ услуг" note="чаще всего" {...fold('top')}>
        <TopServices items={data.topServices ?? []}/>
      </Section>

      <Section title="Активность по дням" {...fold('activity')}>
        <Activity daily={data.daily.slice(-Math.min(days, 14))}/>
      </Section>

      <Section title="Заказы по статусам" note={String(orders.total)} {...fold('statuses')}>
        <Statuses items={data.orderStatuses}/>
      </Section>

      <Section title="Выполнение операций" {...fold('operations')}>
        <Text style={styles.big}>{data.operations.completionPercent}%</Text>
        <Meter share={data.operations.completionPercent / 100} color={colors.ink}/>
        <Text style={styles.meta}>{data.operations.total ? `${data.operations.done} из ${data.operations.total} выполнено${data.operations.blocked ? ` · ${data.operations.blocked} заблокировано` : ''}` : 'Операций за период нет.'}</Text>
      </Section>
    </>
  );
}

/** A block of the report that can be folded away; folded, it is one line you tap to bring it back. */
function Section({ title, note, dark, bare, hidden, onToggle, children }: { title: string; note?: string; dark?: boolean; bare?: boolean; hidden: boolean; onToggle: () => void; children: ReactNode }) {
  const styles = useStyles();
  if (hidden) {
    return (
      <Pressable accessibilityRole="button" accessibilityLabel={`${title}: скрыто, показать`} onPress={onToggle} style={styles.folded}>
        <Text style={styles.foldedTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.meta}>скрыто · нажмите, чтобы показать</Text>
      </Pressable>
    );
  }
  const head = (
    <View style={styles.blockHead}>
      <View style={styles.blockTitle}>
        {bare ? <Heading>{title}</Heading> : <Text style={[styles.cardTitle, dark && styles.onDark]}>{title}</Text>}
        {note ? <Text style={[styles.meta, dark && styles.onDarkMuted]}>{bare ? note : `· ${note}`}</Text> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Скрыть блок «${title}»`} onPress={onToggle} hitSlop={8}>
        <Text style={[styles.hide, dark && styles.onDarkMuted]}>Скрыть блок</Text>
      </Pressable>
    </View>
  );
  if (bare) return <View style={{ gap: 10 }}>{head}{children}</View>;
  return <View style={[styles.card, dark && styles.darkCard]}>{head}{children}</View>;
}

function Tile({ label, value, note, color }: { label: string; value: number; note: string; color: string }) {
  const styles = useStyles();
  return (
    <View style={[styles.tile, { backgroundColor: color }]} accessible accessibilityLabel={`${label}: ${value}, ${note}`}>
      <Text style={styles.tileLabel} numberOfLines={1}>{label}</Text>
      <Text style={styles.tileValue}>{value}</Text>
      <Text style={styles.tileNote} numberOfLines={1} adjustsFontSizeToFit>{note}</Text>
    </View>
  );
}

/** The most sold lines: the leader in the accent colour, the rest in ink. */
function TopServices({ items }: { items: AnalyticsOverview['topServices'] }) {
  const styles = useStyles();
  const { colors } = useTheme();
  if (!items.length) return <Body muted>Появится, когда клиенты согласуют первые сметы.</Body>;
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <View style={{ gap: 14 }}>
      {items.map((item, index) => (
        <View key={item.name} style={{ gap: 6 }} accessible accessibilityLabel={`${index + 1}. ${item.name}: ${times(item.count)}, ${money(item.amountMinor)}`}>
          <View style={styles.topRow}>
            <Text style={styles.rank}>{index + 1}</Text>
            <Text style={styles.topName} numberOfLines={1}>{item.name}</Text>
            <Text style={styles.topAmount}>{money(item.amountMinor)}</Text>
          </View>
          <View style={styles.topRow}>
            <View style={styles.rankSpace}/>
            <View style={{ flex: 1 }}><Meter share={item.count / max} color={index === 0 ? colors.accent : colors.ink}/></View>
            <Text style={styles.topTimes}>{times(item.count)}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** Bookings and orders per day, side by side; tapping a day reads out its numbers. */
function Activity({ daily }: { daily: AnalyticsOverview['daily'] }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [picked, setPicked] = useState<string | null>(null);
  const max = Math.max(1, ...daily.map((day) => Math.max(day.bookings, day.orders)));
  const shown = daily.find((day) => day.date === picked) ?? daily.at(-1);
  const HEIGHT = 110;
  const bar = (value: number) => value ? Math.max(4, value / max * HEIGHT) : 3;
  return (
    <>
      <View style={styles.legend}>
        <Legend color={colors.ink} label="записи"/>
        <Legend color={colors.accent} label="заказы"/>
      </View>
      {shown ? <Text style={styles.readout}>{dayName(shown.date)}: {shown.bookings} зап. · {shown.orders} зак.</Text> : null}
      <View style={styles.chart}>
        {daily.map((day) => {
          const active = day.date === shown?.date;
          return (
            <Pressable key={day.date} style={styles.day} onPress={() => setPicked(day.date)} accessibilityRole="button"
              accessibilityLabel={`${dayName(day.date)}: записей ${day.bookings}, заказов ${day.orders}`}>
              <View style={[styles.bars, { height: HEIGHT }, active && styles.barsActive]}>
                <View style={[styles.bar, { height: bar(day.bookings), backgroundColor: day.bookings ? colors.ink : colors.line }]}/>
                <View style={[styles.bar, { height: bar(day.orders), backgroundColor: day.orders ? colors.accent : colors.line }]}/>
              </View>
              <Text style={[styles.dayLabel, active && styles.dayLabelActive]}>{dayOfMonth(day.date)}</Text>
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  const styles = useStyles();
  return <View style={styles.legendItem}><View style={[styles.swatch, { backgroundColor: color }]}/><Text style={styles.meta}>{label}</Text></View>;
}

/** Orders by status: one series, so one colour; the numbers are written out. */
function Statuses({ items }: { items: AnalyticsOverview['orderStatuses'] }) {
  const styles = useStyles();
  const { colors } = useTheme();
  if (!items.length) return <Body muted>За этот период заказов нет.</Body>;
  const max = Math.max(1, ...items.map((item) => item.count));
  return (
    <View style={{ gap: 4 }}>
      {items.map((item) => (
        <View key={item.status} style={styles.statusRow} accessible accessibilityLabel={`${orderStatuses[item.status].label}: ${item.count}`}>
          <Text style={styles.statusLabel} numberOfLines={1}>{orderStatuses[item.status].label}</Text>
          <View style={{ flex: 1 }}><Meter share={item.count / max} color={colors.ink}/></View>
          <Text style={styles.statusCount}>{item.count}</Text>
        </View>
      ))}
    </View>
  );
}

function Meter({ share, color }: { share: number; color: string }) {
  const styles = useStyles();
  return <View style={styles.track}><View style={[styles.fill, { width: `${Math.max(share > 0 ? 3 : 0, share * 100)}%`, backgroundColor: color }]}/></View>;
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  bleed: { marginHorizontal: -space.l, flexGrow: 0 },
  chips: { gap: 6, paddingHorizontal: space.l, paddingVertical: 4 },
  meta: { color: colors.muted, fontSize: 13 },
  card: { backgroundColor: colors.surface, borderRadius: radius.l, padding: 18, gap: 12, ...cardShadow(scheme) },
  darkCard: { backgroundColor: colors.darkCard },
  onDark: { color: LIGHT },
  onDarkMuted: { color: LIGHT, opacity: 0.65 },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  blockTitle: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' },
  cardTitle: { fontSize: 15, fontWeight: '600' },
  hide: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  folded: { borderRadius: radius.l, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.line, paddingVertical: 14, paddingHorizontal: 18, gap: 2 },
  foldedTitle: { fontSize: 15, fontWeight: '600' },
  heroValue: { color: LIGHT, fontSize: 38, lineHeight: 44, fontWeight: '500', letterSpacing: -1.2, fontVariant: ['tabular-nums'] },
  heroNote: { color: LIGHT, fontSize: 13, opacity: 0.65 },
  tiles: { flexDirection: 'row', gap: space.s },
  tile: { flex: 1, borderRadius: radius.m, padding: 14, gap: 2 },
  tileLabel: { color: colors.tileInk, fontSize: 12, fontWeight: '600', opacity: 0.75 },
  tileValue: { color: colors.tileInk, fontSize: 28, fontWeight: '500', letterSpacing: -0.6, fontVariant: ['tabular-nums'] },
  tileNote: { color: colors.tileInk, fontSize: 12, opacity: 0.75 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rank: { width: 18, color: colors.muted, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  rankSpace: { width: 18 },
  topName: { flex: 1, fontSize: 15, fontWeight: '600' },
  topAmount: { fontSize: 15, fontWeight: '500', fontVariant: ['tabular-nums'] },
  topTimes: { color: colors.muted, fontSize: 12, minWidth: 52, textAlign: 'right', fontVariant: ['tabular-nums'] },
  big: { fontSize: 30, fontWeight: '500', letterSpacing: -0.8 },
  legend: { flexDirection: 'row', gap: space.l },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  readout: { fontSize: 14, fontWeight: '600' },
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 2 },
  day: { flex: 1, alignItems: 'center', gap: 4 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, borderRadius: 6, paddingHorizontal: 2 },
  barsActive: { backgroundColor: colors.soft },
  bar: { width: 6, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  dayLabel: { color: colors.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  dayLabelActive: { color: colors.ink, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: 4 },
  statusLabel: { fontSize: 14, width: 128 },
  statusCount: { fontSize: 14, fontWeight: '700', width: 28, textAlign: 'right', fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.soft, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 }
}));
