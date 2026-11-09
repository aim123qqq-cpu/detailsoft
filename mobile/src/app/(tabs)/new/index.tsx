import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Customer, Vehicle } from '@df/types';
import { Segmented } from '@/features/booking-ui';
import { type DraftCustomer, type DraftVehicle, useBookingDraft } from '@/lib/booking-draft';
import { CHANNELS, bodyName, formatPhoneInput, vehicleName, visits } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { Body, Button, Card, Chip, Field, Notice, Pill, Screen } from '@/ui';
import { FlowHeader, StepBar } from '@/ui/brand';
import { ComingSoon } from '@/ui/coming-soon';
import { Icon } from '@/ui/icons';
import { Plate } from '@/ui/plate';
import { Text, TextInput } from '@/ui/text';

type PlateMatch = Vehicle & { customer: DraftCustomer | null };
type Results = { mode: 'phone' | 'plate'; query: string; customers: Customer[]; vehicles: PlateMatch[] };

const leave = () => (router.canGoBack() ? router.back() : router.navigate('/home'));

export default function NewBookingScreen() {
  const session = useSignedIn();
  const { draft } = useBookingDraft();
  if (!session.capabilities.manageBookings) return <ComingSoon title="Новая запись" text="Записывать клиентов может администратор." noAccess/>;
  return <Search key={draft.round}/>;
}

/** Step 1: where the customer came from, then the customer by phone (or the car by plate), then one of their cars. */
function Search() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const { draft, update, reset } = useBookingDraft();
  const [mode, setMode] = useState<'phone' | 'plate'>('phone');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);

  const digits = query.replace(/\D/g, '');
  const searchable = mode === 'phone' ? digits.length >= 4 : query.replace(/\s/g, '').length >= 2;
  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const search = mode === 'phone'
        ? api.searchCustomers(query, controller.signal).then((found) => ({ mode, query, customers: found.items, vehicles: [] }))
        : api.searchVehicles(query, controller.signal).then((found) => ({ mode, query, customers: [], vehicles: found.items }));
      search.then((next) => { setResults(next); setError(''); },
        (failure: Error) => { if (failure.name !== 'AbortError') setError(failure.message); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, mode, query, searchable]);

  // Results belong to the query they were found for; while typing, the old ones are not shown.
  const current = searchable && results?.mode === mode && results.query === query ? results : null;
  const searching = searchable && !current && !error;

  // "Not found" appears below the search, under the keyboard: a full number moves on to the name,
  // and the screen scrolls to the focused field.
  const nameField = useRef<React.ComponentRef<typeof TextInput>>(null);
  const newCustomer = current?.mode === 'phone' && !current.customers.length && digits.length >= 11;
  useEffect(() => { if (newCustomer) nameField.current?.focus(); }, [newCustomer]);

  const choose = (customer: DraftCustomer, vehicle: DraftVehicle) => {
    update({ customer, vehicle, selections: [], quote: null, booking: null });
    router.push('/new/services');
  };
  const addVehicle = (customer: DraftCustomer) => { update({ customer, vehicle: null, selections: [], quote: null, booking: null }); router.push('/new/vehicle'); };
  const createCustomer = async () => {
    setCreating(true); setError('');
    try {
      const customer = await api.createCustomer({ name: name.trim(), phone: query });
      setResults({ mode: 'phone', query, customers: [customer], vehicles: [] });
      addVehicle(customer);
    } catch (failure) { setError((failure as Error).message); }
    finally { setCreating(false); }
  };
  const anyVehicle = Boolean(current?.customers.some((customer) => !customer.archived && customer.vehicles.length) || current?.vehicles.some((vehicle) => vehicle.customer));

  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18 }}>
      <FlowHeader title="Новая запись" note="Шаг 1 из 4 · клиент" onBack={leave}/>
      <StepBar step={1} total={4}/>
      <View style={{ gap: 6 }}>
        <Text style={styles.caption}>Откуда клиент</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.bleed}>
          {CHANNELS.map((item) => <Chip key={item.code} label={item.label} selected={draft.channel === item.code} onPress={() => update({ channel: item.code })}/>)}
        </ScrollView>
      </View>
      <Segmented value={mode} onChange={(next) => { setMode(next); setQuery(''); setError(''); }} options={[{ value: 'phone', label: 'По телефону' }, { value: 'plate', label: 'По госномеру' }]}/>
      <Field key={mode} label={mode === 'phone' ? 'Телефон клиента' : 'Госномер'} required value={query} autoFocus autoCorrect={false} style={styles.search} testID="new-search"
        keyboardType={mode === 'phone' ? 'phone-pad' : 'default'} autoCapitalize="characters" placeholder={mode === 'phone' ? '+7 999 000-00-00' : 'А123АА 55'}
        onChangeText={(value) => setQuery(mode === 'phone' ? formatPhoneInput(value) : value.toLocaleUpperCase('ru-RU'))}/>
      {searching ? <ActivityIndicator color={colors.ink}/> : null}
      {!searchable ? <Text style={styles.hint}>{mode === 'phone' ? 'Начните вводить номер — найдём клиента и его автомобили.' : 'Найдём автомобиль и его владельца в вашем центре.'}</Text> : null}
      {error ? <Notice>{error}</Notice> : null}

      {current?.customers.map((customer) => customer.archived ? (
        <Card key={customer.id}>
          <View style={styles.head}><Text style={styles.name}>{customer.name}</Text><Pill label="В архиве"/></View>
          <Text style={styles.meta}>{customer.phoneDisplay}</Text>
          <Body muted>Не создавайте дубль: откройте карточку и верните клиента из архива в веб-версии.</Body>
          <Button title="Карточка клиента" tone="secondary" onPress={() => router.push({ pathname: '/customer/[id]', params: { id: customer.id } })}/>
        </Card>
      ) : (
        <Card key={customer.id}>
          <Pressable onPress={() => router.push({ pathname: '/customer/[id]', params: { id: customer.id } })} accessibilityRole="link" style={styles.head}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name}>{customer.name}</Text>
              <Text style={styles.meta}>{customer.phoneDisplay} · {visits(customer.visitCount)}</Text>
            </View>
            <Icon name="chevronRight" size={18} color={colors.muted}/>
          </Pressable>
          {customer.vehicles.map((vehicle) => <CarRow key={vehicle.id} vehicle={vehicle} onPress={() => choose(customer, vehicle)}/>)}
          <Pressable accessibilityRole="button" onPress={() => addVehicle(customer)} style={styles.addCar}>
            <Icon name="plus" size={18}/>
            <Text style={styles.addCarText}>Добавить автомобиль</Text>
          </Pressable>
        </Card>
      ))}

      {current?.mode === 'phone' && !current.customers.length ? <Card>
        <Text style={styles.name}>Клиент не найден</Text>
        <Body muted>{digits.length < 11 ? 'Введите номер полностью, чтобы создать клиента.' : 'Добавьте имя — номер уже записан.'}</Body>
        <Field ref={nameField} label="Имя клиента" required value={name} onChangeText={setName} autoCapitalize="words" placeholder="Например, Иван Петров"/>
        <Button title="Создать клиента" busy={creating} disabled={name.trim().length < 2 || digits.length < 11} onPress={() => void createCustomer()}/>
      </Card> : null}

      {current?.vehicles.map((vehicle) => (
        <Card key={vehicle.id}>
          {vehicle.customer ? <Pressable onPress={() => router.push({ pathname: '/customer/[id]', params: { id: vehicle.customer!.id } })} accessibilityRole="link" style={styles.head}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.name}>{vehicle.customer.name}</Text>
              <Text style={styles.meta}>{vehicle.customer.phoneDisplay}</Text>
            </View>
            <Icon name="chevronRight" size={18} color={colors.muted}/>
          </Pressable> : <Body muted>У автомобиля нет текущего владельца — найдите клиента по телефону.</Body>}
          <CarRow vehicle={vehicle} disabled={!vehicle.customer} onPress={() => vehicle.customer && choose(vehicle.customer, vehicle)}/>
        </Card>
      ))}
      {current?.mode === 'plate' && !current.vehicles.length ? <Body muted>Автомобиль не найден. Найдите клиента по телефону и добавьте ему автомобиль.</Body> : null}
      {anyVehicle ? <Text style={styles.hint}>Нажмите на автомобиль, чтобы выбрать услуги</Text> : null}

      {draft.customer && draft.vehicle && !query ? <Button title={`Продолжить: ${draft.vehicle.plate}`} tone="secondary" onPress={() => router.push('/new/services')}/> : null}
      {draft.customer && !query ? <Button title="Начать заново" tone="quiet" onPress={() => reset({ channel: draft.channel })}/> : null}
    </Screen>
  );
}

