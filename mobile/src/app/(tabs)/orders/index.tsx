import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { OrderListItem } from '@df/types';
import { money, orderStatuses, vehicleName } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme, type Palette } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Chip, Heading, Loading, Notice, Screen } from '@/ui';
import { RoundButton } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Plate } from '@/ui/plate';
import { Text, TextInput } from '@/ui/text';

type Filter = 'mine' | 'all' | 'active' | 'ready' | 'closed';
const LIGHT = '#F4F4F2';

/** What the order waits for: a decision at the front desk, or the master's hands. */
const waitsForDecision = (order: OrderListItem) => order.status === 'INTAKE' || order.status === 'ESTIMATE_DRAFT' || (order.status === 'APPROVED' && !order.masterMemberId);
const dotOf = (colors: Palette, order: OrderListItem) => ({ INTAKE: colors.accent, ESTIMATE_DRAFT: colors.warn, APPROVED: colors.ok, IN_PROGRESS: colors.ok, QC: colors.ok, READY: colors.ok, CLOSED: colors.muted })[order.status];
const shortName = (name: string) => { const [first, last] = name.split(/\s+/); return last ? `${first[0]}. ${last}` : name; };
const open = (item: OrderListItem) => router.push({ pathname: '/orders/[id]', params: { id: item.id, title: item.vehicle.plate, bodyType: item.vehicle.bodyType ?? '', subtitle: `${vehicleName(item.vehicle)} · ${item.customer.name}` } });

export default function OrdersScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const session = useSignedIn();
  const isExecutor = session.capabilities.acceptAssignments;
  // An order executor without front-desk rights starts on their own queue, as in the web app.
  const [filter, setFilter] = useState<Filter>(isExecutor && !session.capabilities.manageBookings ? 'mine' : 'all');
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  const { data, error, reload, refresh, refreshing } = useResource(useCallback((signal: AbortSignal) => api.listOrders(signal), [api]));
  const items = data?.items ?? null;
  // Each time the tab comes into view (back from an order, intake, a booking turned into an order): a fresh list.
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const isMine = useCallback((item: OrderListItem) => session.actor.memberId ? item.masterMemberId === session.actor.memberId : item.masterName === session.actor.displayName, [session]);
  const search = query.replace(/\s/g, '').toLocaleUpperCase('ru-RU');
  const visible = useMemo(() => (items ?? []).filter((item) =>
    (filter === 'all' ? true : filter === 'mine' ? isMine(item) : orderStatuses[item.status].group === filter)
    && (!search || item.vehicle.plate.replace(/\s/g, '').toLocaleUpperCase('ru-RU').includes(search) || item.customer.name.toLocaleUpperCase('ru-RU').includes(search))), [items, filter, isMine, search]);

  if (!items && !error) return <Loading label="Загружаем заказы…"/>;

  const count = (group: Filter) => (items ?? []).filter((item) => group === 'all' || orderStatuses[item.status].group === group).length;
  const filters: { id: Filter; label: string }[] = [
    ...(isExecutor ? [{ id: 'mine' as const, label: `Мои ${(items ?? []).filter(isMine).length}` }] : []),
    { id: 'all', label: `Все ${count('all')}` }, { id: 'active', label: `В работе ${count('active')}` }, { id: 'ready', label: `К выдаче ${count('ready')}` }, { id: 'closed', label: `Закрытые ${count('closed')}` }
  ];
  const ready = visible.filter((item) => item.status === 'READY');
  const deciding = visible.filter(waitsForDecision);
  const working = visible.filter((item) => !waitsForDecision(item) && item.status !== 'READY' && item.status !== 'CLOSED');
  const closed = visible.filter((item) => item.status === 'CLOSED');

  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 18 }}
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.ink} colors={[colors.accent]} progressBackgroundColor={colors.surface} onRefresh={reload}/>}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.meta}>{session.tenant.name}</Text>
          <Text style={styles.h1} accessibilityRole="header">Заказы</Text>
        </View>
        <RoundButton icon={searching ? 'close' : 'search'} label={searching ? 'Закрыть поиск' : 'Найти по номеру'} onPress={() => { setSearching(!searching); setQuery(''); }}/>
      </View>
      {searching ? <View style={styles.search}>
        <Icon name="search" size={18} color={colors.muted}/>
        <TextInput value={query} onChangeText={setQuery} autoFocus autoCapitalize="characters" placeholder="Госномер или клиент" style={styles.searchInput}/>
      </View> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.bleed}>
        {filters.map((item) => <Chip key={item.id} label={item.label} selected={filter === item.id} onPress={() => setFilter(item.id)}/>)}
      </ScrollView>
      {error ? <><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></> : null}

      {ready.map((item) => (
        <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`Готова к выдаче: ${vehicleName(item.vehicle)}, ${item.vehicle.plate}`} onPress={() => open(item)} style={styles.ready} testID={`order-${item.id}`}>
          <View style={styles.readyTop}><Text style={styles.readyNote}>Готова к выдаче</Text><Plate plate={item.vehicle.plate}/></View>
          <View style={styles.readyMiddle}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.readyTitle} numberOfLines={1}>{vehicleName(item.vehicle)}</Text>
              <Text style={styles.readyNote} numberOfLines={1}>{item.customer.name}{item.masterName ? ` · мастер ${shortName(item.masterName)}` : ''}</Text>
            </View>
            {item.totalAmountMinor !== null ? <Text style={styles.readyTitle}>{money(item.totalAmountMinor)}</Text> : null}
          </View>
          {session.capabilities.closeOrders ? <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/orders/handover/[id]', params: { id: item.id, title: item.vehicle.plate, subtitle: `${vehicleName(item.vehicle)} · ${item.customer.name}` } })} style={styles.readyButton}>
            <Text style={styles.readyButtonText}>Выдать автомобиль</Text><Icon name="chevronRight" size={16} color="#121212"/>
          </Pressable> : null}
        </Pressable>
      ))}

      <Group title="Ждут решения" items={deciding} isMine={isMine}/>
      <Group title="В работе" items={working} isMine={isMine}/>
      <Group title="Закрытые" items={closed} isMine={isMine}/>
      {items && !visible.length ? <Body muted style={{ textAlign: 'center', marginTop: space.xl }}>{search ? 'Ничего не нашлось.' : filter === 'mine' ? 'Вам пока не назначено заказов.' : 'Заказов нет.'}</Body> : null}
    </Screen>
  );
}

