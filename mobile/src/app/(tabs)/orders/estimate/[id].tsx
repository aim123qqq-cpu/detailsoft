import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import type { Booking, EstimateLineInput, WorkOrder } from '@df/types';
import { money } from '@/lib/format';
import { useSession } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Field, Label, Loading, Notice, Screen } from '@/ui';

type Line = {
  key: string;
  sourceType: EstimateLineInput['sourceType'];
  sourceId: string | null;
  name: string;
  /** Rubles as typed. */
  amount: string;
  durationMinutes: number;
  reason: string | null;
  included: boolean;
  /** The note under the name: where the line came from. */
  origin: string;
};

const rubles = (amountMinor: number) => String(Math.round(amountMinor / 100));
const minor = (amount: string) => Math.round(Number(amount.replace(/[^\d]/g, '') || '0') * 100);

/** A new estimate version: the booking's services, the intake recommendations with a price, own lines. */
export default function EstimateScreen() {
  const { id, title } = useLocalSearchParams<{ id: string; title?: string }>();
  const { api } = useSession();
  const { data, error, reload } = useResource(useCallback(async (signal: AbortSignal) => {
    const order = await api.getOrder(id, signal);
    const booking = order.bookingId ? await api.getBooking(order.bookingId, signal).catch(() => null) : null;
    return { order, booking };
  }, [api, id]));

  if (!data && !error) return <Loading label="Готовим смету…"/>;
  if (!data) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;
  return <EstimateForm key={data.order.id} order={data.order} booking={data.booking} title={title}/>;
}

function initialLines(order: WorkOrder, booking: Booking | null): Line[] {
  // The previous version (after a refusal) is the starting point; otherwise the booking and the intake.
  const previous = order.estimateVersions.at(-1);
  if (previous) return previous.lines.map((line) => ({
    key: line.id, sourceType: line.sourceType, sourceId: line.sourceId ?? null, name: line.name, amount: rubles(line.amountMinor),
    durationMinutes: line.durationMinutes, reason: line.reason ?? null, included: true, origin: `из версии ${previous.version}`
  }));
  const fromBooking: Line[] = (booking?.lines ?? []).filter((line) => !line.excluded).map((line) => ({
    key: `${line.type}-${line.id}`, sourceType: line.type, sourceId: line.id, name: line.name, amount: rubles(line.amountMinor),
    durationMinutes: line.durationMinutes, reason: null, included: true, origin: line.pricingMode === 'fixed' ? 'из записи' : 'из записи · цена после осмотра'
  }));
  const fromIntake: Line[] = (order.intake?.recommendations ?? []).map((item, index) => ({
    key: `recommendation-${index}`, sourceType: 'recommendation', sourceId: null, name: item.title, amount: '', durationMinutes: 25,
    reason: item.reason, included: true, origin: 'рекомендация по осмотру'
  }));
  return [...fromBooking, ...fromIntake];
}

function EstimateForm({ order, booking, title }: { order: WorkOrder; booking: Booking | null; title?: string }) {
  const { api } = useSession();
  const [lines, setLines] = useState<Line[]>(() => initialLines(order, booking));
  const [customName, setCustomName] = useState('');
  const [customAmount, setCustomAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const patch = (key: string, change: Partial<Line>) => setLines((list) => list.map((line) => line.key === key ? { ...line, ...change } : line));
  const chosen = lines.filter((line) => line.included);
  const unpriced = chosen.filter((line) => line.sourceType === 'recommendation' && minor(line.amount) <= 0);
  const total = chosen.reduce((sum, line) => sum + minor(line.amount), 0);
  const version = order.estimateVersions.length + 1;

  const addCustom = () => {
    setLines((list) => [...list, { key: `custom-${Date.now()}`, sourceType: 'custom', sourceId: null, name: customName.trim(), amount: customAmount, durationMinutes: 30, reason: null, included: true, origin: 'добавлено вручную' }]);
    setCustomName(''); setCustomAmount('');
  };
  const issue = async () => {
    setSaving(true); setError('');
    try {
      await api.createEstimate(order.id, chosen.map((line) => ({
        sourceType: line.sourceType, sourceId: line.sourceId, name: line.name.trim(), amountMinor: minor(line.amount), durationMinutes: line.durationMinutes,
        ...(line.reason ? { reason: line.reason } : {})
      })));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (failure) {
      setError((failure as Error).message);
      setSaving(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: title ? `Смета · ${title}` : 'Смета' }}/>
      <Body muted>Версия {version}. После выпуска строки этой версии не меняются; если клиент откажется, составьте новую.</Body>
      <View style={styles.list}>
        {lines.map((line) => (
          <View key={line.key} style={[styles.line, !line.included && styles.off]}>
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: line.included }} accessibilityLabel={line.name} hitSlop={6}
              onPress={() => patch(line.key, { included: !line.included })} style={[styles.check, line.included && styles.checkOn]}>
              {line.included ? <Text style={styles.checkMark}>✓</Text> : null}
            </Pressable>
            <View style={styles.lineBody}>
              <Text style={styles.lineName}>{line.name}</Text>
              <Text style={styles.origin}>{line.origin}</Text>
            </View>
            <View style={styles.amountBox}>
              <TextInput value={line.amount} onChangeText={(value) => patch(line.key, { amount: value.replace(/[^\d]/g, '') })} keyboardType="number-pad"
                placeholder="0" placeholderTextColor={colors.soft} editable={line.included} accessibilityLabel={`Сумма: ${line.name}`}
                style={styles.amountInput} selectionColor={colors.primary}/>
              <Text style={styles.rub}>₽</Text>
            </View>
          </View>
        ))}
        {!lines.length ? <Body muted>В записи нет услуг. Добавьте строки сметы ниже.</Body> : null}
      </View>

      <Card>
        <Label>Добавить строку</Label>
        <Field label="Работа" value={customName} onChangeText={setCustomName} placeholder="Например, удаление битума"/>
        <Field label="Сумма, ₽" value={customAmount} onChangeText={(value) => setCustomAmount(value.replace(/[^\d]/g, ''))} keyboardType="number-pad" placeholder="0"/>
        <Button title="Добавить" tone="secondary" disabled={customName.trim().length < 2 || !customAmount} onPress={addCustom}/>
      </Card>

      <View style={styles.totalRow}><Text style={styles.totalLabel}>Итого, версия {version}</Text><Text style={styles.total}>{money(total)}</Text></View>
      {unpriced.length ? <Notice tone="info">Укажите сумму для «{unpriced[0].name}» или снимите отметку.</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}
      <Button title="Выпустить смету" busy={saving} disabled={!chosen.length || unpriced.length > 0 || chosen.some((line) => !line.name.trim())} onPress={() => void issue()}/>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.s },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.l, padding: space.m },
  off: { opacity: 0.55 },
  check: { width: 26, height: 26, borderRadius: 7, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkMark: { color: colors.primaryInk, fontSize: 14, fontWeight: '900' },
  lineBody: { flex: 1, gap: 2 },
  lineName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  origin: { color: colors.soft, fontSize: 13 },
  amountBox: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.surfaceRaised, borderRadius: radius.s, paddingHorizontal: space.s },
  amountInput: { minWidth: 72, minHeight: 44, color: colors.text, fontSize: 16, fontWeight: '700', textAlign: 'right', fontVariant: ['tabular-nums'] },
  rub: { color: colors.muted, fontSize: 15 },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  totalLabel: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  total: { color: colors.text, fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'] }
});
