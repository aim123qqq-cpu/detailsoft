import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ManagedCatalogItem } from '@df/types';
import { duration, money } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Chip, Field, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Text } from '@/ui/text';

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
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const session = useSignedIn();
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
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14 }}>
      <FlowHeader title="Каталог услуг" note={session.tenant.name} right={
        <Pressable accessibilityRole="button" accessibilityLabel="Новая услуга" onPress={() => router.push({ pathname: '/profile/service/[id]', params: { id: 'new' } })} style={styles.add}>
          <Icon name="plus" size={16} strokeWidth={2.4} color={colors.pillInk}/>
          <Text style={styles.addText}>Услуга</Text>
        </Pressable>
      }/>

      {classes.length ? <View style={{ gap: 8 }}>
        <Text style={[styles.meta, { paddingHorizontal: 4 }]}>Цены для класса</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.bleed}>
          {classes.map((value) => <Chip key={value} label={value} selected={current === value} onPress={() => setTenantClass(value)}/>)}
        </ScrollView>
      </View> : null}

      {data.sections.map((section) => {
        const items = data.items.filter((item) => item.category === section.name && (archived || item.active));
        return (
          <View key={section.id} style={{ gap: 10 }}>
            <View style={styles.sectionHead}><Heading>{section.name}</Heading><Text style={styles.meta}>{archived ? `${section.activeCount} из ${section.itemCount}` : section.activeCount}</Text></View>
            {items.length ? <View style={styles.list}>
              {items.map((item, index) => {
                const price = priceFor(item, current);
                const kind = item.type === 'package' ? `комплекс · операций: ${item.operations.length}` : item.simple ? 'услуга' : `составная · операций: ${item.operations.length}`;
                const under = !item.active ? 'не для записи' : item.pricingMode === 'inspection' ? 'после осмотра' : null;
                return (
                  <Pressable key={`${item.type}-${item.id}`} accessibilityRole="button" accessibilityLabel={item.name} disabled={!item.simple}
                    onPress={() => router.push({ pathname: '/profile/service/[id]', params: { id: item.id } })}
                    style={[styles.item, index > 0 && styles.itemLine]}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={[styles.itemName, !item.active && styles.off]}>{item.name}</Text>
                      <Text style={styles.small}>{kind}{price ? ` · ${duration(price.durationMinutes)}` : ''}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={[styles.price, !item.active && styles.off]}>{price ? `${item.pricingMode === 'fixed' ? '' : 'от '}${money(price.amountMinor)}` : 'нет цены'}</Text>
                      {under ? <Text style={styles.under}>{under}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View> : <Body muted>В разделе пока нет услуг.</Body>}
          </View>
        );
      })}

      <Pressable accessibilityRole="button" onPress={() => setArchived((value) => !value)} style={styles.textButton} hitSlop={6}>
        <Text style={styles.textButtonLabel}>{archived ? 'Скрыть недоступные для записи' : 'Показать недоступные для записи'}</Text>
      </Pressable>

      {adding ? <Card>
        <Field label="Новый раздел" value={sectionName} onChangeText={setSectionName} placeholder="Например, Защитные покрытия" maxLength={60} autoFocus/>
        {sectionError ? <Notice>{sectionError}</Notice> : null}
        <Button title="Создать раздел" busy={busy} disabled={sectionName.trim().length < 2} onPress={() => void addSection()}/>
        <Button title="Отмена" tone="quiet" onPress={() => { setAdding(false); setSectionName(''); }}/>
      </Card> : (
        <Pressable accessibilityRole="button" onPress={() => setAdding(true)} style={styles.dashed}>
          <Icon name="plus" size={16} strokeWidth={2.4}/>
          <Text style={styles.textButtonLabel}>Раздел</Text>
        </Pressable>
      )}

      <Text style={styles.hint}>Простые услуги (название, время, цена) меняются здесь. Составные услуги, комплексы, библиотека операций, порядок и удаление разделов — в веб-версии.</Text>
    </Screen>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  add: { height: 44, marginLeft: -10, paddingHorizontal: 16, borderRadius: 22, backgroundColor: colors.pill, flexDirection: 'row', alignItems: 'center', gap: 6 },
  addText: { color: colors.pillInk, fontSize: 14, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 13 },
  bleed: { marginHorizontal: -space.l, flexGrow: 0 },
  chips: { gap: 6, paddingHorizontal: space.l, paddingVertical: 4 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  list: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingVertical: 4, ...cardShadow(scheme) },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 62, paddingVertical: 8 },
  itemLine: { borderTopWidth: 1, borderTopColor: colors.line },
  itemName: { fontSize: 15, fontWeight: '600' },
  off: { color: colors.muted },
  small: { color: colors.muted, fontSize: 12 },
  price: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  under: { color: colors.muted, fontSize: 11 },
  textButton: { alignSelf: 'center', padding: 6 },
  textButtonLabel: { fontSize: 14, fontWeight: '700' },
  dashed: { height: 52, borderRadius: 26, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.line, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, paddingHorizontal: 4 }
}));