/** A car of the customer: the plate, the model, its body and colour. */
function CarRow({ vehicle, onPress, disabled }: { vehicle: DraftVehicle; onPress: () => void; disabled?: boolean }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const note = [bodyName(vehicle.bodyType), vehicle.color, vehicle.tenantClass ? `класс «${vehicle.tenantClass}»` : null].filter(Boolean).join(' · ');
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${vehicle.plate}, ${vehicleName(vehicle)}`} disabled={disabled} onPress={onPress}
      android_ripple={{ color: 'rgba(127,127,127,.12)' }} style={[styles.car, disabled && { opacity: 0.5 }]}>
      <Plate plate={vehicle.plate}/>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.carName} numberOfLines={1}>{vehicleName(vehicle)}</Text>
        {note ? <Text style={styles.small} numberOfLines={1}>{note}</Text> : null}
      </View>
      <Icon name="chevronRight" size={18} color={colors.muted}/>
    </Pressable>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  caption: { fontSize: 13, color: colors.muted, paddingHorizontal: 4 },
  bleed: { marginHorizontal: -space.l },
  chips: { gap: space.s, paddingHorizontal: space.l, paddingVertical: 4 },
  search: { height: 64, borderRadius: 32, paddingHorizontal: 22, fontSize: 20, fontWeight: '500', borderWidth: 0, ...cardShadow(scheme) },
  hint: { fontSize: 13, color: colors.muted, paddingHorizontal: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.m },
  name: { fontSize: 20, fontWeight: '600', letterSpacing: -0.2, flexShrink: 1 },
  meta: { color: colors.muted, fontSize: 13 },
  car: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 64, paddingVertical: 10, paddingHorizontal: space.m, borderRadius: radius.m, backgroundColor: colors.soft, overflow: 'hidden' },
  carName: { fontSize: 15, fontWeight: '600' },
  small: { color: colors.muted, fontSize: 12 },
  addCar: { height: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.s },
  addCarText: { fontSize: 14, fontWeight: '700' }
}));
