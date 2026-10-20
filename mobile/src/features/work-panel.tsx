import { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { WorkOrder } from '@df/types';
import { money } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { colors, radius, space } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Card, Chip, Field, Label, Notice } from '@/ui';

const PAUSE_REASONS = ['Ждём сушки', 'Нет материала', 'Перерыв', 'Ждём клиента'];

/**
 * The master's part of an order: assignment (for whoever assigns masters), start, the checklist,
 * pause with a reason, and completion. Every answer from the server replaces the order on screen.
 */
export function WorkPanel({ order, onChanged }: { order: WorkOrder; onChanged: (order: WorkOrder) => void }) {
  const { api } = useSession();
  const session = useSignedIn();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState('');

  const act = async (key: string, action: () => Promise<WorkOrder>) => {
    setBusy(key); setError('');
    try { onChanged(await action()); return true; }
    catch (failure) { setError((failure as Error).message); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); return false; }
    finally { setBusy(null); }
  };

  const canWork = session.capabilities.performWork;
  const work = order.work;

  if (order.status === 'APPROVED' && !order.assignment) {
    return session.capabilities.assignMasters ? <AssignMaster order={order} busy={busy} act={act} error={error}/> : (
      <Card><Label>Работы</Label><Body muted>Смета согласована. Ждём назначения мастера.</Body></Card>
    );
  }

  if (order.status === 'APPROVED' && order.assignment) {
    return (
      <Card>
        <Label>Работы</Label>
        <Body>Мастер: {order.assignment.masterName}</Body>
        {error ? <Notice>{error}</Notice> : null}
        {canWork ? <Button title="Начать работу" busy={busy === 'start'} onPress={() => act('start', () => api.startWork(order.id))} testID="work-start"/>
          : <Body muted>Работу начинает мастер.</Body>}
      </Card>
    );
  }

  if (!work) return null;
  const operations = work.operations;
  const done = operations.filter((operation) => operation.status === 'DONE').length;
  const paused = work.status === 'PAUSED';
  const editable = canWork && order.status === 'IN_PROGRESS' && !paused;

  return (
    <Card>
      <View style={styles.head}>
        <Label>Работы{order.assignment ? ` · ${order.assignment.masterName}` : ''}</Label>
        <Text style={styles.count}>{done}/{operations.length}</Text>
      </View>
      <View style={styles.track} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: operations.length, now: done }}>
        <View style={[styles.fill, { width: `${operations.length ? (done / operations.length) * 100 : 0}%` }]}/>
      </View>
      {paused ? <Notice tone="info">Пауза: {work.pauseNote || 'без причины'}</Notice> : null}
      {error ? <Notice>{error}</Notice> : null}

      {operations.map((operation) => {
        const isDone = operation.status === 'DONE';
        return (
          <Pressable key={operation.id} disabled={!editable || busy !== null} accessibilityRole="checkbox" accessibilityState={{ checked: isDone, disabled: !editable }}
            android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={[styles.operation, isDone && styles.operationDone]} testID={`operation-${operation.id}`}
            onPress={async () => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              await act(`op-${operation.id}`, () => api.updateOperation(order.id, operation.id, isDone ? 'PENDING' : 'DONE'));
            }}>
            <View style={[styles.box, isDone && styles.boxDone]}>{isDone ? <Text style={styles.tick}>✓</Text> : null}</View>
            <View style={{ flex: 1 }}>
              <Text style={[styles.operationName, isDone && styles.operationNameDone]}>{operation.name}</Text>
              <Text style={styles.operationMeta}>{money(operation.amountMinor)}{operation.source === 'qc_rework' ? ' · доработка' : ''}</Text>
            </View>
            {busy === `op-${operation.id}` ? <Text style={styles.operationMeta}>…</Text> : null}
          </Pressable>
        );
      })}

      {canWork && order.status === 'IN_PROGRESS' && (paused ? (
        <Button title="Продолжить работу" busy={busy === 'resume'} onPress={() => act('resume', () => api.resumeWork(order.id))} testID="work-resume"/>
      ) : pausing ? (
        <View style={{ gap: space.s }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s }}>
            {PAUSE_REASONS.map((value) => <Chip key={value} label={value} selected={reason === value} onPress={() => setReason(value)}/>)}
          </ScrollView>
          <Field label="Причина паузы" value={reason} onChangeText={setReason} placeholder="Например, ждём сушки" testID="pause-reason"/>
          <View style={styles.row}>
            <Button title="Отмена" tone="secondary" style={{ flex: 1 }} onPress={() => setPausing(false)}/>
            <Button title="Поставить паузу" style={{ flex: 1 }} disabled={!reason.trim()} busy={busy === 'pause'} testID="pause-confirm"
              onPress={async () => { if (await act('pause', () => api.pauseWork(order.id, reason.trim()))) { setPausing(false); setReason(''); } }}/>
          </View>
        </View>
      ) : (
        <View style={styles.row}>
          <Button title="Пауза" tone="secondary" style={{ flex: 1 }} onPress={() => setPausing(true)} testID="work-pause"/>
          <Button title="Завершить" style={{ flex: 1.4 }} disabled={done < operations.length} busy={busy === 'complete'} testID="work-complete"
            onPress={() => Alert.alert('Завершить работы?', 'Заказ перейдёт к выдаче. Отметки операций после этого не меняются.', [
              { text: 'Отмена', style: 'cancel' },
              { text: 'Завершить', onPress: async () => { if (await act('complete', () => api.completeWork(order.id))) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } }
            ])}/>
        </View>
      ))}
      {canWork && order.status === 'IN_PROGRESS' && !paused && done < operations.length ? <Body muted>Завершить можно, когда отмечены все операции.</Body> : null}
    </Card>
  );
}

