import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { WorkOrder } from '@df/types';
import { money } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { cardShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Chip, Field, Heading, Notice } from '@/ui';
import { Icon } from '@/ui/icons';
import { ButtonPair, Sheet } from '@/ui/sheet';
import { Text } from '@/ui/text';

const PAUSE_REASONS = ['Ждём сушки', 'Нет материала', 'Перерыв', 'Ждём клиента'];
const LIGHT = '#F4F4F2';
const clock = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/**
 * The master's part of an order: assignment (for whoever assigns masters), start, the operations to tick,
 * a pause with a reason, and completion. Every answer from the server replaces the order on screen.
 */
export function WorkPanel({ order, onChanged }: { order: WorkOrder; onChanged: (order: WorkOrder) => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { api } = useSession();
  const session = useSignedIn();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [sheet, setSheet] = useState<'pause' | 'complete' | null>(null);
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
      <View style={styles.dark}><Text style={styles.darkTitle}>Смета согласована</Text><Text style={styles.darkNote}>Ждём назначения мастера.</Text></View>
    );
  }

  if (order.status === 'APPROVED' && order.assignment) {
    return (
      <View style={styles.dark}>
        <Text style={styles.darkNote}>Мастер</Text>
        <Text style={styles.darkTitle}>{order.assignment.masterName}</Text>
        {error ? <Notice>{error}</Notice> : null}
        {canWork ? <Button title="Начать работу" style={styles.lightButton} ink="#121212" busy={busy === 'start'} onPress={() => act('start', () => api.startWork(order.id))} testID="work-start"/>
          : <Text style={styles.darkNote}>Работу начинает мастер.</Text>}
      </View>
    );
  }

  if (!work) return null;
  const operations = work.operations;
  const done = operations.filter((operation) => operation.status === 'DONE').length;
  const paused = work.status === 'PAUSED';
  const editable = canWork && order.status === 'IN_PROGRESS' && !paused;
  const next = operations.find((operation) => operation.status !== 'DONE');

  return (
    <View style={{ gap: 14 }}>
      <View style={styles.dark}>
        <View style={styles.darkTop}>
          <View style={[styles.state, { backgroundColor: paused ? colors.warn : colors.accent }]}><Text style={styles.stateText}>{paused ? 'Пауза' : order.status === 'IN_PROGRESS' ? 'В работе' : 'Работы завершены'}</Text></View>
          <Text style={styles.darkNote}>с {clock(work.startedAt)}</Text>
        </View>
        <View style={styles.darkMiddle}>
          <View>
            <Text style={styles.darkCount}>{done} из {operations.length}</Text>
            <Text style={styles.darkNote}>операций выполнено</Text>
          </View>
          {order.assignment ? <Text style={[styles.darkNote, { textAlign: 'right' }]}>Мастер{'\n'}<Text style={styles.darkName}>{order.assignment.masterName}</Text></Text> : null}
        </View>
        <View style={styles.bars} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: operations.length, now: done }}>
          {operations.map((operation) => (
            <View key={operation.id} style={[styles.bar, { backgroundColor: operation.status === 'DONE' ? LIGHT : operation.id === next?.id && !paused ? colors.accent : 'rgba(255,255,255,0.15)' }]}/>
          ))}
        </View>
        {paused ? <Text style={styles.darkNote}>Причина паузы: {work.pauseNote || 'не указана'}</Text> : null}
      </View>

      <View style={styles.sectionHead}><Heading>Операции</Heading><Text style={styles.meta}>{editable ? 'отмечайте по ходу' : paused ? 'на паузе' : ''}</Text></View>
      <View style={styles.list}>
        {operations.map((operation, index) => {
          const isDone = operation.status === 'DONE';
          return (
            <Pressable key={operation.id} disabled={!editable || busy !== null} accessibilityRole="checkbox" accessibilityState={{ checked: isDone, disabled: !editable }}
              style={[styles.operation, index > 0 && styles.operationLine]} testID={`operation-${operation.id}`}
              onPress={async () => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                await act(`op-${operation.id}`, () => api.updateOperation(order.id, operation.id, isDone ? 'PENDING' : 'DONE'));
              }}>
              <View style={[styles.box, isDone && styles.boxDone]}>{isDone ? <Icon name="check" size={16} color={colors.pillInk} strokeWidth={2.2}/> : null}</View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.operationName, isDone && styles.operationDone]}>{operation.name}</Text>
                {operation.source === 'qc_rework' || operation.amountMinor ? <Text style={styles.meta}>{[money(operation.amountMinor), operation.source === 'qc_rework' ? 'доработка' : null].filter(Boolean).join(' · ')}</Text> : null}
              </View>
              {busy === `op-${operation.id}` ? <Text style={styles.meta}>…</Text> : operation.id === next?.id && editable ? <Text style={styles.now}>сейчас</Text> : null}
            </Pressable>
          );
        })}
      </View>
      {error ? <Notice>{error}</Notice> : null}

      {canWork && order.status === 'IN_PROGRESS' ? (paused ? (
        <Button title="Продолжить работу" busy={busy === 'resume'} onPress={() => act('resume', () => api.resumeWork(order.id))} testID="work-resume"/>
      ) : <>
        {done < operations.length ? <Text style={styles.meta}>Завершить можно, когда отмечены все операции.</Text> : null}
        <ButtonPair>
          <Button title="Пауза" tone="secondary" style={{ flex: 1 }} onPress={() => setSheet('pause')} testID="work-pause"/>
          <Button title="Завершить" style={{ flex: 1.4 }} disabled={done < operations.length} busy={busy === 'complete'} testID="work-complete" onPress={() => setSheet('complete')}/>
        </ButtonPair>
      </>) : null}

      <Sheet visible={sheet === 'pause'} title="Причина паузы" note="Видно администратору в заказе" onClose={() => setSheet(null)}>
        <View style={styles.wrap}>{PAUSE_REASONS.map((value) => <Chip key={value} label={value} selected={reason === value} onPress={() => setReason(value)}/>)}</View>
        <Field label="Своими словами" value={reason} onChangeText={setReason} placeholder="Например, ждём сушки" testID="pause-reason"/>
        <ButtonPair>
          <Button title="Отмена" tone="secondary" style={{ flex: 1 }} onPress={() => setSheet(null)}/>
          <Button title="Поставить паузу" style={{ flex: 1.4 }} disabled={!reason.trim()} busy={busy === 'pause'} testID="pause-confirm"
            onPress={async () => { if (await act('pause', () => api.pauseWork(order.id, reason.trim()))) { setSheet(null); setReason(''); } }}/>
        </ButtonPair>
      </Sheet>
      <Sheet visible={sheet === 'complete'} title="Завершить работы?" note="Заказ перейдёт к выдаче. Отметки операций после этого не меняются." onClose={() => setSheet(null)}>
        <ButtonPair>
          <Button title="Отмена" tone="secondary" style={{ flex: 1 }} onPress={() => setSheet(null)}/>
          <Button title="Завершить" style={{ flex: 1.4 }} busy={busy === 'complete'} testID="work-complete-confirm"
            onPress={async () => { if (await act('complete', () => api.completeWork(order.id))) { setSheet(null); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } }}/>
        </ButtonPair>
      </Sheet>
    </View>
  );
}

