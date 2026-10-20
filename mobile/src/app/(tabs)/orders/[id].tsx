import { useCallback } from 'react';
import { RefreshControl, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { carLayout, findLayoutElement } from '@df/shared/carLayouts';
import { money, orderStatuses, shortDate } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { useResource } from '@/lib/use-resource';
import { WorkPanel } from '@/features/work-panel';
import { CarDiagram, SEVERITY, findingMarks } from '@/features/car-diagram';
import { colors, space } from '@/lib/theme';
import { Body, Button, Card, Label, Loading, Notice, Pill, Screen } from '@/ui';

const approvalMethod = { in_person: 'лично', phone: 'по телефону', messenger: 'в мессенджере' } as const;

/** An order: the master's work panel while it is in work, then intake, estimate, handover and documents. */
export default function OrderScreen() {
  const { id, title, subtitle, bodyType } = useLocalSearchParams<{ id: string; title?: string; subtitle?: string; bodyType?: string }>();
  const { api } = useSession();
  const session = useSignedIn();
  const { width } = useWindowDimensions();
  const { data: order, error, reload, refresh, refreshing, replace } = useResource(useCallback((signal: AbortSignal) => api.getOrder(id, signal), [api, id]));
  // Back from intake (or another screen): show what changed.
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  const layout = order?.intake ? carLayout(order.intake.bodyType ?? bodyType) : null;
  const marks = findingMarks(order?.intake?.findings ?? []);

  if (!order && !error) return <Loading label="Загружаем заказ…"/>;
  if (!order) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;

  const estimate = order.estimateVersions.find((item) => item.id === (order.approval?.estimateVersionId ?? order.currentEstimateVersionId)) ?? null;
  const operations = order.work?.operations ?? [];
  const done = operations.filter((operation) => operation.status === 'DONE').length;
  const status = orderStatuses[order.status];
  // Intake can be done or corrected until an estimate is issued.
  const canIntake = session.capabilities.manageIntake && (order.status === 'INTAKE' || (order.status === 'ESTIMATE_DRAFT' && !order.estimateVersions.length));
  const openIntake = () => router.push({ pathname: '/orders/intake/[id]', params: { id: order.id, title: title ?? '', bodyType: bodyType ?? '' } });

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface}
      onRefresh={reload}/>}>
      <Stack.Screen options={{ title: title || 'Заказ' }}/>
      {subtitle ? <Body muted>{subtitle}</Body> : null}
      <View style={styles.row}><Pill label={status.label} tone={status.group === 'ready' ? 'ok' : status.group === 'closed' ? 'neutral' : 'accent'}/><Text style={styles.meta}>Открыт {shortDate(order.createdAt)}</Text></View>

      {(order.status === 'APPROVED' || order.status === 'IN_PROGRESS') && <WorkPanel order={order} onChanged={replace}/>}

      <Card>
        <Label>Приёмка</Label>
        {order.intake ? <>
          <Body>{order.intake.conditionSummary}</Body>
          {layout && order.intake.findings.length ? <View style={styles.diagram}><CarDiagram layout={layout} marks={marks} width={Math.min(width - 96, 220)}/></View> : null}
          {order.intake.findings.length ? order.intake.findings.map((finding, index) => {
            const number = findLayoutElement(order.intake?.bodyType, finding.zone)?.number;
            return (
              <View key={`${finding.zone}-${index}`} style={styles.finding}>
                <View style={[styles.badge, { backgroundColor: SEVERITY[finding.severity].badge }]}><Text style={styles.badgeText}>{number ?? '•'}</Text></View>
                <View style={{ flex: 1 }}><Text style={styles.findingTitle}>{finding.zone}</Text><Text style={styles.meta}>{SEVERITY[finding.severity].label} · {finding.note}</Text></View>
              </View>
            );
          }) : <Body muted>Повреждений не выявлено.</Body>}
          {order.photos.some((photo) => photo.phase === 'intake') ? <Body muted>Фото при приёмке: {order.photos.filter((photo) => photo.phase === 'intake').length}</Body> : null}
        </> : <Body muted>Приёмка ещё не проведена.</Body>}
        {canIntake && <Button title={order.intake ? 'Изменить приёмку' : 'Провести приёмку'} tone={order.intake ? 'secondary' : 'primary'} onPress={openIntake}/>}
      </Card>

      {estimate && <Card>
        <Label>Смета v{estimate.version}</Label>
        {estimate.lines.map((line) => <View key={line.id} style={styles.line}><Text style={styles.lineName}>{line.name}</Text><Text style={styles.lineAmount}>{money(line.amountMinor)}</Text></View>)}
        <View style={[styles.line, styles.totalRow]}><Text style={styles.lineName}>Итого</Text><Text style={styles.total}>{money(estimate.totalAmountMinor)}</Text></View>
        {order.approval ? <Body muted>{order.approval.decision === 'APPROVED' ? 'Согласовано' : 'Отклонено'} {approvalMethod[order.approval.method]} · {order.approval.responsible}</Body> : <Body muted>Ждёт решения клиента.</Body>}
      </Card>}

      {order.status !== 'APPROVED' && order.status !== 'IN_PROGRESS' && (order.assignment || order.work) && <Card>
        <Label>Работы</Label>
        {order.assignment ? <Body>Мастер: {order.assignment.masterName}</Body> : null}
        {order.work ? <>
          <Body muted>Выполнено {done} из {operations.length}{order.work.status === 'PAUSED' ? ` · пауза: ${order.work.pauseNote ?? ''}` : ''}</Body>
          {operations.map((operation) => <Text key={operation.id} style={[styles.operation, operation.status === 'DONE' && styles.operationDone]}>{operation.status === 'DONE' ? '✓ ' : '○ '}{operation.name}</Text>)}
        </> : null}
      </Card>}

      {order.handover && <Card><Label>Выдача</Label><Body>{order.handover.note}</Body><Body muted>{order.handover.responsible} · {shortDate(order.handover.handedOverAt)}</Body></Card>}

      {order.documents.length > 0 && <Card>
        <Label>Документы</Label>
        {order.documents.map((document) => <Body key={document.id}>{document.type === 'intake_act' ? 'Акт приёмки' : 'Акт выдачи'} {document.number}{document.signed ? ' · подписан' : ''}</Body>)}
      </Card>}

      {order.status !== 'CLOSED' && <Notice tone="info">Смета, согласование и выдача появятся в следующих версиях нативного приложения. Пока они в веб-версии.</Notice>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  diagram: { alignItems: 'center', paddingVertical: space.s },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  meta: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  finding: { flexDirection: 'row', gap: space.m, alignItems: 'flex-start', paddingVertical: 4 },
  badge: { minWidth: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  badgeText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  findingTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: space.m, paddingVertical: 4 },
  lineName: { color: colors.text, fontSize: 16, flex: 1 },
  lineAmount: { color: colors.text, fontSize: 16, fontVariant: ['tabular-nums'] },
  totalRow: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, marginTop: 4, paddingTop: space.s },
  total: { color: colors.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  operation: { color: colors.muted, fontSize: 16, paddingVertical: 2 },
  operationDone: { color: colors.text }
});
