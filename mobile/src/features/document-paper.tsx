import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { BODY_TYPES, carLayout, normalizeBodyType } from '@df/shared/carLayouts';
import type { OrderDocumentContent, OrderDocumentType } from '@df/types';
import { money } from '@/lib/format';
import { radius, space } from '@/lib/theme';
import { CarDiagram, findingMarks } from './car-diagram';

export const DOCUMENT_TITLES: Record<OrderDocumentType, string> = { intake_act: 'Акт приёмки', handover_act: 'Акт выдачи (заказ-наряд)' };
export const SEVERITY_WORDS = { LOW: 'лёгкое', MEDIUM: 'среднее', HIGH: 'серьёзное' } as const;
export const PRIORITY_WORDS = { OPTIONAL: 'по желанию', RECOMMENDED: 'рекомендуется', URGENT: 'срочно' } as const;
export const METHOD_WORDS: Record<string, string> = { in_person: 'лично', phone: 'по телефону', messenger: 'в мессенджере' };
const dateTime = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const documentDate = (value: string | null | undefined) => value ? dateTime.format(new Date(value)) : '—';

/** An act as the customer sees it: the same parts as the web act and the printed PDF. */
export function DocumentPaper({ content, number, signerName, signatureDataUrl, signedAt, actorName }: {
  content: OrderDocumentContent;
  number?: string;
  signerName?: string | null;
  signatureDataUrl?: string | null;
  signedAt?: string | null;
  actorName?: string | null;
}) {
  const { width } = useWindowDimensions();
  const vehicle = [content.vehicle.make, content.vehicle.model, content.vehicle.generation].filter(Boolean).join(' ');
  const intake = content.intake;
  return (
    <View style={styles.paper}>
      <Text style={styles.center}>{content.center.name}</Text>
      <Text style={styles.title}>{content.title}</Text>
      <Text style={styles.meta}>{number ? `№ ${number}` : 'Предпросмотр · номер присвоится при сохранении'} · заказ #{content.order.number}</Text>

      <View style={styles.parties}>
        <Party label="Клиент" value={content.customer.name}/>
        <Party label="Телефон" value={content.customer.phoneDisplay}/>
        <Party label="Автомобиль" value={vehicle}/>
        <Party label="Госномер" value={content.vehicle.plate}/>
        <Party label="Цвет" value={content.vehicle.color}/>
        <Party label="Заказ открыт" value={documentDate(content.order.createdAt)}/>
      </View>

      {intake ? <>
        <Text style={styles.h}>Состояние при приёмке</Text>
        <Text style={styles.text}>{intake.conditionSummary}</Text>
        <Text style={styles.h}>Зафиксированные повреждения</Text>
        {intake.bodyType ? <View style={styles.diagram}>
          <CarDiagram layout={carLayout(normalizeBodyType(intake.bodyType))} marks={findingMarks(intake.findings)} width={Math.min(width - 120, 220)} palette="paper"/>
          <Text style={styles.caption}>Схема осмотра · {BODY_TYPES.find((item) => item.code === intake.bodyType)?.label ?? 'кузов'}. Номера в списке соответствуют элементам на схеме.</Text>
        </View> : null}
        {intake.findings.length ? intake.findings.map((finding, index) => (
          <Text key={index} style={styles.text}>{finding.element ? `${finding.element}. ` : '• '}<Text style={styles.bold}>{finding.zone}</Text> · {SEVERITY_WORDS[finding.severity]} — {finding.note}</Text>
        )) : <Text style={styles.text}>Повреждений не выявлено.</Text>}
        {intake.recommendations.length ? <>
          <Text style={styles.h}>Рекомендации</Text>
          {intake.recommendations.map((item, index) => <Text key={index} style={styles.text}>{index + 1}. <Text style={styles.bold}>{item.title}</Text> ({PRIORITY_WORDS[item.priority]}) — {item.reason}</Text>)}
        </> : null}
        <Text style={styles.small}>Осмотр: {documentDate(intake.completedAt)} · фото при приёмке: {intake.photoCount}</Text>
      </> : null}

      {content.works ? <>
        <Text style={styles.h}>Выполненные работы</Text>
        {content.works.map((work, index) => (
          <View key={index} style={styles.row}><Text style={[styles.text, { flex: 1 }]}>{work.name}{work.status !== 'DONE' ? ' (не выполнено)' : ''}</Text><Text style={styles.text}>{money(work.amountMinor)}</Text></View>
        ))}
        {content.estimate ? <View style={[styles.row, styles.total]}><Text style={[styles.bold, { flex: 1 }]}>Итого по согласованной смете v{content.estimate.version}</Text><Text style={styles.bold}>{money(content.estimate.totalAmountMinor)}</Text></View> : null}
        {content.estimate?.approvedAt ? <Text style={styles.small}>Смета согласована {documentDate(content.estimate.approvedAt)}{content.estimate.approvalMethod ? ` ${METHOD_WORDS[content.estimate.approvalMethod] ?? ''}` : ''}{content.estimate.approvedBy ? ` · ответственный: ${content.estimate.approvedBy}` : ''}</Text> : null}
        {content.handover ? <Text style={styles.small}>Выдача: {documentDate(content.handover.handedOverAt)} · выдал: {content.handover.responsible} · {content.handover.note}</Text> : null}
        {content.photos ? <Text style={styles.small}>Фото до работ: {content.photos.intake} · после работ: {content.photos.result}</Text> : null}
      </> : null}

      <Text style={styles.statement}>{content.statement}</Text>

      <View style={styles.signatures}>
        <View style={styles.signature}>
          <Text style={styles.small}>Клиент</Text>
          {signatureDataUrl ? <Image source={{ uri: signatureDataUrl }} style={styles.signatureImage} contentFit="contain" accessibilityLabel={`Подпись: ${signerName}`}/> : <View style={styles.line}/>}
          <Text style={styles.small}>{signerName ? `${signerName}${signedAt ? ` · ${documentDate(signedAt)}` : ''}` : 'подпись / ФИО'}</Text>
        </View>
        <View style={styles.signature}>
          <Text style={styles.small}>Сотрудник центра</Text>
          <View style={styles.line}/>
          <Text style={styles.small}>{actorName ?? 'подпись / ФИО'}</Text>
        </View>
      </View>
    </View>
  );
}

