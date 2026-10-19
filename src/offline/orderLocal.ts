import { ApiRequestError } from '../apiError.ts';
import type { IntakeFinding, OrderRecommendation, PhotoAsset, WorkOrder } from '../types';

/**
 * Order changes applied on the phone while the server is out of reach. Each mirrors the server rule
 * (server/repository.mjs) so the employee sees the same refusals offline; the server re-checks
 * everything when the queue is sent and its answer replaces this local copy.
 */
const conflict = (code: string, message: string) => new ApiRequestError(message, 409, code);
const invalid = (message: string) => new ApiRequestError(message, 422, 'validation_error');

export function localSaveIntake(order: WorkOrder, input: { conditionSummary: string; findings: IntakeFinding[]; recommendations: OrderRecommendation[]; bodyType?: string }, now: string, newId: () => string): WorkOrder {
  if (order.status === 'APPROVED') throw conflict('invalid_order_state', 'Согласованный заказ нельзя вернуть к приёмке');
  if (input.conditionSummary.trim().length < 3) throw invalid('Опишите состояние автомобиля');
  return {
    ...order,
    status: 'ESTIMATE_DRAFT',
    intake: {
      bodyType: input.bodyType ?? null,
      conditionSummary: input.conditionSummary.trim(),
      completedAt: now,
      findings: input.findings.map((finding) => ({ ...finding, id: finding.id ?? `local_finding_${newId()}` })),
      recommendations: input.recommendations.map((recommendation) => ({ ...recommendation, id: recommendation.id ?? `local_recommendation_${newId()}` }))
    }
  };
}

export function localAddPhoto(order: WorkOrder, input: { phase?: 'intake' | 'result'; kind: 'intake' | 'defect'; zone: string; dataUrl: string }, now: string, newId: () => string): { order: WorkOrder; photo: PhotoAsset } {
  const phase = input.phase === 'result' ? 'result' : 'intake';
  const allowed = phase === 'result' ? order.status === 'READY' : ['INTAKE', 'ESTIMATE_DRAFT'].includes(order.status);
  if (!allowed) throw conflict('invalid_order_state', phase === 'result' ? 'Фото результата можно добавить только перед выдачей' : 'В закрытую приёмку нельзя добавлять фото');
  const mime = /^data:(image\/(?:jpeg|png|webp));base64,/.exec(input.dataUrl)?.[1] as PhotoAsset['mimeType'] | undefined;
  if (!mime || !input.zone.trim()) throw invalid('Фото не распознано');
  if (order.photos.length >= (phase === 'intake' ? 19 : 20)) throw invalid('Слишком много фото в заказе');
  const photo: PhotoAsset = { id: `local_photo_${newId()}`, phase, kind: input.kind, zone: input.zone.trim(), mimeType: mime, dataUrl: input.dataUrl, createdAt: now };
  return { order: { ...order, photos: [...order.photos, photo] }, photo };
}

export function localStartWork(order: WorkOrder, now: string): WorkOrder {
  if (order.status !== 'APPROVED' || !order.assignment || !order.currentEstimateVersionId) {
    throw conflict('invalid_order_state', 'Нужны согласованная смета и назначенный мастер');
  }
  if (order.work) throw conflict('work_already_started', 'Работы уже начаты');
  const estimate = order.estimateVersions.find((version) => version.id === order.currentEstimateVersionId);
  if (!estimate?.lines.length) throw conflict('estimate_empty', 'В согласованной смете нет операций');
  return {
    ...order,
    status: 'IN_PROGRESS',
    work: {
      status: 'ACTIVE', pauseNote: null, startedAt: now, updatedAt: now, completedAt: null,
      // Same ids the server derives from the estimate lines.
      operations: estimate.lines.map((line) => ({
        id: `work_operation_${line.id}`, source: 'estimate' as const, name: line.name, amountMinor: line.amountMinor, status: 'PENDING' as const, note: null, updatedAt: now
      }))
    }
  };
}

function activeWork(order: WorkOrder, message: string) {
  if (order.status !== 'IN_PROGRESS' || order.work?.status !== 'ACTIVE') throw conflict('invalid_order_state', message);
  return order.work;
}

export function localUpdateOperation(order: WorkOrder, operationId: string, status: 'PENDING' | 'DONE' | 'BLOCKED', note: string, now: string): WorkOrder {
  const work = activeWork(order, 'Операции доступны только во время работ');
  if (!work.operations.some((operation) => operation.id === operationId)) throw new ApiRequestError('Операция не найдена', 404, 'not_found');
  return { ...order, work: { ...work, updatedAt: now, operations: work.operations.map((operation) => operation.id === operationId ? { ...operation, status, note: note.trim() || null, updatedAt: now } : operation) } };
}

export function localSetPause(order: WorkOrder, paused: boolean, note: string, now: string): WorkOrder {
  if (paused && (note.trim().length < 3 || note.trim().length > 500)) throw invalid('Укажите причину паузы');
  const expected = paused ? 'ACTIVE' : 'PAUSED';
  if (order.status !== 'IN_PROGRESS' || order.work?.status !== expected) {
    throw conflict('invalid_order_state', paused ? 'Работы нельзя поставить на паузу' : 'Работы не находятся на паузе');
  }
  return { ...order, work: { ...order.work, status: paused ? 'PAUSED' : 'ACTIVE', pauseNote: paused ? note.trim() : null, updatedAt: now } };
}

