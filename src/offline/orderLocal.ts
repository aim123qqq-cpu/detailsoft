import { ApiRequestError } from '../apiError.ts';
import type { IntakeFinding, OrderRecommendation, PhotoAsset, WorkOrder } from '../types';

/**
 * Order changes applied on the phone while the server is out of reach. Each mirrors the server rule
 * (server/repository.mjs) so the employee sees the same refusals offline; the server re-checks
 * everything when the queue is sent and its answer replaces this local copy.
 */
const conflict = (code: string, message: string) => new ApiRequestError(message, 409, code);
const invalid = (message: string) => new ApiRequestError(message, 422, 'validation_error');

export function localSaveIntake(order: WorkOrder, input: { conditionSummary: string; findings: IntakeFinding[]; recommendations: OrderRecommendation[] }, now: string, newId: () => string): WorkOrder {
  if (order.status === 'APPROVED') throw conflict('invalid_order_state', 'Согласованный заказ нельзя вернуть к приёмке');
  if (input.conditionSummary.trim().length < 3) throw invalid('Опишите состояние автомобиля');
  return {
    ...order,
    status: 'ESTIMATE_DRAFT',
    intake: {
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
