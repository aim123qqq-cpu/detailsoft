import { useCallback, useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { ManagedCatalog, ManagedCatalogItem } from '@df/types';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Chip, Field, Label, Loading, Notice, Screen } from '@/ui';

const MODES = [{ value: 'fixed', label: 'Точная цена' }, { value: 'from', label: 'Цена «от»' }, { value: 'inspection', label: 'После осмотра' }] as const;
const rubles = (amountMinor: number) => String(amountMinor / 100);
const digits = (value: string) => value.replace(/[^\d]/g, '');
const validDuration = (value: string) => Number(value) >= 1 && Number(value) <= 1440;

/** A service as people think of it: section, name, time and price, optionally different per vehicle class. */
export default function ServiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useSession();
  const { data, error, reload } = useResource(useCallback((signal: AbortSignal) => api.catalog(signal), [api]));
  if (!data && !error) return <Loading label="Загружаем каталог…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  const item = id === 'new' ? null : data.items.find((entry) => entry.type === 'service' && entry.id === id) ?? null;
  if (id !== 'new' && !item?.simple) return <Screen><Body muted>Эту услугу можно изменить только в веб-версии: она собрана из нескольких операций.</Body></Screen>;
  return <ServiceForm key={id} item={item} catalog={data}/>;
}

function ServiceForm({ item, catalog }: { item: ManagedCatalogItem | null; catalog: ManagedCatalog }) {
  const { api } = useSession();
  const classes = catalog.vehicleClasses.filter((value) => value !== '*');
  // Seeded services may have class prices only: the first class then serves as the base.
  const base = item?.basePrice ?? (item?.classPrices?.[0] ? { amountMinor: item.classPrices[0].amountMinor, durationMinutes: item.classPrices[0].durationMinutes } : null);
  const [sectionId, setSectionId] = useState(catalog.sections.find((section) => section.name === item?.category)?.id ?? catalog.sections[0]?.id ?? '');
  const [name, setName] = useState(item?.name ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [mode, setMode] = useState<ManagedCatalogItem['pricingMode']>(item?.pricingMode ?? 'fixed');
  const [amount, setAmount] = useState(base ? rubles(base.amountMinor) : '');
  const [minutes, setMinutes] = useState(base ? String(base.durationMinutes) : '30');
  const [active, setActive] = useState(item?.active ?? true);
  const differs = (item?.classPrices ?? []).some((price) => price.amountMinor !== base?.amountMinor || price.durationMinutes !== base?.durationMinutes);
  const [byClass, setByClass] = useState(differs);
  const [rows, setRows] = useState(() => classes.map((tenantClass) => {
    const price = item?.classPrices?.find((entry) => entry.tenantClass === tenantClass);
    return { tenantClass, amount: price ? rubles(price.amountMinor) : '', minutes: price ? String(price.durationMinutes) : '' };
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // An empty class field means "as the base price".
  const classPrices = byClass ? rows.filter((row) => row.amount || row.minutes).map((row) => ({
    tenantClass: row.tenantClass, amountMinor: Number(row.amount || amount) * 100, durationMinutes: Number(row.minutes || minutes)
  })) : [];
  const valid = Boolean(sectionId) && name.trim().length >= 2 && amount !== '' && validDuration(minutes) && (!byClass || rows.every((row) => !row.minutes || validDuration(row.minutes)));

  const save = async () => {
    setSaving(true); setError('');
    const input = { sectionId, name: name.trim(), description: description.trim(), pricingMode: mode, basePrice: { amountMinor: Number(amount) * 100, durationMinutes: Number(minutes) }, classPrices };
    try {
      if (item) await api.updateSimpleService(item.id, { ...input, active });
      else await api.createSimpleService(input);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (failure) {
      setError((failure as Error).message);
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: item ? 'Услуга' : 'Новая услуга' }}/>
      <Body muted>{item ? 'Меняются только будущие расчёты: записи и сметы хранят свои суммы.' : 'Услуга сразу появится в записи.'}</Body>
      <View>
        <Label>Раздел</Label>
        {catalog.sections.length
          ? <View style={styles.wrap}>{catalog.sections.map((section) => <Chip key={section.id} label={section.name} selected={sectionId === section.id} onPress={() => setSectionId(section.id)}/>)}</View>
          : <Body muted>Сначала создайте раздел в каталоге.</Body>}
      </View>
      <Field label="Название" value={name} onChangeText={setName} maxLength={120} placeholder="Например, озонирование салона"/>
      <View style={styles.pair}>
        <View style={styles.half}><Field label="Время, мин" value={minutes} onChangeText={(value) => setMinutes(digits(value))} keyboardType="number-pad"/></View>
        <View style={styles.half}><Field label="Цена, ₽" value={amount} onChangeText={(value) => setAmount(digits(value))} keyboardType="number-pad" placeholder="0"/></View>
      </View>
      <View>
        <Label>Как показывать цену</Label>
        <View style={styles.wrap}>{MODES.map((option) => <Chip key={option.value} label={option.label} selected={mode === option.value} onPress={() => setMode(option.value)}/>)}</View>
      </View>
      <Field label="Описание (необязательно)" value={description} onChangeText={setDescription} maxLength={500} multiline style={styles.multiline} placeholder="Что входит в услугу"/>

      {classes.length ? <Toggle title="Разная цена по классам авто" note={byClass ? 'Пустые поля — как основная цена' : 'Одна цена и время для любого автомобиля'} value={byClass} onChange={setByClass}/> : null}
      {byClass ? <Card>
        <Label>Цены по классам</Label>
        {rows.map((row, index) => (
          <View key={row.tenantClass} style={styles.classRow}>
            <Text style={styles.className}>{row.tenantClass}</Text>
            <TextInput value={row.amount} placeholder={amount || '₽'} placeholderTextColor={colors.soft} keyboardType="number-pad" accessibilityLabel={`${row.tenantClass}: цена`}
              onChangeText={(value) => setRows(rows.map((entry, at) => at === index ? { ...entry, amount: digits(value) } : entry))} style={styles.small}/>
            <Text style={styles.unit}>₽</Text>
            <TextInput value={row.minutes} placeholder={minutes || 'мин'} placeholderTextColor={colors.soft} keyboardType="number-pad" accessibilityLabel={`${row.tenantClass}: минуты`}
              onChangeText={(value) => setRows(rows.map((entry, at) => at === index ? { ...entry, minutes: digits(value) } : entry))} style={styles.small}/>
            <Text style={styles.unit}>мин</Text>
          </View>
        ))}
      </Card> : null}
      {item ? <Toggle title="Доступно для записи" note={active ? 'Услугу можно выбрать при записи' : 'Останется только в истории'} value={active} onChange={setActive}/> : null}

      {error ? <Notice>{error}</Notice> : null}
      <Button title={item ? 'Сохранить услугу' : 'Добавить услугу'} busy={saving} disabled={!valid} onPress={() => void save()}/>
    </Screen>
  );
}

function Toggle({ title, note, value, onChange }: { title: string; note: string; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <View style={{ flex: 1 }}><Text style={styles.toggleTitle}>{title}</Text><Text style={styles.unit}>{note}</Text></View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={title} trackColor={{ true: colors.primary, false: colors.line }} thumbColor="#ffffff"/>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  pair: { flexDirection: 'row', gap: space.m },
  half: { flex: 1 },
  multiline: { minHeight: 80, paddingTop: 14, textAlignVertical: 'top' },
  classRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  className: { color: colors.text, fontSize: 15, fontWeight: '700', flex: 1 },
  small: { minWidth: 76, minHeight: 44, borderRadius: radius.s, backgroundColor: colors.surfaceRaised, color: colors.text, fontSize: 16, paddingHorizontal: space.s, textAlign: 'right' },
  unit: { color: colors.muted, fontSize: 13 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m },
  toggleTitle: { color: colors.text, fontSize: 16, fontWeight: '700' }
});
