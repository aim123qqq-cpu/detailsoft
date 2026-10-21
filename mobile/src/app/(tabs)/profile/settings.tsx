import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Stack } from 'expo-router';
import type { CenterSettings } from '@df/types';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Chip, Label, Loading, Notice, Screen } from '@/ui';

const DAYS = [{ value: 1, short: 'Пн' }, { value: 2, short: 'Вт' }, { value: 3, short: 'Ср' }, { value: 4, short: 'Чт' }, { value: 5, short: 'Пт' }, { value: 6, short: 'Сб' }, { value: 0, short: 'Вс' }];
const STEPS = [15, 30, 60, 90, 120] as const;
const toMinutes = (value: string) => { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; };
const toTime = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Working days, hours, the booking step and how many cars at once: what free slots are made of. */
export default function SettingsScreen() {
  const { api } = useSession();
  const { data, error, reload } = useResource(useCallback((signal: AbortSignal) => api.settings(signal), [api]));
  if (!data && !error) return <Loading label="Загружаем график…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  return <SettingsForm key={JSON.stringify(data)} settings={data}/>;
}

function SettingsForm({ settings }: { settings: CenterSettings }) {
  const { api } = useSession();
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
    <Screen>
      <Stack.Screen options={{ title: 'График центра' }}/>
      <Body muted>Эти параметры определяют свободное время для записи. Боксы выбирать не нужно.</Body>
      <View>
        <Label>Рабочие дни · {days.length} из 7</Label>
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
      </View>
      <View style={styles.hours}>
        <Stepper label="Открытие" value={toTime(open)} onMinus={() => touched(setOpen)(Math.max(0, open - 30))} onPlus={() => touched(setOpen)(Math.min(close - 60, open + 30))}/>
        <Stepper label="Закрытие" value={toTime(close)} onMinus={() => touched(setClose)(Math.max(open + 60, close - 30))} onPlus={() => touched(setClose)(Math.min(24 * 60 - 30, close + 30))}/>
      </View>
      <Text style={styles.zone}>Время центра: {settings.timezone === 'Europe/Moscow' ? 'Москва, UTC+3' : settings.timezone}</Text>
      <View>
        <Label>Шаг записи · {slots} слотов в день</Label>
        <View style={styles.wrap}>{STEPS.map((value) => <Chip key={value} label={`${value} мин`} selected={step === value} onPress={() => touched(setStep)(value)}/>)}</View>
      </View>
      <View style={styles.capacity}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Одновременно</Text>
          <Text style={styles.note}>Сколько автомобилей центр обслуживает сразу</Text>
        </View>
        <Stepper value={String(capacity)} onMinus={() => touched(setCapacity)(Math.max(1, capacity - 1))} onPlus={() => touched(setCapacity)(Math.min(20, capacity + 1))}/>
      </View>
      {!valid ? <Notice>Выберите хотя бы один день и минимум час работы.</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      {saved ? <Notice tone="info">График сохранён. Свободное время уже пересчитано.</Notice> : null}
      <Button title="Сохранить график" busy={saving} disabled={!valid} onPress={() => void save()}/>
    </Screen>
  );
}

function Stepper({ label, value, onMinus, onPlus }: { label?: string; value: string; onMinus: () => void; onPlus: () => void }) {
  return (
    <View style={styles.stepperBox}>
      {label ? <Text style={styles.note}>{label}</Text> : null}
      <View style={styles.stepper}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${label ?? ''} меньше`} onPress={onMinus} hitSlop={6} style={styles.stepButton}><Text style={styles.stepSign}>−</Text></Pressable>
        <Text style={styles.stepValue}>{value}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`${label ?? ''} больше`} onPress={onPlus} hitSlop={6} style={styles.stepButton}><Text style={styles.stepSign}>+</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  days: { flexDirection: 'row', gap: 6 },
  day: { flex: 1, minHeight: 48, borderRadius: radius.m, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  dayOn: { backgroundColor: colors.primary },
  dayText: { color: colors.muted, fontSize: 15, fontWeight: '800' },
  dayTextOn: { color: colors.primaryInk },
  hours: { flexDirection: 'row', gap: space.m },
  zone: { color: colors.soft, fontSize: 13 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  capacity: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.l, padding: space.l },
  title: { color: colors.text, fontSize: 16, fontWeight: '700' },
  note: { color: colors.muted, fontSize: 13 },
  stepperBox: { flex: 1, gap: 6 },
  stepper: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface, borderRadius: radius.m, padding: 4 },
  stepButton: { width: 44, height: 44, borderRadius: radius.s, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  stepSign: { color: colors.text, fontSize: 22, fontWeight: '700' },
  stepValue: { color: colors.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'], paddingHorizontal: space.s }
});
