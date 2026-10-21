import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BookingQuote, QuoteSelection, ServiceOffering } from '@df/types';
import { useBookingDraft } from '@/lib/booking-draft';
import { duration, money, vehicleName } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Label, Loading, Notice, Screen } from '@/ui';

const keyOf = (selections: QuoteSelection[]) => selections.map((item) => `${item.type}:${item.id}`).join(',');

/** Step 2: services and packages of the center for this car's class, with the preliminary price. */
export default function ServicesScreen() {
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
      <Screen contentStyle={{ paddingBottom: 140 + insets.bottom }}>
        <Card>
          <Text style={styles.plate}>{draft.vehicle.plate}</Text>
          <Text style={styles.vehicle}>{vehicleName(draft.vehicle)}</Text>
          <Text style={styles.meta}>{draft.customer.name}{catalog.data ? ` · класс «${catalog.data.vehicleClass}»` : ''}</Text>
        </Card>
        {catalog.error ? <><Notice>{catalog.error}</Notice><Button title="Повторить" tone="secondary" onPress={catalog.reload}/></> : null}
        {catalog.data && !catalog.data.categories.some((category) => category.items.length) ? <Card>
          <Label>Услуг пока нет</Label>
          <Body muted>{canEditCatalog ? 'Добавьте услуги центра — название, время и цену, — и вернитесь к записи.' : 'Попросите владельца центра добавить услуги в каталог.'}</Body>
          {canEditCatalog ? <Button title="Открыть каталог услуг" tone="secondary" onPress={() => router.push('/profile/catalog')}/> : null}
        </Card> : null}
        {catalog.data?.categories.map((category) => (
          <View key={category.name} style={styles.category}>
            <Label>{category.name}</Label>
            {category.items.map((item) => {
              const on = selected(item);
              const line = current?.lines.find((entry) => entry.type === item.type && entry.id === item.id);
              return (
                <Pressable key={`${item.type}-${item.id}`} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={item.name}
                  onPress={() => toggle(item)} android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={[styles.offer, on && styles.offerOn]}>
                  <View style={[styles.check, on && styles.checkOn]}>{on ? <Text style={styles.checkMark}>✓</Text> : null}</View>
                  <View style={styles.offerBody}>
                    <Text style={styles.offerName}>{item.name}{item.type === 'package' ? ' · комплекс' : ''}</Text>
                    {item.description ? <Text style={styles.meta} numberOfLines={2}>{item.description}</Text> : null}
                    <Text style={styles.soft}>{duration(item.durationMinutes)} · операций: {item.operations.length}</Text>
                  </View>
                  <View style={styles.price}>
                    <Text style={[styles.priceText, line?.excluded && styles.struck]}>{item.price.label}</Text>
                    {line?.excluded ? <Text style={styles.soft}>в комплексе</Text> : item.pricingMode === 'from' ? <Text style={styles.soft}>после осмотра</Text> : null}
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
        {current?.warnings.map((warning) => <Notice key={`${warning.code}-${warning.itemId}`} tone="info">{warning.message}</Notice>)}
        {error ? <Notice>{error}</Notice> : null}
      </Screen>
      <View style={[styles.dock, { paddingBottom: insets.bottom > 0 ? space.m : space.l }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.soft}>Предварительно</Text>
          {current ? <Text style={styles.total}>{money(current.totalAmountMinor)} <Text style={styles.meta}>· {duration(current.totalDurationMinutes)}</Text></Text>
            : key ? <ActivityIndicator color={colors.primary} style={{ alignSelf: 'flex-start' }}/> : <Text style={styles.meta}>Выберите услуги</Text>}
        </View>
        <Button title="Выбрать время" disabled={!current} style={styles.next}
          onPress={() => { update({ selections, quote: current }); router.push('/new/schedule'); }}/>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  plate: { color: colors.primary, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  vehicle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 14 },
  soft: { color: colors.soft, fontSize: 13 },
  category: { gap: space.s },
  offer: { flexDirection: 'row', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, borderWidth: 1, borderColor: 'transparent', overflow: 'hidden' },
  offerOn: { borderColor: colors.primary },
  check: { width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkMark: { color: colors.primaryInk, fontSize: 14, fontWeight: '900' },
  offerBody: { flex: 1, gap: 3 },
  offerName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  price: { alignItems: 'flex-end', gap: 2, maxWidth: 110 },
  priceText: { color: colors.text, fontSize: 15, fontWeight: '800', textAlign: 'right' },
  struck: { color: colors.soft, textDecorationLine: 'line-through' },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l, paddingTop: space.m,
    backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  total: { color: colors.text, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  next: { minWidth: 150 }
});
