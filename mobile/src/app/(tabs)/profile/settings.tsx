import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { CenterSettings } from '@df/types';
import { RemindersForm } from '@/features/reminders-form';
import { RequisitesForm } from '@/features/requisites-form';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Button, Chip, Heading, Loading, Notice, Screen } from '@/ui';
import { FlowHeader } from '@/ui/brand';
import { Text } from '@/ui/text';

const DAYS = [{ value: 1, short: 'Пн' }, { value: 2, short: 'Вт' }, { value: 3, short: 'Ср' }, { value: 4, short: 'Чт' }, { value: 5, short: 'Пт' }, { value: 6, short: 'Сб' }, { value: 0, short: 'Вс' }];
const STEPS = [15, 30, 60, 90, 120] as const;
const toMinutes = (value: string) => { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; };
const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
/** 9:00 rather than 09:00 where people read it. */
const clock = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
const hoursText = (minutes: number) => `${Math.floor(minutes / 60)} ч${minutes % 60 ? ` ${minutes % 60} мин` : ''}`;
/** The center's zone in words: the city and the offset now. */
function zoneName(timeZone: string) {
  const offset = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value.replace('GMT', 'UTC') ?? '';
  const city = ({ 'Europe/Moscow': 'Москва', 'Asia/Omsk': 'Омск', 'Asia/Novosibirsk': 'Новосибирск', 'Asia/Yekaterinburg': 'Екатеринбург', 'Europe/Samara': 'Самара', 'Europe/Kaliningrad': 'Калининград', 'Asia/Krasnoyarsk': 'Красноярск', 'Asia/Irkutsk': 'Иркутск', 'Asia/Vladivostok': 'Владивосток' } as Record<string, string>)[timeZone] ?? timeZone;
  return `${city}, ${offset === 'UTC' ? 'UTC+0' : offset}`;
}

/** Working days, hours, the booking step and how many cars at once: what free slots are made of. */
export default function SettingsScreen() {
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const { data, error, reload } = useResource(useCallback((signal: AbortSignal) => api.settings(signal), [api]));
  if (!data && !error) return <Loading label="Загружаем график…"/>;
  if (!data) return <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14 }}><FlowHeader title="График центра"/><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  return <SettingsForm key={JSON.stringify(data)} settings={data}/>;
}

