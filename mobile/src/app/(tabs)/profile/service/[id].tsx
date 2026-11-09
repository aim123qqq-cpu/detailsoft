import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ManagedCatalog, ManagedCatalogItem } from '@df/types';
import { Segmented } from '@/features/booking-ui';
import { DurationWheel, durationText } from '@/features/duration-wheel';
import { useSession } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Chip, Field, Label, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { DOCK_SPACE, Dock } from '@/ui/sheet';
import { Text, TextInput } from '@/ui/text';
import { Toggle } from '@/ui/toggle';

const MODES: { value: ManagedCatalogItem['pricingMode']; label: string }[] = [{ value: 'fixed', label: 'Точная' }, { value: 'from', label: 'Цена «от»' }, { value: 'inspection', label: 'После осмотра' }];
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
  if (id !== 'new' && !item?.simple) return <Unavailable/>;
  return <ServiceForm key={id} item={item} catalog={data}/>;
}

function Unavailable() {
  const insets = useSafeAreaInsets();
  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14 }}>
      <FlowHeader title="Услуга"/>
      <Body muted>Эту услугу можно изменить только в веб-версии: она собрана из нескольких операций.</Body>
    </Screen>
  );
}

function ServiceForm({ item, catalog }: { item: ManagedCatalogItem | null; catalog: ManagedCatalog }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { api } = useSession();
  const insets = useSafeAreaInsets();
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
  // Which time wheel is open: 'base' for the service, a class name for its row.
  const [openWheel, setOpenWheel] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const setRowMinutes = (index: number, value: string) => setRows((current) => current.map((entry, at) => at === index ? { ...entry, minutes: value } : entry));

  // An empty class field means "as the base price".
  const classPrices = byClass ? rows.filter((row) => row.amount || row.minutes).map((row) => ({
    tenantClass: row.tenantClass, amountMinor: Number(row.amount || amount) * 100, durationMinutes: Number(row.minutes || minutes)
  })) : [];
  // A button that stays grey must say why.
  const missing = [
    !sectionId && 'раздел',
    name.trim().length < 2 && 'название',
    !validDuration(minutes) && 'время',
    amount === '' && 'цену',
    byClass && !rows.every((row) => !row.minutes || validDuration(row.minutes)) && 'цены и время по классам'
  ].filter(Boolean).join(', ');

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

  const section = catalog.sections.find((entry) => entry.id === sectionId)?.name;
  return (
    <View style={styles.root}>
      <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14, paddingBottom: DOCK_SPACE + 60 + insets.bottom }}>
        <FlowHeader title={item ? 'Услуга' : 'Новая услуга'} note={section}/>
        <View style={{ gap: 8 }}>
          <Label required>Раздел</Label>
          {catalog.sections.length
            ? <View style={styles.wrap}>{catalog.sections.map((entry) => <Chip key={entry.id} label={entry.name} selected={sectionId === entry.id} onPress={() => setSectionId(entry.id)}/>)}</View>
            : <Body muted>Сначала создайте раздел в каталоге.</Body>}
        </View>
        <Field label="Название" required value={name} onChangeText={setName} maxLength={120} placeholder="Например, озонирование салона"/>
        <View style={styles.pair}>
          <View style={styles.half}>
            <Label required>Время работы</Label>
            <Pressable accessibilityRole="button" accessibilityLabel={`Время работы: ${durationText(Number(minutes))}`} accessibilityState={{ expanded: openWheel === 'base' }}
              onPress={() => setOpenWheel(openWheel === 'base' ? '' : 'base')} style={styles.input}>
              <Text style={styles.inputText}>{durationText(Number(minutes))}</Text>
            </Pressable>
          </View>
          <View style={styles.half}><Field label="Цена, ₽" required value={amount} onChangeText={(value) => setAmount(digits(value))} keyboardType="number-pad" placeholder="0"/></View>
        </View>
        {openWheel === 'base' ? <DurationWheel minutes={Number(minutes)} onChange={(value) => setMinutes(String(value))}/> : null}
        <View style={{ gap: 8 }}>
          <Label>Как показывать цену</Label>
          <Segmented value={mode} onChange={setMode} options={MODES}/>
        </View>
        <Field label="Описание" value={description} onChangeText={setDescription} maxLength={500} multiline style={styles.multiline} placeholder="Что входит в услугу"/>

        {classes.length ? <View style={styles.card}>
          <Switchline title="Разная цена по классам авто" note={byClass ? 'Пустые поля — как основная цена' : 'Одна цена и время для любого автомобиля'} value={byClass} onChange={setByClass}/>
          {byClass ? rows.map((row, index) => (
            <View key={row.tenantClass} style={[styles.classBlock, styles.line]}>
              <View style={styles.classRow}>
                <Text style={styles.className} numberOfLines={1}>{row.tenantClass}</Text>
                <View style={styles.cell}>
                  <TextInput value={row.amount} placeholder="Как основное" placeholderTextColor={colors.muted} keyboardType="number-pad" accessibilityLabel={`${row.tenantClass}: цена`}
                    onChangeText={(value) => setRows(rows.map((entry, at) => at === index ? { ...entry, amount: digits(value) } : entry))} style={styles.cellInput}/>
                  {row.amount ? <Text style={styles.cellText}>₽</Text> : null}
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel={`${row.tenantClass}: время`} accessibilityState={{ expanded: openWheel === row.tenantClass }}
                  onPress={() => setOpenWheel(openWheel === row.tenantClass ? '' : row.tenantClass)} style={styles.cell}>
                  <Text style={[styles.cellText, !row.minutes && styles.cellMuted]} numberOfLines={1}>{row.minutes ? durationText(Number(row.minutes)) : 'Как основное'}</Text>
                </Pressable>
              </View>
              {openWheel === row.tenantClass ? <>
                <DurationWheel minutes={Number(row.minutes || minutes)} onChange={(value) => setRowMinutes(index, String(value))}/>
                {row.minutes ? <Button title="Как основное время" tone="secondary" onPress={() => { setRowMinutes(index, ''); setOpenWheel(''); }}/> : null}
              </> : null}
            </View>
          )) : null}
        </View> : null}
        {item ? <View style={styles.card}>
          <Switchline title="Доступно для записи" note={active ? 'Услугу можно выбрать при записи' : 'Останется только в истории'} value={active} onChange={setActive}/>
        </View> : null}
        {error ? <Notice>{error}</Notice> : null}
      </Screen>
      <Dock>
        <View style={{ flex: 1, gap: 10 }}>
          <Text style={missing ? styles.warning : styles.note}>{missing ? `Осталось указать: ${missing}` : item ? 'Меняются только будущие расчёты: записи и сметы хранят свои суммы.' : 'Услуга сразу появится в записи.'}</Text>
          <Button title={item ? 'Сохранить услугу' : 'Добавить услугу'} busy={saving} disabled={Boolean(missing)} onPress={() => void save()}/>
        </View>
      </Dock>
    </View>
  );
}

