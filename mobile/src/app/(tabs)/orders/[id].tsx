import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Share, StyleSheet, View, useWindowDimensions } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';
import { carLayout, findLayoutElement } from '@df/shared/carLayouts';
import type { OrderDocumentType } from '@df/types';
import { ApprovalPanel } from '@/features/approval-panel';
import { CarDiagram, SEVERITY, findingMarks, severityColor } from '@/features/car-diagram';
import { DOCUMENT_TITLES } from '@/features/document-paper';
import { DotGround } from '@/features/inspection';
import { WorkPanel } from '@/features/work-panel';
import { money, orderStatuses, shortDate } from '@/lib/format';
import { useSession, useSignedIn } from '@/lib/session';
import { orderShareText } from '@/lib/share-text';
import { floatShadow, makeStyles, radius, space, useTheme } from '@/lib/theme';
import { useResource } from '@/lib/use-resource';
import { Body, Button, Heading, Loading, Notice, Screen } from '@/ui';
import { RoundButton } from '@/ui/brand';
import { Icon } from '@/ui/icons';
import { Text } from '@/ui/text';

const approvalMethod = { in_person: 'лично', phone: 'по телефону', messenger: 'в мессенджере' } as const;
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
/** The five stages of an order, for the ring beside the total. */
const STAGE: Record<string, number> = { INTAKE: 1, ESTIMATE_DRAFT: 2, APPROVED: 3, IN_PROGRESS: 3, QC: 3, READY: 4, CLOSED: 5 };
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '·';

