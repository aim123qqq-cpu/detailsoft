import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { carLayout, normalizeBodyType } from '@df/shared/carLayouts';
import type { Booking, EstimateLineInput, IntakeFinding, ServiceOffering, WorkOrder } from '@df/types';
import { CarDiagram, findingMarks, severityColor } from '@/features/car-diagram';
import { duration, money } from '@/lib/format';
import { useSession } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Button, Card, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { DOCK_SPACE, Dock } from '@/ui/sheet';
import { Text, TextInput } from '@/ui/text';

type Section = 'booking' | 'intake' | 'added';
type Line = {
  key: string;
  sourceType: EstimateLineInput['sourceType'];
  sourceId: string | null;
  name: string;
  /** Rubles as typed. */
  amount: string;
  durationMinutes: number;
  reason: string | null;
  section: Section;
  /** The note under the name: where the line came from, how long it takes. */
  origin: string;
  /** The intake finding a recommendation answers, for the dot of its severity. */
  severity?: IntakeFinding['severity'];
};

const rubles = (amountMinor: number) => (amountMinor ? String(Math.round(amountMinor / 100)) : '');
const minor = (amount: string) => Math.round(Number(amount.replace(/[^\d]/g, '') || '0') * 100);
const RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

/** A new estimate version: the booking's services, the intake recommendations with a price, more from the catalog. */
export default function EstimateScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const { api } = useSession();
  const { data, error, reload } = useResource(useCallback(async (signal: AbortSignal) => {
    const order = await api.getOrder(id, signal);
    const [booking, catalog] = await Promise.all([
      order.bookingId ? api.getBooking(order.bookingId, signal).catch(() => null) : Promise.resolve(null),
      api.services(order.vehicleId, signal).catch(() => null)
    ]);
    return { order, booking, catalog };
  }, [api, id]));

  if (!data && !error) return <Loading label="Готовим смету…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  return <EstimateForm key={data.order.id} order={data.order} booking={data.booking} offers={data.catalog?.categories.flatMap((category) => category.items) ?? []} title={title}/>;
}

function initialLines(order: WorkOrder, booking: Booking | null): Line[] {
  // The previous version (after a refusal) is the starting point; otherwise the booking and the intake.
  const previous = order.estimateVersions.at(-1);
  if (previous) return previous.lines.map((line) => ({
    key: line.id, sourceType: line.sourceType, sourceId: line.sourceId ?? null, name: line.name, amount: rubles(line.amountMinor),
    durationMinutes: line.durationMinutes, reason: line.reason ?? null, section: line.sourceType === 'recommendation' ? 'intake' : line.sourceType === 'custom' ? 'added' : 'booking',
    origin: `из версии ${previous.version}`
  }));
  const worst = order.intake?.findings.reduce<IntakeFinding['severity'] | undefined>((top, finding) => (!top || RANK[finding.severity] > RANK[top] ? finding.severity : top), undefined);
  const fromBooking: Line[] = (booking?.lines ?? []).filter((line) => !line.excluded).map((line) => ({
    key: `${line.type}-${line.id}`, sourceType: line.type, sourceId: line.id, name: line.name, amount: rubles(line.amountMinor),
    durationMinutes: line.durationMinutes, reason: null, section: 'booking', origin: !line.pricingMode || line.pricingMode === 'fixed' ? duration(line.durationMinutes) : `${duration(line.durationMinutes)} · цена после осмотра`
  }));
  const fromIntake: Line[] = (order.intake?.recommendations ?? []).map((item, index) => ({
    key: `recommendation-${index}`, sourceType: 'recommendation', sourceId: null, name: item.title, amount: '', durationMinutes: 25,
    reason: item.reason, section: 'intake', origin: item.reason, severity: worst
  }));
  return [...fromBooking, ...fromIntake];
}