function Switchline({ title, note, value, onChange }: { title: string; note: string; value: boolean; onChange: (value: boolean) => void }) {
  const styles = useStyles();
  return (
    <View style={styles.toggle}>
      <View style={{ flex: 1, gap: 2 }}><Text style={styles.toggleTitle}>{title}</Text><Text style={styles.note}>{note}</Text></View>
      <Toggle value={value} onValueChange={onChange} label={title}/>
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  pair: { flexDirection: 'row', gap: 10 },
  half: { flex: 1, gap: 6 },
  input: { height: 52, borderRadius: radius.m, backgroundColor: colors.surface, paddingHorizontal: 18, justifyContent: 'center', ...cardShadow(scheme) },
  inputText: { fontSize: 16, fontWeight: '500' },
  multiline: { minHeight: 80, paddingTop: 14, textAlignVertical: 'top' },
  card: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingVertical: 4, ...cardShadow(scheme) },
  line: { borderTopWidth: 1, borderTopColor: colors.line },
  classBlock: { gap: space.s, paddingVertical: 8 },
  classRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  className: { width: 84, fontSize: 14, fontWeight: '600' },
  cell: { flex: 1, height: 44, borderRadius: 14, backgroundColor: colors.soft, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  cellInput: { flex: 1, fontSize: 14, paddingVertical: 0, minWidth: 0 },
  cellText: { fontSize: 14 },
  cellMuted: { color: colors.muted },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 60, paddingVertical: 8 },
  toggleTitle: { fontSize: 15, fontWeight: '600' },
  note: { color: colors.muted, fontSize: 12 },
  warning: { color: colors.warnText, fontSize: 12, fontWeight: '600' }
}));