/** An order: the intake drawing on top, then a white sheet with the money, the customer and what to do now. */
export default function OrderScreen() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { id, title, subtitle, bodyType } = useLocalSearchParams<{ id: string; title?: string; subtitle?: string; bodyType?: string }>();
  const { api } = useSession();
  const session = useSignedIn();
  const { width } = useWindowDimensions();
  const [shareError, setShareError] = useState('');
  const { data: order, error, reload, refresh, refreshing, replace } = useResource(useCallback((signal: AbortSignal) => api.getOrder(id, signal), [api, id]));
  // Back from intake (or another screen): show what changed.
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  if (!order && !error) return <Loading label="Загружаем заказ…"/>;
  if (!order) return <Screen><Notice>{error}</Notice><Button title="Повторить" tone="secondary" onPress={reload}/></Screen>;

  const layout = carLayout(order.intake?.bodyType ?? bodyType);
  const findings = order.intake?.findings ?? [];
  const marks = findingMarks(findings);
  const [vehicleText, customerName] = [subtitle?.split(' · ')[0] ?? '', subtitle?.split(' · ').at(-1) ?? ''];
  const current = order.estimateVersions.find((item) => item.id === order.currentEstimateVersionId) ?? null;
  // The decision on the current version, if any (an earlier version may have been refused).
  const decision = order.approval && order.approval.estimateVersionId === current?.id ? order.approval : null;
  const estimate = order.status === 'APPROVED' || order.status === 'IN_PROGRESS' || order.status === 'READY' || order.status === 'CLOSED'
    ? order.estimateVersions.find((item) => item.id === order.approval?.estimateVersionId) ?? current : current;
  const caps = session.capabilities;
  const needsEstimate = order.status === 'ESTIMATE_DRAFT' && (!current || decision?.decision === 'REJECTED');
  const awaitsDecision = order.status === 'ESTIMATE_DRAFT' && current && !decision;
  const params = { id: order.id, title: title ?? '', subtitle: subtitle ?? '' };
  const openDocument = (type: OrderDocumentType, documentId?: string) => router.push({ pathname: '/orders/document/[id]', params: { id: order.id, type, ...(documentId ? { documentId } : {}), signer: customerName } });
  const share = async () => {
    setShareError('');
    try { await Share.share({ message: orderShareText(order, session.tenant.name, vehicleText, title ?? '') }); }
    catch (failure) { setShareError((failure as Error).message); }
  };
  const operations = order.work?.operations ?? [];
  const done = operations.filter((operation) => operation.status === 'DONE').length;
  const status = orderStatuses[order.status];
  // Intake can be done or corrected until an estimate is issued.
  const canIntake = caps.manageIntake && (order.status === 'INTAKE' || (order.status === 'ESTIMATE_DRAFT' && !order.estimateVersions.length));
  const openIntake = () => router.push({ pathname: '/orders/intake/[id]', params: { id: order.id, title: title ?? '', bodyType: bodyType ?? '' } });
  const stage = STAGE[order.status] ?? 1;
  const headline = awaitsDecision ? `Смета v${current!.version} · ждёт решения клиента`
    : estimate && decision?.decision === 'REJECTED' ? `Смета v${estimate.version} · клиент отказался`
    : estimate ? `Смета v${estimate.version} · ${status.label.toLowerCase()}` : order.status === 'ESTIMATE_DRAFT' ? 'Смета ещё не составлена' : status.label;
  const counts = SEVERITIES.map((severity) => ({ severity, count: findings.filter((finding) => finding.severity === severity).length })).filter((item) => item.count);
  const intakePhotos = order.photos.filter((photo) => photo.phase === 'intake').length;

  return (
    <View style={styles.root}>
      <ScrollView refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.ink} colors={[colors.accent]} progressBackgroundColor={colors.surface} onRefresh={reload}/>}
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}>
        <View style={[styles.scene, { paddingTop: insets.top + space.l }]} accessibilityLabel="Схема приёмки">
          <DotGround/>
          <View style={styles.head}>
            <RoundButton icon="back" label="Назад" onPress={() => router.back()}/>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <Text style={styles.headTitle} numberOfLines={1}>{vehicleText || title || 'Заказ'}</Text>
              <Text style={styles.headNote} numberOfLines={1}>{[title, `открыт ${shortDate(order.createdAt)}`].filter(Boolean).join(' · ')}</Text>
            </View>
            {order.status === 'CLOSED' && estimate ? <RoundButton icon="arrowUpRight" label="Поделиться заказ-нарядом" onPress={() => void share()}/> : <View style={{ width: 44 }}/>}
          </View>
          <View style={styles.drawing}>
            {order.intake ? <CarDiagram layout={layout} marks={marks} width={Math.min(width * 0.42, 170)}/>
              : <Text style={styles.headNote}>Приёмка ещё не проведена</Text>}
          </View>
          {counts.length ? <View style={styles.legend}>
            {counts.map(({ severity, count }) => (
              <View key={severity} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: severityColor(colors, severity) }]}/>
                <Text style={styles.legendText}>{SEVERITY[severity].label.toLowerCase()} · {count}</Text>
              </View>
            ))}
          </View> : null}
        </View>

        <View style={styles.sheet}>
          <View style={styles.handle}/>
          <View style={styles.moneyRow}>
            <View style={{ flex: 1 }}>
              {order.status === 'CLOSED' ? <View style={styles.closedChip}><Text style={styles.closedText}>Закрыт</Text></View> : <Text style={styles.meta}>{headline}</Text>}
              <Text style={styles.total} numberOfLines={1} adjustsFontSizeToFit>{estimate ? money(estimate.totalAmountMinor) : '—'}</Text>
            </View>
            <StageRing stage={stage}/>
          </View>
          {order.status === 'CLOSED' && order.handover ? <Text style={styles.meta}>открыт {shortDate(order.createdAt)} · закрыт {shortDate(order.handover.handedOverAt)}</Text> : null}

          {customerName ? <View style={styles.person}>
            <View style={styles.avatar}><Text style={styles.avatarText}>{initials(customerName)}</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.personName} numberOfLines={1}>{customerName}</Text>
              <Text style={styles.meta}>Владелец{order.assignment ? ` · мастер ${order.assignment.masterName}` : ''}</Text>
            </View>
            {caps.manageCustomers ? <Pressable accessibilityRole="button" accessibilityLabel="Карточка клиента" onPress={() => router.push({ pathname: '/customer/[id]', params: { id: order.customerId } })} style={styles.round}>
              <Icon name="person" size={18}/>
            </Pressable> : null}
          </View> : null}

          {(order.status === 'APPROVED' || order.status === 'IN_PROGRESS') && <WorkPanel order={order} onChanged={replace}/>}

          {estimate ? <View style={styles.lines}>
            {estimate.lines.map((line, index) => (
              <View key={line.id} style={[styles.line, index > 0 && styles.lineBorder]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.lineName}>{line.name}</Text>
                  <Text style={styles.meta}>{line.sourceType === 'recommendation' ? 'рекомендация по осмотру' : line.sourceType === 'custom' ? 'своя работа' : 'из записи'}</Text>
                </View>
                <Text style={styles.lineAmount}>{money(line.amountMinor)}</Text>
              </View>
            ))}
          </View> : null}
          {estimate && decision && order.status !== 'CLOSED' ? <Text style={styles.meta}>{decision.decision === 'APPROVED' ? 'Согласовано' : 'Клиент отказался'} {approvalMethod[decision.method]} · {decision.responsible}</Text> : null}

          {awaitsDecision && current && caps.approveEstimates ? <ApprovalPanel order={order} estimate={current} onChanged={replace}/> : null}
          {needsEstimate && caps.manageIntake ? <Button title={current ? 'Новая версия сметы' : 'Составить смету'} onPress={() => router.push({ pathname: '/orders/estimate/[id]', params })}/> : null}
          {needsEstimate && !caps.manageIntake ? <Body muted>Смету составляет администратор или приёмщик.</Body> : null}
          {order.status === 'READY' && caps.closeOrders ? <Button title="Выдать автомобиль" onPress={() => router.push({ pathname: '/orders/handover/[id]', params })}/> : null}

          {order.status === 'CLOSED' ? <Story order={order} total={estimate?.totalAmountMinor ?? null}/> : <>
          <Row title="Приёмка" note={order.intake ? `${findings.length ? `${findings.length} замеч.` : 'без замечаний'} · фото ${intakePhotos}` : 'Ещё не проведена'}
            action={canIntake ? (order.intake ? 'Изменить' : 'Провести') : undefined} onPress={canIntake ? openIntake : undefined}/>
          {findings.length ? <View style={styles.findings}>
            {findings.map((finding, index) => {
              const number = findLayoutElement(order.intake?.bodyType, finding.zone)?.number;
              return (
                <View key={`${finding.zone}-${index}`} style={styles.finding}>
                  <View style={[styles.pin, { backgroundColor: severityColor(colors, finding.severity) }]}><Text style={styles.pinText}>{number ?? '•'}</Text></View>
                  <Text style={styles.findingText} numberOfLines={1}><Text style={styles.findingZone}>{finding.zone}</Text> · {finding.note}</Text>
                </View>
              );
            })}
          </View> : null}

          {order.status !== 'APPROVED' && order.status !== 'IN_PROGRESS' && order.work ? (
            <Row title="Работы" note={`${order.assignment ? `${order.assignment.masterName} · ` : ''}выполнено ${done} из ${operations.length}${order.work.status === 'PAUSED' ? ` · пауза: ${order.work.pauseNote ?? ''}` : ''}`}/>
          ) : null}
          {order.handover ? <Row title="Выдача" note={`${order.handover.responsible} · ${shortDate(order.handover.handedOverAt)}${order.handover.note ? ` · ${order.handover.note}` : ''}`}/> : null}
          </>}
          {order.status === 'CLOSED' ? <Heading style={{ marginTop: 4 }}>Документы</Heading> : null}

          {(['intake_act', 'handover_act'] as const).filter((type) => type === 'intake_act' ? Boolean(order.intake) && (caps.manageIntake || caps.closeOrders) : order.status === 'CLOSED' && caps.closeOrders).map((type) => {
            const latest = order.documents.find((document) => document.type === type && document.current) ?? null;
            const canIssue = type === 'intake_act' ? caps.manageIntake : caps.closeOrders;
            return (
              <Row key={type} title={DOCUMENT_TITLES[type]}
                note={latest ? `№ ${latest.number} · ${latest.signed ? `подписан: ${latest.signerName}` : 'без подписи'}${latest.outdated ? ' · устарел после повторного осмотра' : ''}` : 'Не оформлен · подпись по желанию'}
                action={latest ? 'Открыть' : canIssue ? 'Оформить' : undefined}
                onPress={latest ? () => openDocument(type, latest.id) : canIssue ? () => openDocument(type) : undefined}
                extra={latest && canIssue ? { title: 'Оформить заново', onPress: () => openDocument(type) } : undefined}/>
            );
          })}

          {shareError ? <Notice>{shareError}</Notice> : null}
        </View>
      </ScrollView>
    </View>
  );
}

