import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/ui/text';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BookingQuote, QuoteSelection, ServiceOffering } from '@df/types';
import { useBookingDraft } from '@/lib/booking-draft';
import { duration, money, vehicleName } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, space, makeStyles, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader, StepBar } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Plate } from '@/ui/plate';
import { DOCK_SPACE, Dock } from '@/ui/sheet';

const keyOf = (selections: QuoteSelection[]) => selections.map((item) => `${item.type}:${item.id}`).join(',');

/** Step 2: services and packages of the center for this car's class, with the preliminary price. */
export default function ServicesScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { api } = useSession();
  const canEditCatalog = useSignedIn().capabilities.manageCatalog;
  const { draft, update } = useBookingDraft();
  const insets = useSafeAreaInsets();
  const vehicleId = draft.vehicle?.id ?? '';
  const catalog = useResource(useCallback((signal: AbortSignal) => api.services(vehicleId, signal), [api, vehicleId]));
  const [selections, setSelections] = useState<QuoteSelection[]>(draft.selections);
  const [quote, setQuote] = useState<{ key: string; value: BookingQuote } | null>(draft.quote ? { key: keyOf(draft.selections), value: draft.quote } : null);
  const [error, setError] = useState('');

  const key = keyOf(selections);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.previewQuote(vehicleId, selections, controller.signal).then((value) => { setQuote({ key, value }); setError(''); },
        (failure: Error) => { if (failure.name !== 'AbortError') setError(failure.message); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, vehicleId, key, selections]);
  const current = quote?.key === key && key ? quote.value : null;

  if (!draft.vehicle || !draft.customer) return <Screen><Body muted>Сначала выберите клиента и автомобиль.</Body><Button title="К поиску" onPress={() => router.navigate('/new')}/></Screen>;
  if (!catalog.data && !catalog.error) return <Loading label="Загружаем услуги центра…"/>;

  const selected = (item: ServiceOffering) => selections.some((selection) => selection.type === item.type && selection.id === item.id);
  const toggle = (item: ServiceOffering) => {
    void Haptics.selectionAsync();
    setSelections((list) => selected(item) ? list.filter((selection) => !(selection.type === item.type && selection.id === item.id)) : [...list, { type: item.type, id: item.id }]);
  };

  return (
    <View style={styles.root}>
      <Screen contentStyle={{ paddingTop: insets.top + 18, paddingBottom: DOCK_SPACE + insets.bottom }}>
        <FlowHeader title="Услуги" note="Шаг 3 из 4"/>
        <StepBar step={3} total={4}/>
        <View style={styles.car}>
          <Plate plate={draft.vehicle.plate}/>
          <View style={{ flex: 1 }}>
            <Text style={styles.carName} numberOfLines={1}>{vehicleName(draft.vehicle)}</Text>
            <Text style={styles.carNote} numberOfLines={1}>{draft.customer.name}{catalog.data ? ` · класс «${catalog.data.vehicleClass}»` : ''}</Text>
          </View>
        </View>
        {catalog.error ? <><Notice>{catalog.error}</Notice><Button title="Повторить" tone="secondary" onPress={catalog.reload}/></> : null}
        {catalog.data && !catalog.data.categories.some((category) => category.items.length) ? <Card>
          <Heading>Услуг пока нет</Heading>
          <Body muted>{canEditCatalog ? 'Добавьте услуги центра — название, время и цену, — и вернитесь к записи.' : 'Попросите владельца центра добавить услуги в каталог.'}</Body>
          {canEditCatalog ? <Button title="Открыть каталог услуг" tone="secondary" onPress={() => router.push('/profile/catalog')}/> : null}
        </Card> : null}
        {catalog.data?.categories.filter((category) => category.items.length).map((category) => (
          <View key={category.name} style={styles.category}>
            <Heading style={{ marginTop: 4 }}>{category.name}</Heading>
            {category.items.map((item) => {
              const on = selected(item);
              const line = current?.lines.find((entry) => entry.type === item.type && entry.id === item.id);
              return (
                <Pressable key={`${item.type}-${item.id}`} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={item.name}
                  onPress={() => toggle(item)} android_ripple={{ color: 'rgba(127,127,127,.12)' }} style={styles.offer}>
                  <View style={[styles.check, on && styles.checkOn]}>{on ? <Icon name="check" size={16} color={colors.pillInk} strokeWidth={2.2}/> : null}</View>
                  <View style={styles.offerBody}>
                    <Text style={styles.offerName}>{item.name}{item.type === 'package' ? ' · комплекс' : ''}</Text>
                    <Text style={styles.small} numberOfLines={2}>{[item.description, duration(item.durationMinutes), item.operations.length ? `операций: ${item.operations.length}` : null].filter(Boolean).join(' · ')}</Text>
                  </View>
                  <View style={styles.price}>
                    <Text style={[styles.priceText, line?.excluded && styles.struck]}>{item.price.label}</Text>
                    {line?.excluded ? <Text style={styles.tiny}>в комплексе</Text> : item.pricingMode === 'from' ? <Text style={styles.tiny}>после осмотра</Text> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
        {current?.warnings.map((warning) => <Notice key={`${warning.code}-${warning.itemId}`} tone="info">{warning.message}</Notice>)}
        {error ? <Notice>{error}</Notice> : null}
      </Screen>
      <Dock>
        <View style={{ flex: 1 }}>
          <Text style={styles.small}>Предварительно</Text>
          {current ? <Text style={styles.total} numberOfLines={1} adjustsFontSizeToFit>{money(current.totalAmountMinor)} <Text style={styles.totalNote}>· {duration(current.totalDurationMinutes)}</Text></Text>
            : key ? <ActivityIndicator color={colors.ink} style={{ alignSelf: 'flex-start' }}/> : <Text style={styles.totalNote}>Выберите услуги</Text>}
        </View>
        <Button title="Выбрать время" disabled={!current} style={{ flex: 1.1 }}
          onPress={() => { update({ selections, quote: current }); router.push('/new/schedule'); }}/>
      </Dock>
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  car: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: 14, paddingHorizontal: space.l, borderRadius: 24, backgroundColor: colors.tileSky },
  carName: { color: colors.tileInk, fontSize: 16, fontWeight: '600' },
  carNote: { color: colors.tileInk, fontSize: 12, opacity: 0.75 },
  category: { gap: 10 },
  offer: { flexDirection: 'row', alignItems: 'flex-start', gap: space.m, backgroundColor: colors.surface, borderRadius: 22, padding: space.l, overflow: 'hidden', ...cardShadow(scheme) },
  check: { width: 26, height: 26, borderRadius: 9, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.pill, borderColor: colors.pill },
  offerBody: { flex: 1, gap: 3 },
  offerName: { fontSize: 16, fontWeight: '600' },
  small: { color: colors.muted, fontSize: 12 },
  tiny: { color: colors.muted, fontSize: 11 },
  price: { alignItems: 'flex-end', gap: 2, maxWidth: 110 },
  priceText: { fontSize: 15, fontWeight: '600', textAlign: 'right', fontVariant: ['tabular-nums'] },
  struck: { color: colors.muted, textDecorationLine: 'line-through' },
  total: { fontSize: 24, fontWeight: '500', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  totalNote: { fontSize: 14, color: colors.muted, fontWeight: '400' }
}));
