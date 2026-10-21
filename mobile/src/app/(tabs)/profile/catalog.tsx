import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useFocusEffect } from 'expo-router';
import type { ManagedCatalogItem } from '@df/types';
import { duration, money } from '@/lib/format';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Chip, Field, Label, Loading, Notice, Pill, Screen } from '@/ui';

/** The price of an item for a class: its own price, else the '*' default, as on the server. */
function priceFor(item: ManagedCatalogItem, tenantClass: string) {
  const pick = (prices?: ManagedCatalogItem['prices']) => prices?.find((price) => price.tenantClass === tenantClass) ?? prices?.find((price) => price.tenantClass === '*');
  if (item.type === 'package') return pick(item.prices) ?? null;
  const prices = item.operations.map((operation) => pick(operation.prices));
  if (prices.some((price) => !price)) return null;
  return { amountMinor: prices.reduce((sum, price) => sum + price!.amountMinor, 0), durationMinutes: prices.reduce((sum, price) => sum + price!.durationMinutes, 0) };
}

/** Services and packages by section, with prices for a vehicle class. Simple services are edited here. */
export default function CatalogScreen() {
  const { api } = useSession();
  const { data, error, reload, refresh } = useResource(useCallback((signal: AbortSignal) => api.catalog(signal), [api]));
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  const [tenantClass, setTenantClass] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [sectionName, setSectionName] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sectionError, setSectionError] = useState('');

  if (!data && !error) return <Loading label="Загружаем каталог…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;

  const classes = data.vehicleClasses.filter((value) => value !== '*');
  const current = tenantClass ?? classes[0] ?? '*';
  const addSection = async () => {
    setBusy(true); setSectionError('');
    try { await api.createSection(sectionName.trim()); setSectionName(''); setAdding(false); refresh(); }
    catch (failure) { setSectionError((failure as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Каталог услуг', headerRight: () => (
        <Pressable accessibilityRole="button" hitSlop={10} onPress={() => router.push({ pathname: '/profile/service/[id]', params: { id: 'new' } })}>
          <Text style={styles.headerAction}>＋ Услуга</Text>
        </Pressable>
      ) }}/>
      {classes.length ? <View>
        <Label>Цены для класса</Label>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.bleed}>
          {classes.map((value) => <Chip key={value} label={value} selected={current === value} onPress={() => setTenantClass(value)}/>)}
        </ScrollView>
      </View> : null}

      {data.sections.map((section) => {
        const items = data.items.filter((item) => item.category === section.name && (archived || item.active));
        return (
          <View key={section.id} style={styles.section}>
            <View style={styles.sectionHead}><Text style={styles.sectionName}>{section.name}</Text><Text style={styles.meta}>{section.activeCount} из {section.itemCount}</Text></View>
            {items.length ? items.map((item) => {
              const price = priceFor(item, current);
              return (
                <Pressable key={`${item.type}-${item.id}`} accessibilityRole="button" accessibilityLabel={item.name} disabled={!item.simple}
                  onPress={() => router.push({ pathname: '/profile/service/[id]', params: { id: item.id } })}
                  android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={[styles.item, !item.active && styles.inactive]}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.itemName}>{item.name}</Text>
                    <Text style={styles.meta}>{item.type === 'package' ? `комплекс · операций: ${item.operations.length}` : item.simple ? 'услуга' : `составная · операций: ${item.operations.length}`}{price ? ` · ${duration(price.durationMinutes)}` : ''}</Text>
                    {!item.active ? <Pill label="не для записи"/> : null}
                  </View>
                  <Text style={styles.price}>{price ? `${item.pricingMode === 'fixed' ? '' : 'от '}${money(price.amountMinor)}` : 'нет цены'}</Text>
                </Pressable>
              );
            }) : <Body muted>В разделе пока нет услуг.</Body>}
          </View>
        );
      })}

      <Chip label={archived ? 'Скрыть недоступные для записи' : 'Показать недоступные для записи'} selected={archived} onPress={() => setArchived((value) => !value)}/>

      {adding ? <Card>
        <Field label="Новый раздел" value={sectionName} onChangeText={setSectionName} placeholder="Например, Защитные покрытия" maxLength={60} autoFocus/>
        {sectionError ? <Notice>{sectionError}</Notice> : null}
        <Button title="Создать раздел" busy={busy} disabled={sectionName.trim().length < 2} onPress={() => void addSection()}/>
        <Button title="Отмена" tone="quiet" onPress={() => { setAdding(false); setSectionName(''); }}/>
      </Card> : <Button title="＋ Раздел" tone="secondary" onPress={() => setAdding(true)}/>}

      <Body muted>Простые услуги (название, время, цена) меняются здесь. Составные услуги, комплексы, библиотека операций, порядок и удаление разделов — в веб-версии.</Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerAction: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  bleed: { marginHorizontal: -space.l },
  chips: { gap: space.s, paddingHorizontal: space.l },
  section: { gap: space.s },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: space.s },
  sectionName: { color: colors.text, fontSize: 18, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 13 },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l, overflow: 'hidden' },
  inactive: { opacity: 0.6 },
  itemName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  price: { color: colors.text, fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] }
});
