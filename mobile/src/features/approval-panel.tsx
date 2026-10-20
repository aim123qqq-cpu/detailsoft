import { useState } from 'react';
import { View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { EstimateVersion, WorkOrder } from '@df/types';
import { useSession, useSignedIn } from '@/lib/session';
import { space } from '@/lib/theme';
import { Body, Button, Card, Chip, Field, Label, Notice } from '@/ui';

const METHODS = [{ value: 'in_person', label: 'Лично' }, { value: 'phone', label: 'По телефону' }, { value: 'messenger', label: 'В мессенджере' }] as const;

/** The customer's decision on the current estimate version: how it was agreed and who recorded it. */
export function ApprovalPanel({ order, estimate, onChanged }: { order: WorkOrder; estimate: EstimateVersion; onChanged: (order: WorkOrder) => void }) {
  const { api } = useSession();
  const session = useSignedIn();
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('in_person');
  const [responsible, setResponsible] = useState(session.actor.displayName);
  const [busy, setBusy] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [error, setError] = useState('');

  const decide = async (decision: 'APPROVED' | 'REJECTED') => {
    setBusy(decision); setError('');
    try {
      onChanged(await api.decideEstimate(order.id, { estimateVersionId: estimate.id, decision, method, responsible: responsible.trim() }));
      void Haptics.notificationAsync(decision === 'APPROVED' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(null); }
  };

  return (
    <Card>
      <Label>Решение клиента по смете v{estimate.version}</Label>
      <Body muted>Согласуется только актуальная версия. После отказа можно выпустить новую.</Body>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.s }}>
        {METHODS.map((item) => <Chip key={item.value} label={item.label} selected={method === item.value} onPress={() => setMethod(item.value)}/>)}
      </View>
      <Field label="Ответственный" value={responsible} onChangeText={setResponsible}/>
      {error ? <Notice>{error}</Notice> : null}
      <Button title="Клиент согласовал" busy={busy === 'APPROVED'} disabled={busy !== null || responsible.trim().length < 2} onPress={() => void decide('APPROVED')}/>
      <Button title="Клиент отказался" tone="dangerQuiet" busy={busy === 'REJECTED'} disabled={busy !== null || responsible.trim().length < 2} onPress={() => void decide('REJECTED')}/>
    </Card>
  );
}