function SettingsForm({ settings }: { settings: CenterSettings }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { api } = useSession();
  const session = useSignedIn();
  const [days, setDays] = useState(settings.workingDays);
  const [open, setOpen] = useState(toMinutes(settings.openTime));
  const [close, setClose] = useState(toMinutes(settings.closeTime));
  const [step, setStep] = useState(settings.slotStepMinutes);
  const [capacity, setCapacity] = useState(settings.simultaneousCapacity);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const touched = <T,>(setter: (value: T) => void) => (value: T) => { setter(value); setSaved(false); };
  const valid = days.length > 0 && close - open >= 60;
  const slots = valid ? Math.floor((close - open) / step) : 0;
  const save = async () => {
    setSaving(true); setError('');
    try {
      await api.updateSettings({ workingDays: days, openTime: toTime(open), closeTime: toTime(close), slotStepMinutes: step, simultaneousCapacity: capacity });
      setSaved(true);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };

  return (
    <Screen contentStyle={{ paddingTop: insets.top + 18, gap: 14 }}>
      <FlowHeader title="График центра" note={session.tenant.name}/>
      <Text style={styles.lead}>Эти параметры определяют свободное время для записи. Боксы выбирать не нужно.</Text>

      <View style={styles.sectionHead}><Heading>Рабочие дни</Heading><Text style={styles.meta}>{days.length} из 7</Text></View>
      <View style={styles.days}>
        {DAYS.map((day) => {
          const on = days.includes(day.value);
          return (
            <Pressable key={day.value} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={day.short}
              onPress={() => touched(setDays)(on ? days.filter((value) => value !== day.value) : [...days, day.value])} style={[styles.day, on && styles.dayOn]}>
              <Text style={[styles.dayText, on && styles.dayTextOn]}>{day.short}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.hours}>
        <TimeCard label="Открытие" value={open} onMinus={() => touched(setOpen)(Math.max(0, open - 30))} onPlus={() => touched(setOpen)(Math.min(close - 60, open + 30))}/>
        <TimeCard label="Закрытие" value={close} onMinus={() => touched(setClose)(Math.max(open + 60, close - 30))} onPlus={() => touched(setClose)(Math.min(24 * 60 - 30, close + 30))}/>
      </View>
      <View style={styles.card}>
        <View style={styles.dayBar} accessible accessibilityLabel={`Работа с ${clock(open)} до ${clock(close)}`}>
          <View style={[styles.workBand, { left: `${open / 14.4}%`, width: `${(close - open) / 14.4}%` }]}/>
          {[3, 6, 9, 12, 15, 18, 21].map((hour) => <View key={hour} style={[styles.tick, { left: `${hour / 0.24}%` }]}/>)}
        </View>
        <View style={styles.barLegend}>
          <Text style={styles.small}>0:00</Text>
          <Text style={styles.small}>{clock(open)} — {clock(close)} · {hoursText(close - open)}</Text>
          <Text style={styles.small}>24:00</Text>
        </View>
      </View>
      <Text style={[styles.meta, { paddingHorizontal: 4 }]}>Время центра: {zoneName(settings.timezone)}</Text>

      <View style={styles.sectionHead}><Heading>Шаг записи</Heading><Text style={styles.meta}>{slots} слотов в день</Text></View>
      <View style={styles.wrap}>{STEPS.map((value) => <Chip key={value} label={`${value} мин`} selected={step === value} onPress={() => touched(setStep)(value)}/>)}</View>

      <View style={[styles.card, styles.capacity]}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title}>Одновременно</Text>
          <Text style={styles.small}>Сколько автомобилей центр обслуживает сразу</Text>
        </View>
        <View style={styles.stepper}>
          <StepButton sign="−" label="Меньше автомобилей" onPress={() => touched(setCapacity)(Math.max(1, capacity - 1))}/>
          <Text style={styles.stepValue}>{capacity}</Text>
          <StepButton sign="+" label="Больше автомобилей" onPress={() => touched(setCapacity)(Math.min(20, capacity + 1))}/>
        </View>
      </View>
      {!valid ? <Notice>Выберите хотя бы один день и минимум час работы.</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      {saved ? <Notice tone="info">График сохранён. Свободное время уже пересчитано.</Notice> : null}
      <Button title="Сохранить график" busy={saving} disabled={!valid} onPress={() => void save()}/>

      <RemindersForm/>
      <RequisitesForm/>
    </Screen>
  );
}

function TimeCard({ label, value, onMinus, onPlus }: { label: string; value: number; onMinus: () => void; onPlus: () => void }) {
  const styles = useStyles();
  return (
    <View style={[styles.card, styles.timeCard]}>
      <Text style={styles.small}>{label}</Text>
      <Text style={styles.time}>{clock(value)}</Text>
      <View style={styles.timeButtons}>
        <StepButton sign="−" label={`${label} раньше`} onPress={onMinus} soft/>
        <StepButton sign="+" label={`${label} позже`} onPress={onPlus} soft/>
      </View>
    </View>
  );
}

function StepButton({ sign, label, onPress, soft }: { sign: string; label: string; onPress: () => void; soft?: boolean }) {
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={4} style={[styles.stepButton, soft && styles.stepButtonSoft]}>
      <Text style={styles.stepSign}>{sign}</Text>
    </Pressable>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  lead: { color: colors.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 4 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 4 },
  meta: { color: colors.muted, fontSize: 13 },
  small: { color: colors.muted, fontSize: 12 },
  days: { flexDirection: 'row', gap: 6 },
  day: { flex: 1, height: 48, borderRadius: 16, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', ...cardShadow(scheme) },
  dayOn: { backgroundColor: colors.pill },
  dayText: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  dayTextOn: { color: colors.pillInk },
  hours: { flexDirection: 'row', gap: 8 },
  card: { borderRadius: radius.l, backgroundColor: colors.surface, padding: 14, gap: 6, ...cardShadow(scheme) },
  timeCard: { flex: 1, paddingHorizontal: space.l, gap: 2 },
  time: { fontSize: 34, lineHeight: 42, fontWeight: '500', letterSpacing: -1, fontVariant: ['tabular-nums'] },
  timeButtons: { flexDirection: 'row', gap: 6, marginTop: 6 },
  dayBar: { height: 34, borderRadius: 12, backgroundColor: colors.soft, overflow: 'hidden' },
  workBand: { position: 'absolute', top: 0, bottom: 0, backgroundColor: colors.tilePeach },
  tick: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: colors.line },
  barLegend: { flexDirection: 'row', justifyContent: 'space-between' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  capacity: { flexDirection: 'row', alignItems: 'center', gap: space.m, padding: space.l },
  title: { fontSize: 15, fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 4, padding: 4, borderRadius: 24, backgroundColor: colors.soft },
  stepButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  stepButtonSoft: { backgroundColor: colors.soft },
  stepSign: { fontSize: 22, lineHeight: 26 },
  stepValue: { width: 32, textAlign: 'center', fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] }
}));