/** How a closed order went: intake, the agreed estimate, the work, the handover, each with who and when. */
function Story({ order, total }: { order: import('@df/types').WorkOrder; total: number | null }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const findings = order.intake?.findings.length ?? 0;
  const photos = order.photos.filter((photo) => photo.phase === 'intake').length;
  const operations = order.work?.operations ?? [];
  const steps = [
    order.intake ? { title: 'Приёмка', note: `${shortDate(order.intake.completedAt)} · ${findings ? `замечаний: ${findings}` : 'без замечаний'}, фото: ${photos}` } : null,
    order.approval ? { title: order.approval.decision === 'APPROVED' ? 'Смета согласована' : 'Смета отклонена', note: [approvalMethod[order.approval.method].replace(/^./, (letter) => letter.toUpperCase()), order.approval.responsible, total !== null ? money(total) : null].filter(Boolean).join(' · ') } : null,
    order.work ? { title: 'Работы', note: `${order.assignment?.masterName ?? 'мастер'} · выполнено ${operations.filter((operation) => operation.status === 'DONE').length} из ${operations.length}` } : null,
    order.handover ? { title: 'Выдача', note: [order.handover.note, order.handover.responsible, shortDate(order.handover.handedOverAt)].filter(Boolean).join(' · ') } : null
  ].filter((step) => step !== null);
  return (
    <View style={{ gap: space.m }}>
      <Heading style={{ marginTop: 4 }}>Как прошёл заказ</Heading>
      {steps.map((step, index) => (
        <View key={step.title} style={styles.step}>
          <View style={styles.stepRail}>
            <View style={[styles.stepDot, { backgroundColor: colors.ok }]}><Icon name="check" size={12} color="#FFFFFF" strokeWidth={2.4}/></View>
            {index < steps.length - 1 ? <View style={styles.stepLine}/> : null}
          </View>
          <View style={{ flex: 1, paddingBottom: space.m }}>
            <Text style={styles.rowTitle}>{step.title}</Text>
            <Text style={styles.meta}>{step.note}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

/** How far the order has gone: five stages as a ring. */
function StageRing({ stage }: { stage: number }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const size = 54; const stroke = 5; const r = (size - stroke) / 2; const length = 2 * Math.PI * r;
  return (
    <View style={{ width: size, height: size }} accessibilityRole="image" accessibilityLabel={`Этап ${stage} из 5`}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.line} strokeWidth={stroke} fill="none"/>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.accent} strokeWidth={stroke} fill="none" strokeLinecap="round"
          strokeDasharray={`${(length * stage) / 5} ${length}`} transform={`rotate(-90 ${size / 2} ${size / 2})`}/>
      </Svg>
      <View style={styles.ringLabel}><Text style={styles.ringText}>{stage}/5</Text></View>
    </View>
  );
}

/** A line of the sheet: a document, the intake, the work; an orange action on the right. */
function Row({ title, note, action, onPress, extra }: { title: string; note: string; action?: string; onPress?: () => void; extra?: { title: string; onPress: () => void } }) {
  const styles = useStyles();
  return (
    <View style={{ gap: 4 }}>
      <Pressable accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={onPress} style={styles.row}>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowTitle}>{title}</Text>
          <Text style={styles.meta} numberOfLines={2}>{note}</Text>
        </View>
        {action ? <Text style={styles.rowAction}>{action}</Text> : null}
      </Pressable>
      {extra ? <Pressable accessibilityRole="button" onPress={extra.onPress} hitSlop={6} style={{ alignSelf: 'flex-end', paddingHorizontal: 14 }}><Text style={styles.extra}>{extra.title}</Text></Pressable> : null}
    </View>
  );
}

const useStyles = makeStyles((colors, scheme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ground },
  scene: { minHeight: 420, paddingBottom: 48 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: space.l },
  headTitle: { fontSize: 15, fontWeight: '600' },
  headNote: { fontSize: 12, color: colors.muted },
  drawing: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: space.l },
  legend: { position: 'absolute', left: space.m, top: 140, gap: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 12, color: colors.muted },
  sheet: { marginTop: -30, borderTopLeftRadius: 32, borderTopRightRadius: 32, backgroundColor: colors.surface, paddingHorizontal: space.l, paddingTop: 10, paddingBottom: 20, gap: 14, ...floatShadow(scheme) },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line },
  moneyRow: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  meta: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  total: { fontSize: 38, lineHeight: 44, fontWeight: '500', letterSpacing: -1.1, fontVariant: ['tabular-nums'] },
  ringLabel: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  ringText: { fontSize: 12, fontWeight: '700' },
  person: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: space.m, borderTopWidth: 1, borderStyle: 'dashed', borderTopColor: colors.line },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.tileSky, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.tileInk, fontSize: 13, fontWeight: '700' },
  personName: { fontSize: 15, fontWeight: '600' },
  round: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  lines: { borderRadius: radius.m, backgroundColor: colors.soft, paddingHorizontal: 14, paddingVertical: 4 },
  line: { flexDirection: 'row', alignItems: 'baseline', gap: space.m, paddingVertical: 10 },
  lineBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  lineName: { fontSize: 15, fontWeight: '600' },
  lineAmount: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.m, paddingHorizontal: 14, borderRadius: radius.m, borderWidth: 1, borderColor: colors.line },
  rowTitle: { fontSize: 15, fontWeight: '600' },
  rowAction: { fontSize: 13, fontWeight: '700', color: colors.accent },
  extra: { fontSize: 13, fontWeight: '600', color: colors.muted },
  closedChip: { alignSelf: 'flex-start', height: 26, paddingHorizontal: 10, borderRadius: 13, backgroundColor: colors.soft, justifyContent: 'center', marginBottom: 2 },
  closedText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  step: { flexDirection: 'row', gap: space.m },
  stepRail: { alignItems: 'center', width: 22 },
  stepDot: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  stepLine: { flex: 1, width: 2, backgroundColor: colors.line, marginTop: 2 },
  findings: { gap: 6, paddingHorizontal: 4 },
  finding: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pin: { minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center' },
  pinText: { color: '#FFFFFF', fontSize: 10, fontWeight: '700' },
  findingText: { flex: 1, fontSize: 13, color: colors.muted },
  findingZone: { color: colors.ink, fontWeight: '600' }
}));
