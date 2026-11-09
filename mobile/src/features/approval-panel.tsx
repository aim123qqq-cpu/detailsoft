import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { EstimateVersion, WorkOrder } from '@df/types';
import { useSession, useSignedIn } from '@/lib/session';
import { makeStyles, space } from '@/lib/theme';
import { Button, Field, Notice } from '@/ui';
import { ButtonPair } from '@/ui/sheet';
import { Text } from '@/ui/text';
import { Segmented } from './booking-ui';

const METHODS = [{ value: 'in_person', label: 'Лично' }, { value: 'phone', label: 'По телефону' }, { value: 'messenger', label: 'В мессенджере' }] as const;

/** The customer's decision on the current estimate version: how it was agreed and who recorded it. */
export function ApprovalPanel({ order, estimate, onChanged }: { order: WorkOrder; estimate: EstimateVersion; onChanged: (order: WorkOrder) => void }) {
  const styles = useStyles();
  const { api } = useSession();
  const session = useSignedIn();
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('in_person');
  const [responsible, setResponsible] = useState(session.actor.displayName);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [error, setError] = useState('');
  const ready = responsible.trim().length >= 2;

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    setBusy(decision); setError('');
    try {
      onChanged(await api.decideEstimate(order.id, { estimateVersionId: estimate.id, decision, method, responsible: responsible.trim() }));
      void Haptics.notificationAsync(decision === 'APPROVED' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <View style={{ gap: space.m }}>
      <Segmented value={method} onChange={setMethod} options={[...METHODS]}/>
      {editing || !ready
        ? <Field label="Кто записывает решение" required value={responsible} onChangeText={setResponsible}/>
        : <Pressable accessibilityRole="button" onPress={() => setEditing(true)} hitSlop={6}>
            <Text style={styles.note}>Записывает: {responsible} · <Text style={styles.link}>изменить</Text></Text>
          </Pressable>}
      {error ? <Notice>{error}</Notice> : null}
      <ButtonPair>
        <Button title="Отказался" tone="secondary" style={{ flex: 1 }} busy={busy === 'REJECTED'} disabled={busy !== null || !ready} onPress={() => void decide('REJECTED')}/>
        <Button title="Клиент согласовал" style={{ flex: 1.5 }} busy={busy === 'APPROVED'} disabled={busy !== null || !ready} onPress={() => void decide('APPROVED')}/>
      </ButtonPair>
      <Text style={styles.note}>Согласуется только актуальная версия. После отказа можно выпустить новую.</Text>
    </View>
  );
}

const useStyles = makeStyles((colors) => StyleSheet.create({
  note: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  link: { color: colors.ink, fontWeight: '700' }
}));