function EstimateForm({ order, booking, offers, title }: { order: WorkOrder; booking: Booking | null; offers: ServiceOffering[]; title?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const [lines, setLines] = useState<Line[]>(() => initialLines(order, booking));
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const marks = useMemo(() => findingMarks(order.intake?.findings ?? []), [order.intake]);
  const layout = useMemo(() => carLayout(normalizeBodyType(order.intake?.bodyType)), [order.intake]);

  const patch = (key: string, change: Partial<Line>) => setLines((list) => list.map((line) => line.key === key ? { ...line, ...change } : line));
  const remove = (key: string) => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setLines((list) => list.filter((line) => line.key !== key)); };
  // A recommendation or an own work has no price of its own: it must be given one. A catalog line may stay free.
  const needsPrice = (line: Line) => (line.sourceType === 'recommendation' || line.sourceType === 'custom') && minor(line.amount) <= 0;
  const unpriced = lines.filter(needsPrice);
  const total = lines.reduce((sum, line) => sum + minor(line.amount), 0);
  const version = order.estimateVersions.length + 1;
  const taken = new Set(lines.map((line) => `${line.sourceType}:${line.sourceId}`));
  const search = query.trim().toLocaleLowerCase('ru-RU');
  const suggestions = offers.filter((item) => !taken.has(`${item.type}:${item.id}`) && (!search || item.name.toLocaleLowerCase('ru-RU').includes(search))).slice(0, search ? 8 : 3);

  const addOffer = (item: ServiceOffering) => {
    void Haptics.selectionAsync();
    setLines((list) => [...list, { key: `${item.type}-${item.id}`, sourceType: item.type, sourceId: item.id, name: item.name, amount: rubles(item.price.amountMinor),
      durationMinutes: item.durationMinutes, reason: null, section: 'added', origin: item.pricingMode === 'fixed' ? `${duration(item.durationMinutes)} · из каталога` : `${duration(item.durationMinutes)} · цена после осмотра` }]);
    setQuery('');
  };
  const addCustom = () => {
    setLines((list) => [...list, { key: `custom-${list.length}-${query.trim()}`, sourceType: 'custom', sourceId: null, name: query.trim(), amount: '', durationMinutes: 30, reason: null, section: 'added', origin: 'своя работа' }]);
    setQuery('');
  };
  const issue = async () => {
    setSaving(true); setError('');
    try {
      await api.createEstimate(order.id, lines.map((line) => ({
        sourceType: line.sourceType, sourceId: line.sourceId, name: line.name.trim(), amountMinor: minor(line.amount), durationMinutes: line.durationMinutes,
        ...(line.reason ? { reason: line.reason } : {})
      })));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (failure) {
      setError((failure as Error).message);
      setSaving(false);
    }
  };

  const sections: { id: Section; title: string; note: string }[] = [
    { id: 'booking', title: 'Из записи', note: 'клиент выбрал сам' },
    { id: 'intake', title: 'По осмотру', note: 'из приёмки' },
    { id: 'added', title: 'Добавлено', note: 'из каталога и свои работы' }
  ];

  return (
    <View style={styles.root}>
      <Screen contentStyle={{ paddingTop: insets.top + 18, paddingBottom: DOCK_SPACE + 24 + insets.bottom }}>
        <FlowHeader title={title ? `Смета · ${title}` : 'Смета'} note={`версия ${version}`}/>
        <Card style={styles.hero}>
          <View style={{ flex: 1, justifyContent: 'space-between', gap: space.m }}>
            <View style={{ gap: 2 }}>
              <Text style={styles.meta}>Версия {version}{order.estimateVersions.length ? ` · прошлая v${version - 1} не согласована` : ''}</Text>
              <Text style={styles.total} numberOfLines={1} adjustsFontSizeToFit>{money(total)}</Text>
            </View>
            {unpriced.length ? <Text style={styles.warning}>+ {unpriced.map((line) => line.name.toLowerCase()).join(', ')}, цена не указана</Text> : null}
          </View>
          {order.intake ? <View style={styles.mini}><CarDiagram layout={layout} marks={marks} width={56}/></View> : null}
        </Card>

        {sections.map((section) => {
          const own = lines.filter((line) => line.section === section.id);
          if (!own.length) return null;
          return (
            <View key={section.id} style={{ gap: space.m }}>
              <View style={styles.sectionHead}><Heading>{section.title}</Heading><Text style={styles.meta}>{section.note}</Text></View>
              {own.map((line) => {
                const priced = !needsPrice(line);
                return (
                  <Card key={line.key} style={{ gap: 10 }}>
                    <View style={styles.lineTop}>
                      <View style={{ flex: 1, gap: 3 }}>
                        <Text style={styles.lineName}>{line.name}</Text>
                        <View style={styles.originRow}>
                          {line.severity ? <View style={[styles.dot, { backgroundColor: severityColor(colors, line.severity) }]}/> : null}
                          <Text style={styles.meta} numberOfLines={2}>{line.origin}</Text>
                        </View>
                      </View>
                      <Pressable accessibilityRole="button" accessibilityLabel={`Убрать из сметы: ${line.name}`} hitSlop={6} onPress={() => remove(line.key)} style={styles.remove}>
                        <Icon name="close" size={16} color={colors.muted}/>
                      </Pressable>
                    </View>
                    <View style={styles.price}>
                      <Text style={styles.meta}>Цена</Text>
                      <TextInput value={line.amount} onChangeText={(value) => patch(line.key, { amount: value.replace(/[^\d]/g, '') })} keyboardType="number-pad"
                        placeholder="0" accessibilityLabel={`Сумма: ${line.name}`} style={styles.priceInput}/>
                      <Text style={styles.rub}>₽</Text>
                    </View>
                    {!priced ? <Text style={styles.warning}>Укажите цену или уберите строку</Text> : null}
                  </Card>
                );
              })}
            </View>
          );
        })}
        {!lines.length ? <Card><Text style={styles.meta}>В смете нет строк. Добавьте услугу из каталога или свою работу ниже.</Text></Card> : null}

        <View style={styles.sectionHead}><Heading>Можно предложить</Heading><Text style={styles.meta}>{search ? 'по поиску' : 'из каталога'}</Text></View>
        {suggestions.map((item) => (
          <View key={`${item.type}-${item.id}`} style={styles.offer}>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={styles.lineName}>{item.name}</Text>
              <Text style={styles.meta}>{duration(item.durationMinutes)} · {item.pricingMode === 'fixed' ? 'из каталога' : 'цена после осмотра'}</Text>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`Добавить в смету: ${item.name}`} onPress={() => addOffer(item)} style={styles.addOffer}>
              <Icon name="plus" size={14}/>
              <Text style={styles.addOfferText}>{item.price.label}</Text>
            </Pressable>
          </View>
        ))}
        <View style={styles.search}>
          <Icon name="search" size={18} color={colors.muted}/>
          <TextInput value={query} onChangeText={setQuery} placeholder="Услуга из каталога или своя работа" style={styles.searchInput} returnKeyType="done"
            onSubmitEditing={() => { if (query.trim().length >= 2 && !suggestions.length) addCustom(); }}/>
        </View>
        {query.trim().length >= 2 ? <Button title={`Добавить свою работу: «${query.trim()}»`} tone="secondary" onPress={addCustom}/> : null}
        {error ? <Notice>{error}</Notice> : null}
      </Screen>
      <Dock>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.small}>После выпуска строки этой версии не меняются</Text>
          <View style={styles.dockRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.dockTotal} numberOfLines={1} adjustsFontSizeToFit>{money(total)}</Text>
              {unpriced.length ? <Text style={styles.warning}>{unpriced.length === 1 ? '1 строка без цены' : `${unpriced.length} строки без цены`}</Text> : null}
            </View>
            <Button title="Выпустить смету" style={{ flex: 1.4 }} busy={saving} disabled={!lines.length || unpriced.length > 0 || lines.some((line) => !line.name.trim())} onPress={() => void issue()}/>
          </View>
        </View>
      </Dock>
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  hero: { flexDirection: 'row', gap: space.m },
  meta: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  small: { color: colors.muted, fontSize: 12 },
  total: { fontSize: 38, lineHeight: 44, fontWeight: '500', letterSpacing: -1.1, fontVariant: ['tabular-nums'] },
  warning: { color: colors.warnText, fontSize: 12, fontWeight: '600' },
  mini: { width: 88, borderRadius: radius.m, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center', paddingVertical: space.s },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  lineTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.m },
  lineName: { fontSize: 16, fontWeight: '600' },
  originRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  remove: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  price: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 54, paddingHorizontal: 18, borderRadius: 18, backgroundColor: colors.soft },
  priceInput: { flex: 1, minWidth: 0, fontSize: 18, fontWeight: '500', textAlign: 'right', fontVariant: ['tabular-nums'], paddingVertical: 0 },
  rub: { fontSize: 18 },
  offer: { flexDirection: 'row', alignItems: 'center', gap: space.m, borderRadius: radius.l, backgroundColor: colors.surface, paddingVertical: 14, paddingLeft: space.l, paddingRight: 14, ...cardShadow(scheme) },
  addOffer: { height: 40, paddingHorizontal: 14, borderRadius: 20, backgroundColor: colors.soft, flexDirection: 'row', alignItems: 'center', gap: 6 },
  addOfferText: { fontSize: 14, fontWeight: '600' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, height: 52, paddingHorizontal: 18, borderRadius: 26, backgroundColor: colors.surface, ...cardShadow(scheme) },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 0 },
  dockRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dockTotal: { fontSize: 26, fontWeight: '500', letterSpacing: -0.5, fontVariant: ['tabular-nums'] }
}));
