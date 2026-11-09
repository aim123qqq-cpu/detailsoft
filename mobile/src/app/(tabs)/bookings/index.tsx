import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BookingListItem } from '@df/types';
import { BookingRow, DayTimeline, Segmented, WeekStrip, startIntake } from '@/features/booking-ui';
import { addDays, dayKey, dayOfMonth, duration, longDay, monthShort, timeOf, vehicleName, weekday } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Loading, Notice, Screen } from '@/ui';
import { ComingSoon } from '@/ui/coming-soon';
import { Icon } from '@/ui/icons';
import { Plate } from '@/ui/plate';
import { ButtonPair, Sheet } from '@/ui/sheet';
import { Text } from '@/ui/text';

const plural = (count: number, one: string, few: string, many: string) => {
  const last = count % 10; const lastTwo = count % 100;
  return lastTwo >= 11 && lastTwo <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
};
const capital = (text: string) => text.replace(/^./, (letter) => letter.toUpperCase());
/** «Сегодня, пн 9 нояб.», «Завтра, вт 10 нояб.», «Ср 11 нояб.». */
const dayHeading = (key: string, today: string) => {
  const short = `${weekday(key)} ${dayOfMonth(key)} ${monthShort(key)}.`;
  return key === today ? `Сегодня, ${short}` : key === addDays(today, 1) ? `Завтра, ${short}` : capital(short);
};

/** The schedule: overdue visits and upcoming ones by day, or one day of a week as a timeline. */
export default function BookingsScreen() {
  const session = useSignedIn();
  if (!session.capabilities.manageBookings && !session.capabilities.manageIntake) {
    return <ComingSoon title="Записи" text="Расписание доступно администратору и приёмщику." noAccess/>;
  }
  return <Schedule/>;
}

