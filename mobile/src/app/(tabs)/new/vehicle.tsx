import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { carVariants } from '@df/shared/carCatalog';
import { BODY_TYPES } from '@df/shared/carLayouts';
import { normalizePlate } from '@df/shared/normalize';
import { Segmented } from '@/features/booking-ui';
import { CarPicker } from '@/features/car-picker';
import { useBookingDraft } from '@/lib/booking-draft';
import { useSession } from '@/lib/session';
import { space, makeStyles } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Chip, Field, Label, Notice, Screen } from '@/ui';
import { FlowHeader, StepBar } from '@/ui/brand';
import { DOCK_SPACE, Dock } from '@/ui/sheet';

const bodyLabel = (code: string) => BODY_TYPES.find((item) => item.code === code)?.label ?? code;

/** Step 1b: a new car for the customer, from the model catalog or typed in by hand. */
export default function NewVehicleScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const { draft, update } = useBookingDraft();
  const [entry, setEntry] = useState<'catalog' | 'manual'>('catalog');
  const [listedMake, setListedMake] = useState('');
  const [listedModel, setListedModel] = useState('');
  const [chosenId, setChosenId] = useState('');
  const variants = useMemo(() => listedMake && listedModel ? carVariants(listedMake, listedModel) : [], [listedMake, listedModel]);
  const variant = variants.length === 1 ? variants[0] : variants.find((item) => item.id === chosenId) ?? null;
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

  const chosenClass = tenantClass || classes.data?.items[0] || '';
  // A new center has no price classes yet: its prices then apply to every car and no class is asked.
  const classless = classes.data !== null && classes.data.items.length === 0;

  if (!draft.customer) return <Screen><Body muted>Сначала выберите клиента.</Body><Button title="К поиску" onPress={() => router.back()}/></Screen>;
  const customer = draft.customer;

  // A button that stays grey must say why.
  const missing = [
    ...(entry === 'catalog'
      ? [!listedMake && 'марку', !listedModel && 'модель', listedModel && !variant && 'кузов']
      : [make.trim().length < 2 && 'марку', !model.trim() && 'модель']),
    !classless && !chosenClass && 'класс цены',
    plate.trim() && normalizePlate(plate).length < 3 && 'госномер полностью или оставьте пустым'
  ].filter(Boolean).join(', ');
  const openManual = (typedMake: string, typedModel: string) => { setMake(typedMake); setModel(typedModel); setEntry('manual'); };
  const save = async () => {
    setSaving(true); setError('');
    try {
      const { vehicle } = await api.createVehicle({
        customerId: customer.id,
        ...(entry === 'catalog'
          ? { catalogVariantId: variant!.id }
          : { manual: { make: make.trim(), model: model.trim(), generation: generation.trim(), bodyType } }),
        ...(chosenClass ? { tenantClass: chosenClass } : {}),
        plateDisplay: plate.trim(),
        color: color.trim()
      }, entry === 'catalog' ? variant : null);
      update({ vehicle, selections: [], quote: null });
      router.replace('/new/services');
    } catch (failure) {
      setError((failure as Error).message);
      setSaving(false);
    }
  };

  return (
    <View style={styles.root}>
    <Screen contentStyle={{ paddingTop: insets.top + 18, paddingBottom: DOCK_SPACE + insets.bottom }}>
      <FlowHeader title="Новый автомобиль" note={`Шаг 2 из 4 · ${customer.name}`}/>
      <StepBar step={2} total={4}/>
      <Segmented value={entry} onChange={setEntry} options={[{ value: 'catalog', label: 'Из справочника' }, { value: 'manual', label: 'Вручную' }]}/>
      {entry === 'catalog' ? <>
        <CarPicker make={listedMake} model={listedModel} onChange={(nextMake, nextModel) => { setListedMake(nextMake); setListedModel(nextModel); setChosenId(''); }} onNotListed={openManual}/>
        {variants.length > 1 ? <View><Label required>Кузов</Label>
          <View style={styles.wrap}>{variants.map((item) => <Chip key={item.id} label={bodyLabel(item.bodyType)} selected={variant?.id === item.id} onPress={() => setChosenId(item.id)}/>)}</View>
        </View> : null}
        {classless ? null : <View><Label required>Класс цены</Label>
          <View style={styles.wrap}>{(classes.data?.items ?? []).map((value) => <Chip key={value} label={value} selected={chosenClass === value} onPress={() => setTenantClass(value)}/>)}</View>
          <Body muted style={styles.note}>От класса зависят цены в каталоге</Body>
        </View>}
      </> : <>
        <View style={styles.pair}>
          <View style={styles.half}><Field label="Марка" required value={make} onChangeText={setMake} placeholder="Zeekr"/></View>
          <View style={styles.half}><Field label="Модель" required value={model} onChangeText={setModel} placeholder="001"/></View>
        </View>
        <Field label="Поколение" value={generation} onChangeText={setGeneration}/>
        <View><Label required>Тип кузова</Label>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.bleed}>
            {BODY_TYPES.map((item) => <Chip key={item.code} label={item.label} selected={bodyType === item.code} onPress={() => setBodyType(item.code)}/>)}
          </ScrollView>
        </View>
        {classless ? null : <View><Label required>Класс цены</Label>
          <View style={styles.wrap}>{(classes.data?.items ?? []).map((value) => <Chip key={value} label={value} selected={chosenClass === value} onPress={() => setTenantClass(value)}/>)}</View>
          <Body muted style={styles.note}>От класса зависят цены в каталоге</Body>
        </View>}
      </>}
      <View style={styles.pair}>
        <View style={styles.half}><Field label="Госномер" value={plate} onChangeText={(value) => setPlate(value.toLocaleUpperCase('ru-RU'))} autoCapitalize="characters" autoCorrect={false} placeholder="А123АА 55"/></View>
        <View style={styles.half}><Field label="Цвет" value={color} onChangeText={setColor} placeholder="графит"/></View>
      </View>
      {error ? <Notice>{error}</Notice> : null}
      {missing ? <Notice tone="info">Осталось указать: {missing}</Notice> : null}
    </Screen>
    <Dock>
      <Button title="Сохранить и выбрать услуги" style={{ flex: 1 }} busy={saving} disabled={Boolean(missing)} onPress={() => void save()}/>
    </Dock>
    </View>
  );
}

const useStyles = makeStyles((colors) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  note: { fontSize: 12, marginTop: 6, paddingHorizontal: 4 },
  pair: { flexDirection: 'row', gap: space.m },
  half: { flex: 1 },
  bleed: { marginHorizontal: -space.l },
  chips: { gap: space.s, paddingHorizontal: space.l },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s }
}));