function AssignMaster({ order, busy, act, error }: { order: WorkOrder; busy: string | null; act: (key: string, action: () => Promise<WorkOrder>) => Promise<boolean>; error: string }) {
  const { api } = useSession();
  const { data, error: loadError } = useResource(useCallback((signal: AbortSignal) => api.listMasters(signal), [api]));
  const masters = data?.items ?? null;
  return (
    <Card>
      <Label>Назначить мастера</Label>
      {error || loadError ? <Notice>{error || loadError}</Notice> : null}
      {masters === null && !loadError ? <Body muted>Загружаем мастеров…</Body> : null}
      {masters?.length === 0 ? <Body muted>В команде нет мастеров. Добавьте сотрудника с ролью «Мастер» в веб-версии: Профиль → Команда.</Body> : null}
      {masters?.map((master) => (
        <Pressable key={master.id} accessibilityRole="button" disabled={busy !== null} onPress={() => act(`assign-${master.id}`, () => api.assignMaster(order.id, master.id))}
          android_ripple={{ color: 'rgba(255,255,255,.06)' }} style={styles.master} testID={`assign-${master.id}`}>
          <Text style={styles.masterName}>{master.displayName}</Text>
          <Text style={styles.operationMeta}>{busy === `assign-${master.id}` ? 'Назначаем…' : `в работе: ${master.activeOrders}`}</Text>
        </Pressable>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  count: { color: colors.text, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3, backgroundColor: colors.primary },
  operation: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.m, borderRadius: radius.m, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  operationDone: { backgroundColor: 'rgba(54,201,150,.1)' },
  box: { width: 28, height: 28, borderRadius: 8, borderWidth: 2, borderColor: colors.soft, alignItems: 'center', justifyContent: 'center' },
  boxDone: { backgroundColor: colors.ok, borderColor: colors.ok },
  tick: { color: colors.okInk, fontSize: 16, fontWeight: '900' },
  operationName: { color: colors.text, fontSize: 16, fontWeight: '700' },
  operationNameDone: { color: colors.muted },
  operationMeta: { color: colors.muted, fontSize: 13, marginTop: 2 },
  row: { flexDirection: 'row', gap: space.s },
  master: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.l, borderRadius: radius.m, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  masterName: { color: colors.text, fontSize: 16, fontWeight: '700' }
});