function Schedule() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { api } = useSession();
  const session = useSignedIn();
  const insets = useSafeAreaInsets();
  const timeZone = session.tenant.timezone;
  const today = dayKey(new Date(), timeZone);
  const [mode, setMode] = useState<'list' | 'day'>('list');
  const [day, setDay] = useState(today);
  const [weekStart, setWeekStart] = useState(today);
  const [noShow, setNoShow] = useState<BookingListItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const lists = useResource(useCallback(async (signal: AbortSignal) => {
    const [upcoming, overdue] = await Promise.all([api.listBookings('upcoming', signal), api.listBookings('overdue', signal)]);
    return { upcoming: upcoming.items, overdue: overdue.items };
  }, [api]));
  const week = useResource(useCallback((signal: AbortSignal) => api.bookingCalendar(weekStart, addDays(weekStart, 6), signal), [api, weekStart]));

  // Each time the tab comes into view (a new booking, intake, changes on another phone): fresh lists.
  const { refresh: refreshLists } = lists;
  const { refresh: refreshWeek } = week;
  useFocusEffect(useCallback(() => { refreshLists(); refreshWeek(); }, [refreshLists, refreshWeek]));

  const canBook = session.capabilities.manageBookings;
  const canIntake = session.capabilities.manageIntake;
  const refresh = <RefreshControl refreshing={lists.refreshing || week.refreshing} tintColor={colors.ink} colors={[colors.accent]} progressBackgroundColor={colors.surface}
    onRefresh={() => { lists.reload(); week.reload(); }}/>;

  const arrive = async (item: BookingListItem) => {
    setBusy(`arrive-${item.id}`); setActionError('');
    try { await startIntake(api, item); } catch (failure) { setActionError((failure as Error).message); } finally { setBusy(null); }
  };
  const markNoShow = async () => {
    if (!noShow) return;
    setBusy('noshow'); setActionError('');
    try { await api.updateBooking(noShow.id, { status: 'NO_SHOW' }); setNoShow(null); lists.reload(); week.reload(); }
    catch (failure) { setActionError((failure as Error).message); setNoShow(null); }
    finally { setBusy(null); }
  };

  const head = (
    <View style={[styles.head, { marginTop: insets.top }]}>
      <Text style={styles.h1} accessibilityRole="header">Записи</Text>
      {canBook ? <Pressable accessibilityRole="button" accessibilityLabel="Новая запись" onPress={() => router.navigate('/new')} style={styles.newButton}>
        <Icon name="plus" size={16} color={colors.pillInk} strokeWidth={2.2}/>
        <Text style={styles.newText}>Новая</Text>
      </Pressable> : null}
    </View>
  );
  const switcher = <Segmented value={mode} onChange={setMode} options={[{ value: 'list', label: 'Список' }, { value: 'day', label: 'По дням' }]}/>;
  const sheet = (
    <Sheet visible={Boolean(noShow)} title="Отметить неявку?" note="Время освободится, запись останется в истории клиента." onClose={() => setNoShow(null)}>
      {noShow ? <View style={styles.sheetItem}>
        <Plate plate={noShow.vehicle.plate}/>
        <View style={{ flex: 1 }}>
          <Text style={styles.sheetName}>{noShow.customer.name}</Text>
          <Text style={styles.meta}>{weekday(dayKey(noShow.startAt, timeZone))}, {dayOfMonth(dayKey(noShow.startAt, timeZone))} {monthShort(dayKey(noShow.startAt, timeZone))}., {timeOf(noShow.startAt, timeZone)}</Text>
        </View>
      </View> : null}
      <ButtonPair>
        <Button title="Назад" tone="secondary" style={{ flex: 1 }} onPress={() => setNoShow(null)}/>
        <Button title="Не приехал" style={{ flex: 1 }} busy={busy === 'noshow'} onPress={() => void markNoShow()}/>
      </ButtonPair>
    </Sheet>
  );

  if (mode === 'list') {
    if (!lists.data && !lists.error) return <Loading label="Загружаем записи…"/>;
    const groups = new Map<string, BookingListItem[]>();
    // An overdue visit is in the dark card above, not again under its day.
    const overdueIds = new Set((lists.data?.overdue ?? []).map((item) => item.id));
    for (const item of (lists.data?.upcoming ?? []).filter((entry) => !overdueIds.has(entry.id))) {
      const key = dayKey(item.startAt, timeZone);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    const overdue = lists.data?.overdue ?? [];
    return (
      <Screen refreshControl={refresh}>
        {head}
        {switcher}
        {lists.error ? <><Notice>{lists.error}</Notice><Button title="Повторить" tone="secondary" onPress={lists.reload}/></> : null}
        {actionError ? <Notice>{actionError}</Notice> : null}
        {overdue.length ? <View style={styles.overdue}>
          <View style={styles.overdueHead}>
            <Text style={styles.overdueTitle}>Требуют отметки · {overdue.length}</Text>
          </View>
          <Text style={styles.overdueText}>Время визита прошло: начните приёмку или отметьте неявку.</Text>
          {overdue.map((item) => (
            <View key={item.id} style={{ gap: space.s }}>
              <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/bookings/[id]', params: { id: item.id, item: JSON.stringify(item) } })} style={styles.overdueItem}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.overdueName} numberOfLines={1}>{dayKey(item.startAt, timeZone) === today ? '' : `${dayOfMonth(dayKey(item.startAt, timeZone))} ${monthShort(dayKey(item.startAt, timeZone))}, `}{timeOf(item.startAt, timeZone)} · {item.customer.name}</Text>
                  <Text style={styles.overdueMeta} numberOfLines={1}>{vehicleName(item.vehicle)} · {item.vehicle.plate}</Text>
                </View>
                <Icon name="chevronRight" size={18} color="#F4F4F2"/>
              </Pressable>
              <View style={styles.overdueButtons}>
                {canIntake ? <Button title="Начать приёмку" style={styles.lightButton} ink="#121212" busy={busy === `arrive-${item.id}`} onPress={() => void arrive(item)}/> : null}
                {canBook ? <Button title="Не приехал" style={styles.dimButton} ink="#F4F4F2" onPress={() => setNoShow(item)}/> : null}
              </View>
            </View>
          ))}
        </View> : null}
        {[...groups].map(([key, items]) => (
          <View key={key} style={styles.group}>
            <View style={styles.groupHead}>
              <Text style={styles.groupTitle} accessibilityRole="header">{dayHeading(key, today)}</Text>
              <Text style={styles.meta}>{items.length} {plural(items.length, 'запись', 'записи', 'записей')}</Text>
            </View>
            {items.map((item) => <BookingRow key={item.id} item={item} timeZone={timeZone}/>)}
          </View>
        ))}
        {lists.data && !lists.data.upcoming.length && !overdue.length ? <View style={styles.empty}>
          <Body muted style={{ textAlign: 'center' }}>{canBook ? 'Записей пока нет.' : 'Записи появятся, когда администратор их создаст.'}</Body>
          {canBook ? <Button title="Создать запись" onPress={() => router.navigate('/new')}/> : null}
        </View> : null}
        {sheet}
      </Screen>
    );
  }

  const items = (week.data?.items ?? []).filter((item) => dayKey(item.startAt, timeZone) === day);
  const counts: Record<string, number> = {};
  for (const item of week.data?.items ?? []) if (item.status !== 'CANCELLED') {
    const key = dayKey(item.startAt, timeZone);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const active = items.filter((item) => item.status !== 'CANCELLED');
  const busyMinutes = active.reduce((sum, item) => sum + item.estimatedDurationMinutes, 0);
  const shift = (amount: number) => { const next = addDays(weekStart, amount); setWeekStart(next); setDay(next); };

  return (
    <Screen refreshControl={refresh}>
      {head}
      {switcher}
      <WeekStrip from={weekStart} value={day} onChange={setDay} today={today} counts={counts} onShift={shift}/>
      {week.error ? <><Notice>{week.error}</Notice><Button title="Повторить" tone="secondary" onPress={week.reload}/></> : null}
      {!week.data && !week.error ? <Body muted>Загружаем…</Body> : null}
      {week.data ? <>
        <View style={styles.groupHead}>
          <Text style={styles.groupTitle} accessibilityRole="header">{capital(longDay(day).split(',')[0])}</Text>
          <Text style={styles.meta}>{active.length ? `${active.length} ${plural(active.length, 'запись', 'записи', 'записей')} · загрузка ${duration(busyMinutes)}` : 'записей нет'}</Text>
        </View>
        <DayTimeline items={items} timeZone={timeZone} isToday={day === today}/>
      </> : null}
    </Screen>
  );
}

const useStyles = makeStyles((colors) => StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  h1: { fontSize: 32, lineHeight: 38, fontWeight: '500', letterSpacing: -1 },
  newButton: { height: 44, paddingHorizontal: 18, borderRadius: 22, backgroundColor: colors.pill, flexDirection: 'row', alignItems: 'center', gap: 6 },
  newText: { color: colors.pillInk, fontSize: 14, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 13 },
  overdue: { borderRadius: radius.l, backgroundColor: colors.darkCard, padding: space.l, gap: 10 },
  overdueHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  overdueTitle: { color: colors.darkCardInk, fontSize: 18, fontWeight: '600' },
  overdueText: { color: colors.darkCardInk, fontSize: 13, opacity: 0.7 },
  overdueItem: { flexDirection: 'row', alignItems: 'center', gap: space.m, padding: space.m, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.07)' },
  overdueName: { color: colors.darkCardInk, fontSize: 15, fontWeight: '600' },
  overdueMeta: { color: colors.darkCardInk, fontSize: 12, opacity: 0.6 },
  overdueButtons: { flexDirection: 'row', gap: space.s },
  lightButton: { flex: 1, minHeight: 44, backgroundColor: '#F4F4F2' },
  dimButton: { flex: 1, minHeight: 44, backgroundColor: 'rgba(255,255,255,0.1)' },
  group: { gap: space.m },
  groupHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  groupTitle: { fontSize: 18, fontWeight: '600' },
  empty: { gap: space.m, marginTop: space.xl },
  sheetItem: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.m, paddingHorizontal: 14, borderRadius: radius.m, backgroundColor: colors.soft },
  sheetName: { fontSize: 15, fontWeight: '600' }
}));
