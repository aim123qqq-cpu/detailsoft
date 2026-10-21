import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import type { OrderListItem } from '@df/types';
import { money, orderStatuses, shortDate, vehicleName } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { useResource } from '@/lib/use-resource';
import { colors, radius, space } from '@/lib/theme';
import { Body, Button, Chip, Loading, Notice, Pill } from '@/ui';
import { FirstSteps } from '@/features/first-steps';
import { SyncBanner } from '@/features/sync-banner';

type Filter = 'mine' | 'all' | 'active' | 'ready' | 'closed';

export default function OrdersScreen() {
  const { api } = useSession();
  const session = useSignedIn();
  const isExecutor = session.capabilities.acceptAssignments;
  // An order executor without front-desk rights starts on their own queue, as in the web app.
  const [filter, setFilter] = useState<Filter>(isExecutor && !session.capabilities.manageBookings ? 'mine' : 'all');

  const { data, error, reload, refresh, refreshing } = useResource(useCallback((signal: AbortSignal) => api.listOrders(signal), [api]));
  const items = data?.items ?? null;
  // Each time the tab comes into view (back from an order, intake, a booking turned into an order): a fresh list.
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const isMine = useCallback((item: OrderListItem) => session.actor.memberId ? item.masterMemberId === session.actor.memberId : item.masterName === session.actor.displayName, [session]);
  const visible = useMemo(() => (items ?? []).filter((item) =>
    filter === 'all' ? true : filter === 'mine' ? isMine(item) : orderStatuses[item.status].group === filter), [items, filter, isMine]);

  if (!items && !error) return <Loading label="Загружаем заказы…"/>;

  const filters: { id: Filter; label: string }[] = [
    ...(isExecutor ? [{ id: 'mine' as const, label: `Мои ${(items ?? []).filter(isMine).length}` }] : []),
    { id: 'all', label: 'Все' }, { id: 'active', label: 'В работе' }, { id: 'ready', label: 'К выдаче' }, { id: 'closed', label: 'Закрытые' }
  ];

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      data={visible}
      keyExtractor={(item) => item.id}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface}
        onRefresh={reload}/>}
      ListHeaderComponent={
        <View style={{ gap: space.m, marginBottom: space.s }}>
          <SyncBanner/>
          <FirstSteps/>
          {error ? <><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></> : null}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s }}>
            {filters.map((item) => <Chip key={item.id} label={item.label} selected={filter === item.id} onPress={() => setFilter(item.id)}/>)}
          </ScrollView>
        </View>
      }
      ListEmptyComponent={items ? <Body muted style={{ textAlign: 'center', marginTop: space.xl }}>{filter === 'mine' ? 'Вам пока не назначено заказов.' : 'Заказов нет.'}</Body> : undefined}
      ItemSeparatorComponent={() => <View style={{ height: space.s }}/>}
      renderItem={({ item }) => <OrderRow item={item} mine={isMine(item)}/>}
    />
  );
}

function OrderRow({ item, mine }: { item: OrderListItem; mine: boolean }) {
  const status = orderStatuses[item.status];
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${vehicleName(item.vehicle)}, ${item.vehicle.plate}, ${status.label}`}
      onPress={() => router.push({ pathname: '/orders/[id]', params: { id: item.id, title: item.vehicle.plate, bodyType: item.vehicle.bodyType ?? '', subtitle: `${vehicleName(item.vehicle)} · ${item.customer.name}` } })}
      android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={styles.row} testID={`order-${item.id}`}>
      <View style={styles.rowTop}>
        <Text style={styles.plate}>{item.vehicle.plate}</Text>
        <Pill label={status.label} tone={status.group === 'ready' ? 'ok' : status.group === 'closed' ? 'neutral' : 'accent'}/>
      </View>
      <Text style={styles.vehicle}>{vehicleName(item.vehicle)}</Text>
      <Text style={styles.meta}>{item.customer.name} · {shortDate(item.createdAt)}</Text>
      <View style={styles.rowBottom}>
        <Text style={styles.meta}>{item.masterName ? `${mine ? 'Вы · ' : ''}${item.masterName}` : 'Мастер не назначен'}</Text>
        {item.totalAmountMinor !== null ? <Text style={styles.total}>{money(item.totalAmountMinor)}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.ground },
  content: { padding: space.l, paddingBottom: space.xxl },
  row: { backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, gap: 4, overflow: 'hidden' },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  plate: { color: colors.primary, fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
  vehicle: { color: colors.text, fontSize: 18, fontWeight: '700', marginTop: 4 },
  meta: { color: colors.muted, fontSize: 14 },
  rowBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  total: { color: colors.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] }
});
