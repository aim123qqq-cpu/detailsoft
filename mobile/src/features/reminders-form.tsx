import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Text } from '@/ui/text';
import type { ReminderSettings } from '@df/types';
import { useSession } from '@/lib/session';
import { cardShadow, makeStyles, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Button, Chip, Field, Heading, Notice } from '@/ui';
import { Toggle } from '@/ui/toggle';

const BEFORE: { value: ReminderSettings['beforeMinutes']; label: string }[] = [
  { value: null, label: 'Не напоминать' }, { value: 15, label: '15 мин' }, { value: 30, label: '30 мин' },
  { value: 60, label: '1 час' }, { value: 120, label: '2 часа' }, { value: 180, label: '3 часа' }
];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** What the center's people are reminded of: before each booking, the plan of the day, tomorrow's bookings. */
export function RemindersForm() {
  const styles = useStyles();
  const { api } = useSession();
  const loaded = useResource(useCallback((signal: AbortSignal) => api.reminderSettings(signal), [api]));
  const [edited, setEdited] = useState<ReminderSettings | null>(null);
  const value = edited ?? loaded.data ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  if (!value) return loaded.error ? <Notice>{loaded.error}</Notice> : null;
  const change = (next: ReminderSettings) => { setEdited(next); setSaved(false); };
  const valid = TIME.test(value.morning.time) && TIME.test(value.evening.time);
  const save = async () => {
    setSaving(true); setError('');
    try { setEdited(await api.updateReminderSettings(value)); setSaved(true); }
    catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  };
  const digest = (key: 'morning' | 'evening', title: string, note: string) => (
    <View style={[styles.digest, key === 'evening' && styles.line]}>
      <View style={styles.toggle}>
        <View style={{ flex: 1, gap: 2 }}><Text style={styles.title}>{title}</Text><Text style={styles.small}>{note}</Text></View>
        <Toggle value={value[key].enabled} onValueChange={(enabled) => change({ ...value, [key]: { ...value[key], enabled } })} label={title} testID={`reminder-${key}`}/>
      </View>
      {value[key].enabled ? <Field label="Время (ЧЧ:ММ)" value={value[key].time} keyboardType="numbers-and-punctuation" maxLength={5}
        onChangeText={(time) => change({ ...value, [key]: { ...value[key], time } })}/> : null}
    </View>
  );

  return (
    <View style={{ gap: space.m }}>
      <Heading style={{ marginTop: space.m }}>Напоминания о записях</Heading>
      <Text style={styles.lead}>Приходят тем, кто ведёт записи: в DetailFlow и копией в Telegram или MAX. Имён и телефонов клиентов в них нет.</Text>
      <Text style={styles.small}>Перед каждой записью</Text>
      <View style={styles.chips}>{BEFORE.map((option) => (
        <Chip key={String(option.value)} label={option.label} selected={value.beforeMinutes === option.value} onPress={() => change({ ...value, beforeMinutes: option.value })}/>
      ))}</View>
      <View style={styles.card}>
        {digest('morning', 'План дня утром', 'Список записей на сегодня')}
        {digest('evening', 'Сводка вечером', 'Сколько записей завтра')}
      </View>
      {error ? <Notice>{error}</Notice> : null}
      {saved ? <Notice tone="info">Напоминания сохранены.</Notice> : null}
      <Button title="Сохранить напоминания" busy={saving} disabled={!valid} onPress={() => void save()} testID="save-reminders"/>
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  lead: { color: colors.muted, fontSize: 13, lineHeight: 19, paddingHorizontal: 4 },
  card: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingVertical: 4, ...cardShadow(scheme) },
  digest: { gap: space.s, paddingVertical: 8 },
  line: { borderTopWidth: 1, borderTopColor: colors.line },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: 44 },
  title: { fontSize: 15, fontWeight: '600' },
  small: { color: colors.muted, fontSize: 12 }
}));
