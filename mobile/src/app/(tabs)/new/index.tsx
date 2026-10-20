import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import type { Customer, Vehicle } from '@df/types';
import { Segmented, VehicleRow } from '@/features/booking-ui';
import { type DraftCustomer, type DraftVehicle, useBookingDraft } from '@/lib/booking-draft';
import { CHANNELS, formatPhoneInput, visits } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, space } from '@/lib/theme';
import { Body, Button, Card, Chip, Field, Label, Notice, Pill, Screen } from '@/ui';
import { ComingSoon } from '@/ui/coming-soon';

type PlateMatch = Vehicle & { customer: DraftCustomer | null };
type Results = { mode: 'phone' | 'plate'; query: string; customers: Customer[]; vehicles: PlateMatch[] };

export default function NewBookingScreen() {
  const session = useSignedIn();
  const { draft } = useBookingDraft();
  if (!session.capabilities.manageBookings) return <ComingSoon title="Новая запись" text="Записывать клиентов может администратор." noAccess/>;
  return <Search key={draft.round}/>;
}

/** Step 1: the channel, then the customer by phone (or the car by plate), then one of their cars. */
function Search() {
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

  return (
    <Screen>
      <View>
        <Label>Канал обращения</Label>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.bleed}>
          {CHANNELS.map((item) => <Chip key={item.code} label={item.label} selected={draft.channel === item.code} onPress={() => update({ channel: item.code })}/>)}
        </ScrollView>
      </View>
      <Segmented value={mode} onChange={(next) => { setMode(next); setQuery(''); setError(''); }} options={[{ value: 'phone', label: 'По телефону' }, { value: 'plate', label: 'По госномеру' }]}/>
      <Field key={mode} label={mode === 'phone' ? 'Телефон клиента' : 'Госномер'} value={query} autoFocus autoCorrect={false}
        keyboardType={mode === 'phone' ? 'phone-pad' : 'default'} autoCapitalize="characters" placeholder={mode === 'phone' ? '+7 999 000-00-00' : 'А123АА 55'}
        onChangeText={(value) => setQuery(mode === 'phone' ? formatPhoneInput(value) : value.toLocaleUpperCase('ru-RU'))}/>
      {searching ? <ActivityIndicator color={colors.primary}/> : null}
      {!searchable ? <Body muted>{mode === 'phone' ? 'Начните вводить номер — найдём клиента и его автомобили.' : 'Найдём автомобиль и его владельца в вашем центре.'}</Body> : null}
      {error ? <Notice>{error}</Notice> : null}

      {current?.customers.map((customer) => customer.archived ? (
        <Card key={customer.id}>
          <View style={styles.head}><Text style={styles.name}>{customer.name}</Text><Pill label="в архиве"/></View>
          <Text style={styles.meta}>{customer.phoneDisplay}</Text>
          <Body muted>Не создавайте дубль: откройте карточку и верните клиента из архива в веб-версии.</Body>
          <Button title="Карточка клиента" tone="secondary" onPress={() => router.push({ pathname: '/customer/[id]', params: { id: customer.id } })}/>
        </Card>
      ) : (
        <Card key={customer.id}>
          <Pressable onPress={() => router.push({ pathname: '/customer/[id]', params: { id: customer.id } })} accessibilityRole="link">
            <View style={styles.head}><Text style={styles.name}>{customer.name}</Text><Text style={styles.open}>›</Text></View>
            <Text style={styles.meta}>{customer.phoneDisplay} · {visits(customer.visitCount)}</Text>
          </Pressable>
          {customer.vehicles.map((vehicle) => <VehicleRow key={vehicle.id} vehicle={vehicle} onPress={() => choose(customer, vehicle)}/>)}
          <Button title="＋ Добавить автомобиль" tone="quiet" onPress={() => addVehicle(customer)}/>
        </Card>
      ))}

      {current?.mode === 'phone' && !current.customers.length ? <Card>
        <Text style={styles.name}>Клиент не найден</Text>
        <Body muted>{digits.length < 11 ? 'Введите номер полностью, чтобы создать клиента.' : 'Добавьте имя — номер уже записан.'}</Body>
        <Field label="Имя клиента" value={name} onChangeText={setName} autoCapitalize="words" placeholder="Например, Иван Петров"/>
        <Button title="Создать клиента" busy={creating} disabled={name.trim().length < 2 || digits.length < 11} onPress={() => void createCustomer()}/>
      </Card> : null}

      {current?.vehicles.map((vehicle) => (
        <Card key={vehicle.id}>
          {vehicle.customer ? <Pressable onPress={() => router.push({ pathname: '/customer/[id]', params: { id: vehicle.customer!.id } })} accessibilityRole="link">
            <View style={styles.head}><Text style={styles.name}>{vehicle.customer.name}</Text><Text style={styles.open}>›</Text></View>
            <Text style={styles.meta}>{vehicle.customer.phoneDisplay}</Text>
          </Pressable> : <Body muted>У автомобиля нет текущего владельца — найдите клиента по телефону.</Body>}
          <VehicleRow vehicle={vehicle} disabled={!vehicle.customer} onPress={() => vehicle.customer && choose(vehicle.customer, vehicle)}/>
        </Card>
      ))}
      {current?.mode === 'plate' && !current.vehicles.length ? <Body muted>Автомобиль не найден. Найдите клиента по телефону и добавьте ему автомобиль.</Body> : null}

      {draft.customer && draft.vehicle && !query ? <Button title={`Продолжить: ${draft.vehicle.plate}`} tone="secondary" onPress={() => router.push('/new/services')}/> : null}
      {draft.customer && !query ? <Button title="Начать заново" tone="quiet" onPress={() => reset({ channel: draft.channel })}/> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  bleed: { marginHorizontal: -space.l },
  chips: { gap: space.s, paddingHorizontal: space.l },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: space.m },
  name: { color: colors.text, fontSize: 19, fontWeight: '800', flexShrink: 1 },
  open: { color: colors.muted, fontSize: 24 },
  meta: { color: colors.muted, fontSize: 14 }
});