function Group({ title, items, isMine }: { title: string; items: OrderListItem[]; isMine: (item: OrderListItem) => boolean }) {
  const styles = useStyles();
  if (!items.length) return null;
  return (
    <View style={{ gap: 10 }}>
      <View style={styles.sectionHead}><Heading>{title}</Heading><Text style={styles.meta}>{items.length}</Text></View>
      {items.map((item) => <OrderRow key={item.id} item={item} mine={isMine(item)}/>)}
    </View>
  );
}

function OrderRow({ item, mine }: { item: OrderListItem; mine: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const status = orderStatuses[item.status];
  const who = item.masterName ? `${mine ? 'вы' : shortName(item.masterName)}` : item.status === 'APPROVED' ? 'назначьте мастера' : 'мастер не назначен';
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${vehicleName(item.vehicle)}, ${item.vehicle.plate}, ${status.label}`} onPress={() => open(item)} style={styles.row} testID={`order-${item.id}`}>
      <View style={styles.rowTop}>
        <Plate plate={item.vehicle.plate}/>
        <View style={styles.status}><View style={[styles.dot, { backgroundColor: dotOf(colors, item) }]}/><Text style={styles.statusText}>{status.label}</Text></View>
      </View>
      <View style={styles.rowBottom}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={styles.vehicle} numberOfLines={1}>{vehicleName(item.vehicle)}</Text>
          <Text style={styles.meta} numberOfLines={1}>{item.customer.name} · {item.masterName ? `мастер ${who}` : who}</Text>
        </View>
        <Text style={styles.total}>{item.totalAmountMinor !== null ? money(item.totalAmountMinor) : '—'}</Text>
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  h1: { fontSize: 30, lineHeight: 36, fontWeight: '500', letterSpacing: -0.9 },
  meta: { color: colors.muted, fontSize: 13 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 52, paddingHorizontal: 18, borderRadius: 26, backgroundColor: colors.surface, ...cardShadow(scheme) },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  bleed: { marginHorizontal: -space.l, flexGrow: 0 },
  chips: { gap: 6, paddingHorizontal: space.l, paddingVertical: 4 },
  ready: { borderRadius: radius.l, backgroundColor: colors.darkCard, padding: 18, gap: space.l, ...cardShadow(scheme) },
  readyTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  readyMiddle: { flexDirection: 'row', alignItems: 'flex-end', gap: space.m },
  readyTitle: { color: LIGHT, fontSize: 22, fontWeight: '500', letterSpacing: -0.4 },
  readyNote: { color: LIGHT, fontSize: 13, opacity: 0.7 },
  readyButton: { height: 48, borderRadius: 24, backgroundColor: LIGHT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  readyButtonText: { color: '#121212', fontSize: 15, fontWeight: '700' },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  row: { borderRadius: 24, backgroundColor: colors.surface, paddingVertical: 14, paddingHorizontal: space.l, gap: 10, ...cardShadow(scheme) },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  status: { height: 24, paddingHorizontal: 10, borderRadius: 12, backgroundColor: colors.soft, flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: '600' },
  rowBottom: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  vehicle: { fontSize: 17, fontWeight: '600' },
  total: { fontSize: 20, fontWeight: '500', letterSpacing: -0.4, fontVariant: ['tabular-nums'] }
}));