function Party({ label, value }: { label: string; value: string }) {
  return <View style={styles.party}><Text style={styles.small}>{label}</Text><Text style={styles.bold}>{value}</Text></View>;
}

const ink = '#16191c';
const styles = StyleSheet.create({
  paper: { backgroundColor: '#fbfaf7', borderRadius: radius.m, padding: space.l, gap: 6 },
  center: { color: '#5c6368', fontSize: 13, fontWeight: '700' },
  title: { color: ink, fontSize: 20, fontWeight: '800' },
  meta: { color: '#5c6368', fontSize: 13 },
  parties: { flexDirection: 'row', flexWrap: 'wrap', marginVertical: space.s, borderTopWidth: 1, borderBottomWidth: 1, borderColor: '#d9d6cf', paddingVertical: space.s },
  party: { width: '50%', paddingVertical: 4, paddingRight: space.s },
  h: { color: ink, fontSize: 15, fontWeight: '800', marginTop: space.s },
  text: { color: ink, fontSize: 14, lineHeight: 20 },
  bold: { color: ink, fontSize: 14, fontWeight: '700' },
  small: { color: '#5c6368', fontSize: 12, lineHeight: 17 },
  diagram: { alignItems: 'center', gap: 6, paddingVertical: space.s },
  caption: { color: '#5c6368', fontSize: 12, textAlign: 'center' },
  row: { flexDirection: 'row', gap: space.m, paddingVertical: 2 },
  total: { borderTopWidth: 1, borderColor: '#d9d6cf', paddingTop: 6, marginTop: 4 },
  statement: { color: ink, fontSize: 13, lineHeight: 19, marginTop: space.m, fontStyle: 'italic' },
  signatures: { flexDirection: 'row', gap: space.l, marginTop: space.l },
  signature: { flex: 1, gap: 4 },
  signatureImage: { height: 60, width: '100%' },
  line: { height: 60, borderBottomWidth: 1, borderColor: ink }
});
