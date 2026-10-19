/**
 * Content of the intake and handover acts, shared by the server (issuing) and the app (preview and
 * signing offline): the act a client signs on the phone is built by the same code the server uses.
 */

export type DocumentType = 'intake_act' | 'handover_act';

export type DocumentParties = {
  centerName: string;
  customer: { name: string; phoneDisplay: string };
  vehicle: { make: string; model: string; generation: string | null | undefined; plate: string; color: string };
};

type Photo = { phase: string };
type Line = { name: string; amountMinor: number };
/** The parts of an order (server getOrder / app WorkOrder) the acts are built from. */
export type DocumentOrder = {
  id: string;
  createdAt: string;
  status: string;
  currentEstimateVersionId: string | null;
  photos: Photo[];
  intake: null | {
    conditionSummary: string;
    completedAt: string;
    findings: Array<{ zone: string; severity: string; note: string }>;
    recommendations: Array<{ title: string; reason: string; priority: string }>;
  };
  estimateVersions: Array<{ id: string; version: number; totalAmountMinor: number; lines: Line[] }>;
  approval: null | { estimateVersionId: string; decision: string; method: string; responsible: string; decidedAt: string };
  work: null | { operations: Array<{ name: string; amountMinor: number; status: string }> };
  handover: null | { responsible: string; note: string; handedOverAt: string };
};

export function buildDocumentContent(order: DocumentOrder, parties: DocumentParties, type: DocumentType) {
  const base = {
    center: { name: parties.centerName },
    order: { id: order.id, number: order.id.replace(/^order_/, '').slice(0, 8), createdAt: order.createdAt },
    customer: { name: parties.customer.name, phoneDisplay: parties.customer.phoneDisplay },
    vehicle: { make: parties.vehicle.make, model: parties.vehicle.model, generation: parties.vehicle.generation ?? null, plate: parties.vehicle.plate, color: parties.vehicle.color }
  };
  const photoCount = (phase: string) => order.photos.filter((photo) => photo.phase === phase).length;
  if (type === 'intake_act') {
    if (!order.intake) return { kind: 'conflict' as const, code: 'document_not_available', message: 'Сначала сохраните приёмку автомобиля' };
    return { kind: 'built' as const, content: {
      title: 'Акт приёмки автомобиля',
      ...base,
      intake: {
        conditionSummary: order.intake.conditionSummary,
        completedAt: order.intake.completedAt,
        findings: order.intake.findings.map(({ zone, severity, note }) => ({ zone, severity, note })),
        recommendations: order.intake.recommendations.map(({ title, reason, priority }) => ({ title, reason, priority })),
        photoCount: photoCount('intake')
      },
      statement: 'Автомобиль передан в центр для выполнения работ в состоянии, описанном в этом акте. Перечисленные повреждения и замечания зафиксированы до начала работ.'
    } };
  }
  if (order.status !== 'CLOSED') return { kind: 'conflict' as const, code: 'document_not_available', message: 'Акт выдачи формируется после закрытия заказа' };
  const approval = order.approval?.decision === 'APPROVED' ? order.approval : null;
  const estimate = order.estimateVersions.find((item) => item.id === (approval?.estimateVersionId ?? order.currentEstimateVersionId)) ?? null;
  const works = order.work?.operations.length
    ? order.work.operations.map((operation) => ({ name: operation.name, amountMinor: operation.amountMinor, status: operation.status }))
    : (estimate?.lines ?? []).map((line) => ({ name: line.name, amountMinor: line.amountMinor, status: 'DONE' }));
  return { kind: 'built' as const, content: {
    title: 'Акт выдачи автомобиля (заказ-наряд)',
    ...base,
    estimate: estimate ? {
      version: estimate.version,
      totalAmountMinor: estimate.totalAmountMinor,
      approvedAt: approval?.decidedAt ?? null,
      approvalMethod: approval?.method ?? null,
      approvedBy: approval?.responsible ?? null
    } : null,
    works,
    // Historical orders closed before handovers were recorded have no handover row.
    handover: order.handover
      ? { responsible: order.handover.responsible, note: order.handover.note, handedOverAt: order.handover.handedOverAt }
      : null,
    photos: { intake: photoCount('intake'), result: photoCount('result') },
    statement: 'Работы выполнены по согласованной смете. Клиент осмотрел автомобиль и принял его. Сумма указана по согласованной смете и не подтверждает расчёты.'
  } };
}

/** The same signature check as the server: a PNG data URL up to 200 KB and a signer name. */
export function validSignature(signerName: string, signatureDataUrl: string) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(signatureDataUrl);
  if (!match || signerName.trim().length < 2 || signerName.trim().length > 120) return false;
  const bytes = Math.floor(match[1].length * 3 / 4) - (match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0);
  return bytes >= 8 && bytes <= 200 * 1024 && match[1].startsWith('iVBORw0KGgo');
}
