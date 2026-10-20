import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { BODY_TYPES } from '@df/shared/carLayouts';
import type { CatalogVariant } from '@df/types';
import { Segmented } from '@/features/booking-ui';
import { useBookingDraft } from '@/lib/booking-draft';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Chip, Field, Label, Notice, Screen } from '@/ui';

const bodyLabel = (code: string) => BODY_TYPES.find((item) => item.code === code)?.label ?? code;

/** Step 1b: a new car for the customer, from the model catalog or typed in by hand. */
export default function NewVehicleScreen() {
  const { api } = useSession();
  const { draft, update } = useBookingDraft();
  const [entry, setEntry] = useState<'catalog' | 'manual'>('catalog');
  const [modelQuery, setModelQuery] = useState('');
  const [found, setFound] = useState<{ query: string; items: CatalogVariant[] } | null>(null);
  const [variant, setVariant] = useState<CatalogVariant | null>(null);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [generation, setGeneration] = useState('');
  const [bodyType, setBodyType] = useState('sedan');
  const [tenantClass, setTenantClass] = useState('');
  const [plate, setPlate] = useState('');
  const [color, setColor] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const classes = useResource(useCallback((signal: AbortSignal) => api.vehicleClasses(signal), [api]));

  useEffect(() => {
    if (modelQuery.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.searchCatalog(modelQuery, controller.signal).then((result) => setFound({ query: modelQuery, items: result.items }),
        (failure: Error) => { if (failure.name !== 'AbortError') setError(failure.message); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, modelQuery]);
  const variants = found && found.query === modelQuery ? found.items : [];
  const chosenClass = tenantClass || classes.data?.items[0] || '';

  if (!draft.customer) return <Screen><Body muted>Сначала выберите клиента.</Body><Button title="К поиску" onPress={() => router.back()}/></Screen>;
  const customer = draft.customer;

  const ready = (entry === 'catalog' ? Boolean(variant) : make.trim().length >= 2 && Boolean(model.trim()) && Boolean(chosenClass))
    && plate.replace(/\s/g, '').length >= 3 && color.trim().length >= 2;
  const save = async () => {
    setSaving(true); setError('');
    try {
      const { vehicle } = await api.createVehicle({
        customerId: customer.id,
        ...(entry === 'catalog'
          ? { catalogVariantId: variant!.id }
          : { manual: { make: make.trim(), model: model.trim(), generation: generation.trim(), bodyType }, tenantClass: chosenClass }),
        plateDisplay: plate.trim(),
        color: color.trim()
      });
      update({ vehicle, selections: [], quote: null });
      router.replace('/new/services');
    } catch (failure) {
      setError((failure as Error).message);
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Card><Label>Владелец</Label><Text style={styles.owner}>{customer.name}</Text><Text style={styles.meta}>{customer.phoneDisplay}</Text></Card>
      <Segmented value={entry} onChange={setEntry} options={[{ value: 'catalog', label: 'Из справочника' }, { value: 'manual', label: 'Вручную' }]}/>
      {entry === 'catalog' ? <>
        <Field label="Марка и модель" value={modelQuery} onChangeText={(value) => { setModelQuery(value); setVariant(null); }} placeholder="Например, Camry" autoCorrect={false}/>
        {variants.map((item) => (
          <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: variant?.id === item.id }} onPress={() => setVariant(item)}
            style={[styles.variant, variant?.id === item.id && styles.variantSelected]}>
            <Text style={styles.variantName}>{[item.make, item.model, item.generation].filter(Boolean).join(' ')}</Text>
            <Text style={styles.meta}>{bodyLabel(item.bodyType)}{item.yearFrom ? ` · ${item.yearFrom}–${item.yearTo ?? 'н. в.'}` : ''}</Text>
          </Pressable>
        ))}
        {modelQuery.trim().length >= 2 && found?.query === modelQuery && !variants.length ? <Body muted>В справочнике такой модели нет — введите её вручную.</Body> : null}
      </> : <>
        <View style={styles.pair}>
          <View style={styles.half}><Field label="Марка" value={make} onChangeText={setMake} placeholder="Zeekr"/></View>
          <View style={styles.half}><Field label="Модель" value={model} onChangeText={setModel} placeholder="001"/></View>
        </View>
        <Field label="Поколение (необязательно)" value={generation} onChangeText={setGeneration}/>
        <View><Label>Тип кузова</Label>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.bleed}>
            {BODY_TYPES.map((item) => <Chip key={item.code} label={item.label} selected={bodyType === item.code} onPress={() => setBodyType(item.code)}/>)}
          </ScrollView>
        </View>
        <View><Label>Класс цены</Label>
          <View style={styles.wrap}>{(classes.data?.items ?? []).map((value) => <Chip key={value} label={value} selected={chosenClass === value} onPress={() => setTenantClass(value)}/>)}</View>
        </View>
      </>}
      <View style={styles.pair}>
        <View style={styles.half}><Field label="Госномер" value={plate} onChangeText={(value) => setPlate(value.toLocaleUpperCase('ru-RU'))} autoCapitalize="characters" autoCorrect={false} placeholder="А123АА 55"/></View>
        <View style={styles.half}><Field label="Цвет" value={color} onChangeText={setColor} placeholder="графит"/></View>
      </View>
      {error ? <Notice>{error}</Notice> : null}
      <Button title="Сохранить и выбрать услуги" busy={saving} disabled={!ready} onPress={() => void save()}/>
    </Screen>
  );
}

const styles = StyleSheet.create({
  owner: { color: colors.text, fontSize: 18, fontWeight: '800' },
  meta: { color: colors.muted, fontSize: 14 },
  variant: { backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m, borderWidth: 1, borderColor: 'transparent' },
  variantSelected: { borderColor: colors.primary, backgroundColor: 'rgba(255,121,57,.1)' },
  variantName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  pair: { flexDirection: 'row', gap: space.m },
  half: { flex: 1 },
  bleed: { marginHorizontal: -space.l },
  chips: { gap: space.s, paddingHorizontal: space.l },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s }
});
