import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useFocusEffect } from 'expo-router';
import type { BookingListItem } from '@df/types';
import { BookingRow, DateStrip, Segmented } from '@/features/booking-ui';
import { addDays, dayKey, dayTitle, duration } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Label, Loading, Notice, Screen } from '@/ui';
import { ComingSoon } from '@/ui/coming-soon';

/** The schedule: overdue visits and upcoming ones by day, or one day of a week. */
export default function BookingsScreen() {
  const session = useSignedIn();
  if (!session.capabilities.manageBookings && !session.capabilities.manageIntake) {
    return <ComingSoon title="Записи" text="Расписание доступно администратору и приёмщику." noAccess/>;
  }
  return <Schedule/>;
}

function Schedule() {
  const { api } = useSession();
  const session = useSignedIn();
  const timeZone = session.tenant.timezone;
  const today = dayKey(new Date(), timeZone);
  const [mode, setMode] = useState<'list' | 'day'>('list');
  const [day, setDay] = useState(today);
  const [weekStart, setWeekStart] = useState(today);

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
  const header = <Stack.Screen options={{ headerRight: canBook ? () => (
    <Pressable accessibilityRole="button" accessibilityLabel="Новая запись" hitSlop={10} onPress={() => router.navigate('/new')}>
      <Text style={styles.headerAction}>＋ Новая</Text>
    </Pressable>
  ) : undefined }}/>;

  const refresh = <RefreshControl refreshing={lists.refreshing || week.refreshing} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface}
    onRefresh={() => { lists.reload(); week.reload(); }}/>;

  if (mode === 'list') {
    if (!lists.data && !lists.error) return <>{header}<Loading label="Загружаем записи…"/></>;
    const groups = new Map<string, BookingListItem[]>();
    for (const item of lists.data?.upcoming ?? []) {
      const key = dayKey(item.startAt, timeZone);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    return (
      <Screen refreshControl={refresh}>
        {header}
        <Segmented value={mode} onChange={setMode} options={[{ value: 'list', label: 'Список' }, { value: 'day', label: 'По дням' }]}/>
        {lists.error ? <><Notice>{lists.error}</Notice><Button title="Повторить" tone="secondary" onPress={lists.reload}/></> : null}
        {lists.data?.overdue.length ? <View style={styles.group}>
          <Label>Требуют отметки · {lists.data.overdue.length}</Label>
          <Body muted>Время визита прошло: начните приёмку или отметьте неявку.</Body>
          {lists.data.overdue.map((item) => <BookingRow key={item.id} item={item} timeZone={timeZone}/>)}
        </View> : null}
        {[...groups].map(([key, items]) => (
          <View key={key} style={styles.group}>
            <Text style={styles.dayTitle}>{dayTitle(key, today)}</Text>
            {items.map((item) => <BookingRow key={item.id} item={item} timeZone={timeZone}/>)}
          </View>
        ))}
        {lists.data && !lists.data.upcoming.length && !lists.data.overdue.length ? <View style={styles.empty}>
          <Body muted style={{ textAlign: 'center' }}>{canBook ? 'Записей пока нет.' : 'Записи появятся, когда администратор их создаст.'}</Body>
          {canBook ? <Button title="Создать запись" onPress={() => router.navigate('/new')}/> : null}
        </View> : null}
      </Screen>
    );
  }

  const items = (week.data?.items ?? []).filter((item) => dayKey(item.startAt, timeZone) === day);
  const counts: Record<string, number> = {};
  for (const item of week.data?.items ?? []) if (item.status !== 'CANCELLED') {
    const key = dayKey(item.startAt, timeZone);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const busyMinutes = items.filter((item) => item.status !== 'CANCELLED').reduce((sum, item) => sum + item.estimatedDurationMinutes, 0);
  const shift = (amount: number) => { const next = addDays(weekStart, amount); setWeekStart(next); setDay(next); };

  return (
    <Screen refreshControl={refresh}>
      {header}
      <Segmented value={mode} onChange={setMode} options={[{ value: 'list', label: 'Список' }, { value: 'day', label: 'По дням' }]}/>
      <View style={styles.weekBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Предыдущая неделя" hitSlop={8} onPress={() => shift(-7)}><Text style={styles.arrow}>‹</Text></Pressable>
        <Text style={styles.weekTitle}>{dayTitle(day, today)}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Следующая неделя" hitSlop={8} onPress={() => shift(7)}><Text style={styles.arrow}>›</Text></Pressable>
      </View>
      <DateStrip from={weekStart} days={7} value={day} onChange={setDay} today={today} counts={week.data ? counts : undefined}/>
      {week.error ? <><Notice>{week.error}</Notice><Button title="Повторить" tone="secondary" onPress={week.reload}/></> : null}
      {!week.data && !week.error ? <Body muted>Загружаем…</Body> : null}
      {week.data ? (items.length ? <>
        <Body muted>{items.length} {items.length === 1 ? 'запись' : items.length < 5 ? 'записи' : 'записей'} · занято {duration(busyMinutes)}</Body>
        {items.map((item) => <BookingRow key={item.id} item={item} timeZone={timeZone}/>)}
      </> : <Body muted style={styles.emptyDay}>На этот день записей нет.</Body>) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerAction: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  group: { gap: space.s },
  dayTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: space.s, textTransform: 'capitalize' },
  empty: { gap: space.m, marginTop: space.xl },
  weekBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  weekTitle: { color: colors.text, fontSize: 17, fontWeight: '800', textTransform: 'capitalize' },
  arrow: { color: colors.primary, fontSize: 30, lineHeight: 32, paddingHorizontal: space.m },
  emptyDay: { textAlign: 'center', marginTop: space.l }
});
