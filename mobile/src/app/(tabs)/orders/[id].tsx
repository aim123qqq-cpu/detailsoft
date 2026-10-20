import { useCallback, useState } from 'react';
import { RefreshControl, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { carLayout, findLayoutElement } from '@df/shared/carLayouts';
import { money, orderStatuses, shortDate } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { useResource } from '@/lib/use-resource';
import { WorkPanel } from '@/features/work-panel';
import { CarDiagram, SEVERITY, findingMarks } from '@/features/car-diagram';
import { ApprovalPanel } from '@/features/approval-panel';
import { DOCUMENT_TITLES } from '@/features/document-paper';
import { orderShareText } from '@/lib/share-text';
import type { OrderDocumentType } from '@df/types';
import { colors, space } from '@/lib/theme';
import { Body, Button, Card, Label, Loading, Notice, Pill, Screen } from '@/ui';

const approvalMethod = { in_person: 'лично', phone: 'по телефону', messenger: 'в мессенджере' } as const;

/** An order: the master's work panel while it is in work, then intake, estimate, handover and documents. */
export default function OrderScreen() {
  const { id, title, subtitle, bodyType } = useLocalSearchParams<{ id: string; title?: string; subtitle?: string; bodyType?: string }>();
  const { api } = useSession();
  const session = useSignedIn();
  const { width } = useWindowDimensions();
  const [shareError, setShareError] = useState('');
  const { data: order, error, reload, refresh, refreshing, replace } = useResource(useCallback((signal: AbortSignal) => api.getOrder(id, signal), [api, id]));
  // Back from intake (or another screen): show what changed.
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));
  const layout = order?.intake ? carLayout(order.intake.bodyType ?? bodyType) : null;
  const marks = findingMarks(order?.intake?.findings ?? []);

  if (!order && !error) return <Loading label="Загружаем заказ…"/>;
  if (!order) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;

  const current = order.estimateVersions.find((item) => item.id === order.currentEstimateVersionId) ?? null;
  // The decision on the current version, if any (an earlier version may have been refused).
  const decision = order.approval && order.approval.estimateVersionId === current?.id ? order.approval : null;
  const estimate = order.status === 'APPROVED' || order.status === 'IN_PROGRESS' || order.status === 'READY' || order.status === 'CLOSED'
    ? order.estimateVersions.find((item) => item.id === order.approval?.estimateVersionId) ?? current : current;
  const caps = session.capabilities;
  const needsEstimate = order.status === 'ESTIMATE_DRAFT' && (!current || decision?.decision === 'REJECTED');
  const awaitsDecision = order.status === 'ESTIMATE_DRAFT' && current && !decision;
  const params = { id: order.id, title: title ?? '' };
  const openDocument = (type: OrderDocumentType, documentId?: string) => router.push({ pathname: '/orders/document/[id]', params: { id: order.id, type, ...(documentId ? { documentId } : {}), signer: subtitle?.split(' · ').at(-1) ?? '' } });
  const share = async () => {
    setShareError('');
    try { await Share.share({ message: orderShareText(order, session.tenant.name, subtitle?.split(' · ')[0] ?? '', title ?? '') }); }
    catch (failure) { setShareError((failure as Error).message); }
  };
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
        {order.approval && order.approval.estimateVersionId === estimate.id
          ? <Body muted>{order.approval.decision === 'APPROVED' ? 'Согласовано' : 'Клиент отказался'} {approvalMethod[order.approval.method]} · {order.approval.responsible}</Body>
          : <Body muted>Ждёт решения клиента.</Body>}
      </Card>}

      {needsEstimate && caps.manageIntake ? <Button title={current ? 'Новая версия сметы' : 'Составить смету'} onPress={() => router.push({ pathname: '/orders/estimate/[id]', params })}/> : null}
      {needsEstimate && !caps.manageIntake ? <Body muted>Смету составляет администратор или приёмщик.</Body> : null}
      {awaitsDecision && current && caps.approveEstimates ? <ApprovalPanel order={order} estimate={current} onChanged={replace}/> : null}
      {order.status === 'READY' && caps.closeOrders ? <Button title="Выдать автомобиль" onPress={() => router.push({ pathname: '/orders/handover/[id]', params })}/> : null}

      {order.status !== 'APPROVED' && order.status !== 'IN_PROGRESS' && (order.assignment || order.work) && <Card>
        <Label>Работы</Label>
        {order.assignment ? <Body>Мастер: {order.assignment.masterName}</Body> : null}
        {order.work ? <>
          <Body muted>Выполнено {done} из {operations.length}{order.work.status === 'PAUSED' ? ` · пауза: ${order.work.pauseNote ?? ''}` : ''}</Body>
          {operations.map((operation) => <Text key={operation.id} style={[styles.operation, operation.status === 'DONE' && styles.operationDone]}>{operation.status === 'DONE' ? '✓ ' : '○ '}{operation.name}</Text>)}
        </> : null}
      </Card>}

      {order.handover && <Card><Label>Выдача</Label><Body>{order.handover.note}</Body><Body muted>{order.handover.responsible} · {shortDate(order.handover.handedOverAt)}</Body></Card>}

      {(['intake_act', 'handover_act'] as const).filter((type) => type === 'intake_act' ? Boolean(order.intake) && (caps.manageIntake || caps.closeOrders) : order.status === 'CLOSED' && caps.closeOrders).map((type) => {
        const latest = order.documents.find((document) => document.type === type && document.current) ?? null;
        const canIssue = type === 'intake_act' ? caps.manageIntake : caps.closeOrders;
        return (
          <Card key={type}>
            <Label>{DOCUMENT_TITLES[type]}</Label>
            <Body muted>{latest ? `№ ${latest.number} · ${latest.signed ? `подписан: ${latest.signerName}` : 'без подписи'}${latest.outdated ? ' · устарел после повторного осмотра' : ''}` : 'Ещё не оформлен. Подпись клиента необязательна.'}</Body>
            {latest ? <Button title="Открыть" tone="secondary" onPress={() => openDocument(type, latest.id)}/> : null}
            {canIssue ? <Button title={latest ? 'Оформить заново' : 'Оформить и подписать'} tone={latest ? 'quiet' : 'primary'} onPress={() => openDocument(type)}/> : null}
          </Card>
        );
      })}

      {order.status === 'CLOSED' && estimate ? <>
        <Button title="Поделиться заказ-нарядом" tone="secondary" onPress={() => void share()}/>
        {shareError ? <Notice>{shareError}</Notice> : null}
      </> : null}
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