export function localCompleteWork(order: WorkOrder, now: string, qualityControlEnabled = false): WorkOrder {
  const work = activeWork(order, 'Активные работы не найдены');
  if (work.operations.some((operation) => operation.status !== 'DONE')) throw conflict('operations_incomplete', 'Завершите все согласованные операции');
  return { ...order, status: qualityControlEnabled ? 'QC' : 'READY', work: { ...work, status: 'COMPLETED', completedAt: now, updatedAt: now } };
}

/** A new intake started from a confirmed booking; `id` is chosen on the phone (order_<uuid>). */
export function localCreateOrder(booking: { id: string; customerId: string; vehicleId: string; status: string }, id: string, now: string): WorkOrder {
  if (booking.status !== 'CONFIRMED') throw new ApiRequestError('Подтверждённая запись не найдена', 404, 'booking_not_found');
  return {
    id, createdAt: now, bookingId: booking.id, customerId: booking.customerId, vehicleId: booking.vehicleId, status: 'INTAKE',
    currentEstimateVersionId: null, photos: [], intake: null, estimateVersions: [], approval: null, assignment: null, work: null,
    qualityControl: [], handover: null, auditTrail: [], documents: []
  };
}

type LineInput = { sourceType: 'service' | 'package' | 'recommendation' | 'custom'; sourceId?: string | null; name: string; amountMinor: number; durationMinutes: number; reason?: string | null };

/** A new estimate version; its id and line ids are chosen on the phone so approval and work can refer to them. */
export function localCreateEstimate(order: WorkOrder, lines: Array<LineInput & { id: string }>, id: string, now: string) {
  if (order.status !== 'ESTIMATE_DRAFT') throw conflict('invalid_order_state', 'Сначала завершите приёмку');
  const valid = (line: LineInput) => ['service', 'package', 'recommendation', 'custom'].includes(line.sourceType) && line.name.trim() &&
    Number.isInteger(line.amountMinor) && line.amountMinor >= 0 && Number.isInteger(line.durationMinutes) && line.durationMinutes >= 0;
  if (!lines.length || lines.length > 30 || !lines.every(valid)) throw invalid('Проверьте строки сметы');
  const estimate = {
    id, orderId: order.id, version: Math.max(0, ...order.estimateVersions.map((item) => item.version)) + 1,
    totalAmountMinor: lines.reduce((sum, line) => sum + line.amountMinor, 0),
    totalDurationMinutes: lines.reduce((sum, line) => sum + line.durationMinutes, 0),
    createdAt: now,
    lines: lines.map((line) => ({ ...line, name: line.name.trim(), sourceId: line.sourceId ?? null, reason: line.reason?.trim() || null }))
  };
  return { order: { ...order, currentEstimateVersionId: id, estimateVersions: [...order.estimateVersions, estimate] }, estimate };
}

export function localDecideEstimate(order: WorkOrder, input: { estimateVersionId: string; decision: 'APPROVED' | 'REJECTED'; method: 'in_person' | 'phone' | 'messenger'; source: string; responsible: string }, now: string): WorkOrder {
  if (!input.source.trim() || !input.responsible.trim()) throw invalid('Укажите, кто зафиксировал решение');
  if (order.currentEstimateVersionId !== input.estimateVersionId) throw conflict('stale_estimate', 'Можно согласовать только актуальную версию сметы');
  if (order.approval?.estimateVersionId === input.estimateVersionId) throw conflict('estimate_already_decided', 'Решение по этой версии уже сохранено');
  return {
    ...order,
    status: input.decision === 'APPROVED' ? 'APPROVED' : 'ESTIMATE_DRAFT',
    approval: { estimateVersionId: input.estimateVersionId, decision: input.decision, method: input.method, source: input.source.trim(), responsible: input.responsible.trim(), decidedAt: now }
  };
}

export function localAssignMaster(order: WorkOrder, master: { id: string; displayName: string }, now: string): WorkOrder {
  if (order.status !== 'APPROVED') throw conflict('invalid_order_state', 'Мастера можно назначить после согласования сметы');
  return { ...order, assignment: { masterName: master.displayName, memberId: master.id, assignedAt: now } };
}

export function localCloseOrder(order: WorkOrder, input: { responsible: string; note: string; customerAccepted: boolean; completenessChecked: boolean }, now: string): WorkOrder {
  if (input.responsible.trim().length < 2 || input.note.trim().length < 2) throw invalid('Укажите ответственного и комментарий');
  if (order.status !== 'READY') throw conflict('invalid_order_state', 'Заказ не готов к выдаче');
  if (!order.photos.some((photo) => photo.phase === 'intake') || !order.photos.some((photo) => photo.phase === 'result')) {
    throw conflict('handover_photos_required', 'Добавьте фото автомобиля до и после работ');
  }
  if (!input.customerAccepted || !input.completenessChecked) throw invalid('Подтвердите осмотр и комплектность');
  return { ...order, status: 'CLOSED', handover: { responsible: input.responsible.trim(), note: input.note.trim(), handedOverAt: now } };
}