function AssignMaster({ order, busy, act, error }: { order: WorkOrder; busy: string | null; act: (key: string, action: () => Promise<WorkOrder>) => Promise<boolean>; error: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { api } = useSession();
  const { data, error: loadError } = useResource(useCallback((signal: AbortSignal) => api.listMasters(signal), [api]));
  const masters = data?.items ?? null;
  return (
    <View style={{ gap: space.m }}>
      <View style={styles.sectionHead}><Heading>Назначьте мастера</Heading><Text style={styles.meta}>смета согласована</Text></View>
      {error || loadError ? <Notice>{error || loadError}</Notice> : null}
      {masters === null && !loadError ? <Body muted>Загружаем мастеров…</Body> : null}
      {masters?.length === 0 ? <Body muted>В команде нет мастеров. Добавьте сотрудника с ролью «Мастер»: Профиль → Команда и роли.</Body> : null}
      {masters?.map((master) => (
        <Pressable key={master.id} accessibilityRole="button" disabled={busy !== null} onPress={() => act(`assign-${master.id}`, () => api.assignMaster(order.id, master.id))}
          style={styles.master} testID={`assign-${master.id}`}>
          <View style={{ flex: 1 }}>
            <Text style={styles.operationName}>{master.displayName}</Text>
            <Text style={styles.meta}>{busy === `assign-${master.id}` ? 'Назначаем…' : `в работе: ${master.activeOrders}`}</Text>
          </View>
          <Icon name="chevronRight" size={18} color={colors.muted}/>
        </Pressable>
      ))}
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  dark: { borderRadius: 28, backgroundColor: colors.darkCard, padding: 18, gap: 14, ...cardShadow(scheme) },
  darkTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  state: { height: 26, paddingHorizontal: 10, borderRadius: 13, justifyContent: 'center' },
  stateText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  darkMiddle: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  darkCount: { color: LIGHT, fontSize: 44, lineHeight: 48, fontWeight: '500', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
  darkTitle: { color: LIGHT, fontSize: 20, fontWeight: '600' },
  darkName: { color: LIGHT, fontWeight: '700' },
  darkNote: { color: LIGHT, fontSize: 13, opacity: 0.7 },
  bars: { flexDirection: 'row', gap: 4 },
  bar: { flex: 1, height: 6, borderRadius: 3 },
  lightButton: { backgroundColor: LIGHT },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  meta: { color: colors.muted, fontSize: 13 },
  list: { borderRadius: radius.l, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingVertical: 4, ...cardShadow(scheme) },
  operation: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: 8 },
  operationLine: { borderTopWidth: 1, borderTopColor: colors.line },
  box: { width: 26, height: 26, borderRadius: 9, borderWidth: 1.5, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  boxDone: { backgroundColor: colors.pill, borderColor: colors.pill },
  operationName: { fontSize: 15, fontWeight: '600' },
  operationDone: { color: colors.muted, fontWeight: '400', textDecorationLine: 'line-through' },
  now: { color: colors.accent, fontSize: 12, fontWeight: '700' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  master: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m, borderRadius: radius.m, backgroundColor: colors.surface, ...cardShadow(scheme) }
}));
